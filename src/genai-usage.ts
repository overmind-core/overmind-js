/**
 * Canonical `genai.*` usage + cost derivation.
 *
 * The Overmind server rolls token usage and cost onto an Agent from the
 * canonical `genai.prompt_tokens` / `genai.completion_tokens` /
 * `genai.total_tokens` / `genai.cost` span attributes. Third-party OTel
 * auto-instrumentors (OpenAI / Anthropic / Bedrock / Google) instead emit the
 * OTel GenAI semconv keys (`gen_ai.usage.*`) or the traceloop
 * `llm.usage.total_tokens` variant — none of which the server reads.
 *
 * `canonicalUsageUpdates` bridges the gap: given a span's existing attributes
 * it returns ONLY the canonical `genai.*` keys that are derivable but not
 * already present. It never zero-fills — a token count we don't have is
 * omitted, and cost is omitted when it can't be derived — so the server never
 * records a misleading `0`.
 */

import type { Attributes, AttributeValue } from "@opentelemetry/api";

import * as attrs from "./attrs";

// Every attribute key that may carry a given token count, in priority order.
// Covers the canonical short form, the `genai.usage.*` alias, the OTel semconv
// (`gen_ai.usage.prompt_tokens` / `…input_tokens`), and the traceloop
// `llm.usage.*` variant.
const PROMPT_TOKEN_KEYS = [
  attrs.LLM_PROMPT_TOKENS,
  attrs.LLM_USAGE_PROMPT_TOKENS,
  "gen_ai.usage.prompt_tokens",
  "gen_ai.usage.input_tokens",
  "llm.usage.prompt_tokens",
] as const;
const COMPLETION_TOKEN_KEYS = [
  attrs.LLM_COMPLETION_TOKENS,
  attrs.LLM_USAGE_COMPLETION_TOKENS,
  "gen_ai.usage.completion_tokens",
  "gen_ai.usage.output_tokens",
  "llm.usage.completion_tokens",
] as const;
const TOTAL_TOKEN_KEYS = [
  attrs.LLM_TOTAL_TOKENS,
  attrs.LLM_USAGE_TOTAL_TOKENS,
  "gen_ai.usage.total_tokens",
  "llm.usage.total_tokens",
] as const;
const CACHE_READ_TOKEN_KEYS = [
  attrs.LLM_CACHE_READ_TOKENS,
  "gen_ai.usage.cache_read_input_tokens",
  "gen_ai.usage.cache_read_tokens",
] as const;
const MODEL_KEYS = [attrs.LLM_MODEL, "gen_ai.request.model", "gen_ai.response.model"] as const;
const RESPONSE_MODEL_KEYS = [attrs.LLM_RESPONSE_MODEL, "gen_ai.response.model"] as const;
const PROVIDER_KEYS = [attrs.LLM_PROVIDER, "gen_ai.system"] as const;
const TEMPERATURE_KEYS = [attrs.LLM_REQUEST_TEMPERATURE, "gen_ai.request.temperature"] as const;
const MAX_TOKENS_KEYS = [attrs.LLM_REQUEST_MAX_TOKENS, "gen_ai.request.max_tokens"] as const;
const TOP_P_KEYS = [attrs.LLM_REQUEST_TOP_P, "gen_ai.request.top_p"] as const;
const COST_KEYS = [attrs.LLM_COST, "gen_ai.usage.cost"] as const;

