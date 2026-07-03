/**
 * Canonical span attribute keys emitted by the Overmind JS SDK.
 *
 * Mirrors the subset of `overmind/attrs.py` that the Overmind server reads
 * (see `overbae/api/overmind_attrs.py`) plus the depth attributes defined in
 * the canonical contract (`overmind/docs/tracing-attributes.md`).
 *
 * Token usage and cost use the `genai.*` keys (NOT the OTel semconv
 * `gen_ai.*`). Third-party auto-instrumentors emit the `gen_ai.*` / traceloop
 * `llm.usage.*` keys; the enrichment span processor mirrors those onto these
 * canonical keys. Keys we own live under `overmind.*` / `genai.*` / `tool.*`.
 */

// --- Resource / identity ---------------------------------------------------
export const SDK_NAME = "overmind.sdk.name";
export const SDK_VERSION = "overmind.sdk.version";
export const AGENT_ID = "overmind.agent.id";
export const AGENT_NAME = "overmind.agent.name";
export const PROJECT_ID = "overmind.project.id";
export const CONVERSATION_ID = "conversation.id";

// --- Common span attributes ------------------------------------------------
export const SPAN_TYPE = "overmind.span.type";
export const STATUS = "overmind.status";
export const DURATION_SECONDS = "overmind.duration.seconds";
export const ERROR_TYPE = "overmind.error.type";
export const ERROR_MESSAGE = "overmind.error.message";
export const INPUTS = "inputs";
export const OUTPUTS = "outputs";

// --- LLM / generation span (canonical genai.*) -----------------------------
export const LLM_MODEL = "genai.model";
export const LLM_RESPONSE_MODEL = "genai.response.model";
export const LLM_PROVIDER = "genai.provider";
export const LLM_PROMPT_TOKENS = "genai.prompt_tokens";
export const LLM_COMPLETION_TOKENS = "genai.completion_tokens";
export const LLM_TOTAL_TOKENS = "genai.total_tokens";
export const LLM_CACHE_READ_TOKENS = "genai.cache_read_tokens";
export const LLM_COST = "genai.cost";
export const LLM_ELAPSED_SECONDS = "genai.elapsed_seconds";
export const LLM_ERROR = "genai.error";
export const LLM_REQUEST_MESSAGE_COUNT = "genai.request.message_count";
export const LLM_REQUEST_MESSAGE_CHARS = "genai.request.message_chars";
export const LLM_REQUEST_TOOL_COUNT = "genai.request.tool_count";
export const LLM_REQUEST_TEMPERATURE = "genai.request.temperature";
export const LLM_REQUEST_MAX_TOKENS = "genai.request.max_tokens";
export const LLM_REQUEST_TOP_P = "genai.request.top_p";
export const LLM_RESPONSE_MESSAGE_CHARS = "genai.response.message_chars";
export const LLM_RESPONSE_FINISH_REASON = "genai.response.finish_reason";
export const LLM_STREAMING = "genai.streaming";
export const LLM_TTFT_SECONDS = "genai.time_to_first_token_seconds";

// `genai.usage.*` aliases the server also accepts for tokens.
export const LLM_USAGE_PROMPT_TOKENS = "genai.usage.prompt_tokens";
export const LLM_USAGE_COMPLETION_TOKENS = "genai.usage.completion_tokens";
export const LLM_USAGE_TOTAL_TOKENS = "genai.usage.total_tokens";

// --- Tool-call span --------------------------------------------------------
export const TOOL_NAME = "tool.name";
export const TOOL_ARG_KEYS = "tool.arg_keys";
export const TOOL_ERROR = "tool.error";

// --- Retrieval / RAG span --------------------------------------------------
export const RETRIEVAL_QUERY_CHARS = "overmind.retrieval.query_chars";
export const RETRIEVAL_RESULT_COUNT = "overmind.retrieval.result_count";

/** Canonical span-type values (`overmind.span.type`). */
export const SpanTypeValues = {
  ENTRY_POINT: "entry_point",
  FUNCTION: "function",
  LLM: "llm_call",
  RETRIEVAL: "retrieval",
  TOOL: "tool_call",
  WORKFLOW: "workflow",
} as const;
