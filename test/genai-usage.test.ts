import { describe, expect, test } from "bun:test";

import * as attrs from "../src/attrs";
import { canonicalUsageUpdates, computeCost, isLlmSpan } from "../src/genai-usage";

describe("computeCost", () => {
  test("computes USD cost from the pricing table", () => {
    // gpt-4o-mini: $0.15 / $0.60 per 1M tokens.
    const cost = computeCost("gpt-4o-mini", 1000, 500);
    expect(cost).toBeCloseTo((1000 * 0.15 + 500 * 0.6) / 1_000_000, 10);
  });

  test("matches dated model ids by substring", () => {
    expect(computeCost("gpt-4o-2024-08-06", 1000, 0)).toBeCloseTo((1000 * 2.5) / 1_000_000, 10);
  });

  test("returns null for unknown models (never zero-fills)", () => {
    expect(computeCost("totally-made-up-model", 1000, 500)).toBeNull();
  });

  test("returns null when there are no tokens", () => {
    expect(computeCost("gpt-4o", undefined, undefined)).toBeNull();
  });
});

describe("canonicalUsageUpdates", () => {
  test("mirrors gen_ai.* usage onto canonical genai.* + derives total, cost, type", () => {
    const updates = canonicalUsageUpdates({
      "gen_ai.request.model": "gpt-4o-mini",
      "gen_ai.system": "openai",
      "gen_ai.usage.completion_tokens": 50,
      "gen_ai.usage.prompt_tokens": 100,
    });
    expect(updates[attrs.LLM_PROMPT_TOKENS]).toBe(100);
    expect(updates[attrs.LLM_COMPLETION_TOKENS]).toBe(50);
    expect(updates[attrs.LLM_TOTAL_TOKENS]).toBe(150);
    expect(updates[attrs.LLM_MODEL]).toBe("gpt-4o-mini");
    expect(updates[attrs.LLM_PROVIDER]).toBe("openai");
    expect(updates[attrs.SPAN_TYPE]).toBe(attrs.SpanTypeValues.LLM);
    expect(updates[attrs.LLM_COST] as number).toBeGreaterThan(0);
  });

  test("does not overwrite already-canonical keys", () => {
    const updates = canonicalUsageUpdates({
      "gen_ai.request.model": "gpt-4o-mini",
      "gen_ai.usage.prompt_tokens": 100,
      [attrs.LLM_PROMPT_TOKENS]: 999,
      [attrs.LLM_COST]: 0.5,
    });
    expect(updates[attrs.LLM_PROMPT_TOKENS]).toBeUndefined();
    expect(updates[attrs.LLM_COST]).toBeUndefined();
  });

  test("never zero-fills a missing token count", () => {
    const updates = canonicalUsageUpdates({
      "gen_ai.request.model": "gpt-4o-mini",
      "gen_ai.usage.completion_tokens": 50,
      "gen_ai.usage.prompt_tokens": 0,
    });
    expect(updates[attrs.LLM_PROMPT_TOKENS]).toBeUndefined();
    expect(updates[attrs.LLM_COMPLETION_TOKENS]).toBe(50);
    expect(updates[attrs.LLM_TOTAL_TOKENS]).toBe(50);
  });

  test("mirrors request params, response shape, and cache-read tokens", () => {
    const updates = canonicalUsageUpdates({
      "gen_ai.completion.0.content": "hi there",
      "gen_ai.completion.0.finish_reason": "stop",
      "gen_ai.prompt.0.content": "hello",
      "gen_ai.prompt.0.role": "user",
      "gen_ai.request.max_tokens": 512,
      "gen_ai.request.model": "claude-3-5-sonnet-20241022",
      "gen_ai.request.temperature": 0.7,
      "gen_ai.request.top_p": 0.9,
      "gen_ai.system": "anthropic",
      "gen_ai.usage.cache_read_input_tokens": 20,
      "llm.request.functions.0.name": "lookup",
    });
    expect(updates[attrs.LLM_REQUEST_TEMPERATURE]).toBe(0.7);
    expect(updates[attrs.LLM_REQUEST_MAX_TOKENS]).toBe(512);
    expect(updates[attrs.LLM_REQUEST_TOP_P]).toBe(0.9);
    expect(updates[attrs.LLM_CACHE_READ_TOKENS]).toBe(20);
    expect(updates[attrs.LLM_REQUEST_MESSAGE_COUNT]).toBe(1);
    expect(updates[attrs.LLM_REQUEST_MESSAGE_CHARS]).toBe(5);
    expect(updates[attrs.LLM_REQUEST_TOOL_COUNT]).toBe(1);
    expect(updates[attrs.LLM_RESPONSE_FINISH_REASON]).toBe("stop");
    expect(updates[attrs.LLM_RESPONSE_MESSAGE_CHARS]).toBe(8);
  });

  test("stamps elapsed seconds when duration is provided", () => {
    const updates = canonicalUsageUpdates(
      { "gen_ai.request.model": "gpt-4o", "gen_ai.usage.prompt_tokens": 10 },
      1.234
    );
    expect(updates[attrs.LLM_ELAPSED_SECONDS]).toBe(1.234);
  });

  test("returns nothing for non-LLM spans", () => {
    expect(isLlmSpan({ [attrs.TOOL_NAME]: "search" })).toBe(false);
    expect(canonicalUsageUpdates({ [attrs.TOOL_NAME]: "search" })).toEqual({});
  });
});