// Provider cost is billed per 1M tokens: [input, output] in USD. Matched by
// substring (most-specific keys first) so dated model ids (e.g.
// `gpt-4o-2024-08-06`) still resolve. Best-effort — unknown models yield a
// null cost so we never stamp a misleading `0`.
//
// ponytail: static pricing table (goes stale as vendors reprice / ship models).
// Upgrade path: swap for a maintained pricing package or a fetched price feed.
const PRICING_PER_MTOK: Record<string, [number, number]> = {
  "claude-3-5-haiku": [0.8, 4],
  "claude-3-5-sonnet": [3, 15],
  "claude-3-7-sonnet": [3, 15],
  "claude-3-haiku": [0.25, 1.25],
  "claude-3-opus": [15, 75],
  "claude-opus-4": [15, 75],
  "claude-sonnet-4": [3, 15],
  "gemini-1.5-flash": [0.075, 0.3],
  "gemini-1.5-pro": [1.25, 5],
  "gemini-2.0-flash": [0.1, 0.4],
  "gemini-2.5-flash": [0.3, 2.5],
  "gemini-2.5-pro": [1.25, 10],
  "gpt-3.5-turbo": [0.5, 1.5],
  "gpt-4": [30, 60],
  "gpt-4-turbo": [10, 30],
  "gpt-4.1": [2, 8],
  "gpt-4.1-mini": [0.4, 1.6],
  "gpt-4.1-nano": [0.1, 0.4],
  "gpt-4o": [2.5, 10],
  "gpt-4o-mini": [0.15, 0.6],
  o1: [15, 60],
  "o1-mini": [1.1, 4.4],
  o3: [2, 8],
  "o3-mini": [1.1, 4.4],
  "o4-mini": [1.1, 4.4],
};
// Longest keys first so `gpt-4o-mini` wins over `gpt-4o`, etc.
const PRICING_KEYS = Object.keys(PRICING_PER_MTOK).sort((a, b) => b.length - a.length);

function firstPositiveInt(attributes: Attributes, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const raw = attributes[key];
    if (raw === undefined || raw === null) continue;
    const value = Math.trunc(Number(raw));
    if (Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

function firstFiniteNumber(attributes: Attributes, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const raw = attributes[key];
    if (raw === undefined || raw === null) continue;
    const value = Number(raw);
    if (Number.isFinite(value)) return value;
  }
  return undefined;
}

function firstString(attributes: Attributes, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = attributes[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

/**
 * Best-effort USD cost from the built-in pricing table, or `null` when the
 * model is unknown or no tokens are available. Never returns `0`.
 */
export function computeCost(
  model: string | undefined,
  promptTokens: number | undefined,
  completionTokens: number | undefined
): number | null {
  if (!model || !(promptTokens || completionTokens)) return null;
  const normalized = model.toLowerCase();
  const key = PRICING_KEYS.find((candidate) => normalized.includes(candidate));
  if (!key) return null;
  const [inputPerMtok, outputPerMtok] = PRICING_PER_MTOK[key];
  const total =
    ((promptTokens ?? 0) * inputPerMtok + (completionTokens ?? 0) * outputPerMtok) / 1_000_000;
  if (!(total > 0)) return null;
  return Math.round(total * 1e8) / 1e8;
}

/**
 * True when *attributes* look like an LLM / generation span (either our own
 * canonical keys or a third-party auto-instrumentor's `gen_ai.*` / `llm.*`).
 */
export function isLlmSpan(attributes: Attributes): boolean {
  return (
    firstString(attributes, MODEL_KEYS) !== undefined ||
    firstString(attributes, PROVIDER_KEYS) !== undefined ||
    firstPositiveInt(attributes, PROMPT_TOKEN_KEYS) !== undefined ||
    firstPositiveInt(attributes, COMPLETION_TOKEN_KEYS) !== undefined ||
    firstPositiveInt(attributes, TOTAL_TOKEN_KEYS) !== undefined ||
    "llm.request.type" in attributes
  );
}

function countIndexed(attributes: Attributes, prefix: string, suffix: string): number {
  let count = 0;
  while (`${prefix}.${count}.${suffix}` in attributes) count += 1;
  return count;
}

function sumContentChars(attributes: Attributes, prefix: string): number {
  let total = 0;
  let index = 0;
  while (`${prefix}.${index}.content` in attributes) {
    const value = attributes[`${prefix}.${index}.content`];
    if (typeof value === "string") total += value.length;
    index += 1;
  }
  return total;
}

/**
 * Return canonical `genai.*` (+ `overmind.span.type`) keys derivable from
 * *attributes* but missing. Never zero-fills. Already-canonical keys are left
 * untouched so an explicit value (e.g. a provider-reported cost or a value
 * stamped by our own instrumentation) always wins.
 */
export function canonicalUsageUpdates(
  attributes: Attributes,
  durationSeconds?: number
): Attributes {
  if (!isLlmSpan(attributes)) return {};

  const updates: Record<string, AttributeValue> = {};
  const setIfAbsent = (key: string, value: AttributeValue | undefined) => {
    if (value === undefined) return;
    if (key in attributes) return;
    updates[key] = value;
  };

  if (!(attrs.SPAN_TYPE in attributes)) {
    updates[attrs.SPAN_TYPE] = attrs.SpanTypeValues.LLM;
  }

  const promptTokens = firstPositiveInt(attributes, PROMPT_TOKEN_KEYS);
  const completionTokens = firstPositiveInt(attributes, COMPLETION_TOKEN_KEYS);
  let totalTokens = firstPositiveInt(attributes, TOTAL_TOKEN_KEYS);
  if (totalTokens === undefined && (promptTokens || completionTokens)) {
    totalTokens = (promptTokens ?? 0) + (completionTokens ?? 0);
  }
  setIfAbsent(attrs.LLM_PROMPT_TOKENS, promptTokens);
  setIfAbsent(attrs.LLM_COMPLETION_TOKENS, completionTokens);
  setIfAbsent(attrs.LLM_TOTAL_TOKENS, totalTokens);
  setIfAbsent(attrs.LLM_CACHE_READ_TOKENS, firstPositiveInt(attributes, CACHE_READ_TOKEN_KEYS));

  const model = firstString(attributes, MODEL_KEYS);
  setIfAbsent(attrs.LLM_MODEL, model);
  setIfAbsent(attrs.LLM_RESPONSE_MODEL, firstString(attributes, RESPONSE_MODEL_KEYS));
  setIfAbsent(attrs.LLM_PROVIDER, firstString(attributes, PROVIDER_KEYS));

  // Cost: prefer a provider-reported value, else compute from pricing.
  if (!(attrs.LLM_COST in attributes)) {
    const reported = firstFiniteNumber(attributes, COST_KEYS);
    const cost =
      reported && reported > 0 ? reported : computeCost(model, promptTokens, completionTokens);
    if (cost !== null && cost !== undefined && cost > 0) updates[attrs.LLM_COST] = cost;
  }

  // Request params.
  setIfAbsent(attrs.LLM_REQUEST_TEMPERATURE, firstFiniteNumber(attributes, TEMPERATURE_KEYS));
  setIfAbsent(attrs.LLM_REQUEST_MAX_TOKENS, firstPositiveInt(attributes, MAX_TOKENS_KEYS));
  setIfAbsent(attrs.LLM_REQUEST_TOP_P, firstFiniteNumber(attributes, TOP_P_KEYS));

  // Request shape (derived from the auto-instrumentor's prompt attributes).
  const messageCount = countIndexed(attributes, "gen_ai.prompt", "role");
  if (messageCount > 0) setIfAbsent(attrs.LLM_REQUEST_MESSAGE_COUNT, messageCount);
  const messageChars = sumContentChars(attributes, "gen_ai.prompt");
  if (messageChars > 0) setIfAbsent(attrs.LLM_REQUEST_MESSAGE_CHARS, messageChars);
  const toolCount = countIndexed(attributes, "llm.request.functions", "name");
  if (toolCount > 0) setIfAbsent(attrs.LLM_REQUEST_TOOL_COUNT, toolCount);

  // Response shape.
  const finishReason = attributes["gen_ai.completion.0.finish_reason"];
  if (typeof finishReason === "string" && finishReason) {
    setIfAbsent(attrs.LLM_RESPONSE_FINISH_REASON, finishReason);
  }
  const responseChars = sumContentChars(attributes, "gen_ai.completion");
  if (responseChars > 0) setIfAbsent(attrs.LLM_RESPONSE_MESSAGE_CHARS, responseChars);

  if (durationSeconds !== undefined && durationSeconds >= 0) {
    setIfAbsent(attrs.LLM_ELAPSED_SECONDS, Math.round(durationSeconds * 1000) / 1000);
  }

  return updates;
}
