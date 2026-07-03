# @overmind-lab/trace-sdk

JavaScript/TypeScript SDK for [Overmind](https://overmindlab.ai) — automatic LLM observability powered by OpenTelemetry.

Instrument your AI provider calls with a single `initTracing()` call. Traces are exported to the Overmind platform with zero changes to your existing AI code.

Supported providers: **OpenAI**, **Google GenAI (Gemini)**, **Anthropic**, **AWS Bedrock**.

---

## Installation

Install the SDK alongside whichever AI provider(s) you use:

```bash
# OpenAI
bun add @overmind-lab/trace-sdk openai
npm install @overmind-lab/trace-sdk openai

# Google GenAI
bun add @overmind-lab/trace-sdk @google/genai
npm install @overmind-lab/trace-sdk @google/genai

# Anthropic
bun add @overmind-lab/trace-sdk @anthropic-ai/sdk
npm install @overmind-lab/trace-sdk @anthropic-ai/sdk
```

---

## Quick Start

### OpenAI

```ts
import { OpenAI } from "openai";
import { OvermindClient } from "@overmind-lab/trace-sdk";

const overmindClient = new OvermindClient({
  apiKey: process.env.OVERMIND_API_KEY!,
  appName: "my-app",
});

// Must be called before any OpenAI calls
overmindClient.initTracing({
  enableBatching: false,
  enabledProviders: { openai: OpenAI },
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const response = await openai.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Hello, how are you?" }],
});
```

---

### Google GenAI (Gemini)

```ts
import * as google from "@google/genai";
import { OvermindClient } from "@overmind-lab/trace-sdk";

const overmindClient = new OvermindClient({
  apiKey: process.env.OVERMIND_API_KEY!,
  appName: "my-app",
});

// Must be called before any Google GenAI calls
overmindClient.initTracing({
  enableBatching: false,
  enabledProviders: { googleGenAI: google },
});

const ai = new google.GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });

// Non-streaming
const response = await ai.models.generateContent({
  model: "gemini-2.0-flash",
  contents: "Why is the sky blue?",
});
console.log(response.text);

// Streaming
const stream = await ai.models.generateContentStream({
  model: "gemini-2.0-flash",
  contents: "Tell me a short story.",
});
for await (const chunk of stream) {
  process.stdout.write(chunk.text ?? "");
}
```

> **Note:** Pass the entire `@google/genai` module namespace (`import * as google`) as the `googleGenAI` provider, not a single class.

---

### Anthropic

```ts
import Anthropic from "@anthropic-ai/sdk";
import * as AnthropicModule from "@anthropic-ai/sdk";
import { OvermindClient } from "@overmind-lab/trace-sdk";

const overmindClient = new OvermindClient({
  apiKey: process.env.OVERMIND_API_KEY!,
  appName: "my-app",
});

// Must be called before any Anthropic calls
overmindClient.initTracing({
  enableBatching: false,
  enabledProviders: { anthropic: AnthropicModule },
});

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const message = await client.messages.create({
  model: "claude-opus-4-5",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello, Claude!" }],
});
console.log(message.content[0]);
```

---

### Multiple Providers

You can enable multiple providers in a single `initTracing()` call:

```ts
import { OpenAI } from "openai";
import * as GoogleGenAI from "@google/genai";
import * as AnthropicModule from "@anthropic-ai/sdk";
import { OvermindClient } from "@overmind-lab/trace-sdk";

const overmindClient = new OvermindClient({
  apiKey: process.env.OVERMIND_API_KEY!,
  appName: "my-app",
});

overmindClient.initTracing({
  enableBatching: true,
  enabledProviders: {
    openai: OpenAI,
    googleGenAI: GoogleGenAI,
    anthropic: AnthropicModule,
  },
});
```

---

## Configuration

### `OvermindClient(config)`

| Option | Type | Required | Description |
|---|---|---|---|
| `apiKey` | `string` | Yes | Your Overmind API key. Falls back to `OVERMIND_API_KEY` env var. |
| `appName` | `string` | No | Name of your service, shown in the dashboard. Defaults to `"overmind-js"`. |
| `baseUrl` | `string` | No | Override the Overmind ingest endpoint. Defaults to `OVERMIND_TRACES_URL` env var or `https://api.overmindlab.ai`. |
| `agentId` | `string` | No | The Agent's server UUID. Stamped as `overmind.agent.id` on the resource and every span; resolved by a direct primary-key lookup (drift-proof). Falls back to `OVERMIND_AGENT_ID`. **Prefer this over `agentName`.** |
| `agentName` | `string` | No | Human-readable agent name (`overmind.agent.name`). The server slugifies it for a stable identity, so keep it constant across runs. Falls back to `OVERMIND_AGENT_NAME`. |
| `projectId` | `string` | No | Project UUID (`overmind.project.id`). Usually inferred from the API token; only needed for session auth. Falls back to `OVERMIND_PROJECT_ID`. |

### Agent identity

Bind a trace to a specific Agent so the platform can roll token usage and cost up correctly. Pass `agentId` / `agentName` to the client, or set them at runtime:

```ts
import { setAgentId, setAgentName, setProjectId } from "@overmind-lab/trace-sdk";

setAgentId("6f1c…"); // preferred — drift-proof primary key
setAgentName("Support Triage Agent"); // slugified server-side for stable identity
setProjectId("…"); // session-auth only
```

### Manual tracing

Provider LLM calls are traced automatically. To trace your own tools, retrieval steps, and workflows with the canonical Overmind attributes, wrap them:

```ts
import { tool, retrieval, setRetrievalStats, withSpan } from "@overmind-lab/trace-sdk";

const lookupOrder = tool("lookup_order", async ({ orderId }: { orderId: string }) => {
  return await db.orders.find(orderId); // emits tool.name / tool.arg_keys (and tool.error on failure)
});

const search = retrieval("vector_search", async (query: string) => {
  const docs = await index.query(query);
  setRetrievalStats({ queryChars: query.length, resultCount: docs.length });
  return docs;
});

await withSpan("handle_ticket", async () => {
  /* spans created inside nest under this one */
}, { attributes: { "ticket.id": id } });
```

### `initTracing(options)`

| Option | Type | Required | Description |
|---|---|---|---|
| `enabledProviders` | `{ openai?, googleGenAI?, anthropic?, bedrock? }` | Yes | Pass the imported provider module to monkey-patch. See quick start examples above. |
| `enableBatching` | `boolean` | No | `true` to buffer spans and flush in batches (recommended for production). Defaults to `true`. |
| `instrumentations` | `Instrumentation[]` | No | Additional OpenTelemetry instrumentations to register. |
| `spanProcessors` | `SpanProcessor[]` | No | Additional span processors (e.g. custom exporters). |

---

## Environment Variables

| Variable | Description |
|---|---|
| `OVERMIND_API_KEY` | Your Overmind API key |
| `OVERMIND_TRACES_URL` | Override the traces ingest base URL |
| `OVERMIND_AGENT_ID` | Agent UUID fallback for `agentId` |
| `OVERMIND_AGENT_NAME` | Agent name fallback for `agentName` |
| `OVERMIND_PROJECT_ID` | Project UUID fallback for `projectId` |
| `DEPLOYMENT_ENVIRONMENT` | Tag traces with an environment (e.g. `production`, `staging`). Defaults to `development`. |
| `OPENAI_API_KEY` | Your OpenAI API key |
| `GOOGLE_API_KEY` | Your Google GenAI API key |
| `ANTHROPIC_API_KEY` | Your Anthropic API key |

---

## What Gets Traced

The SDK automatically captures the following for each provider:

### OpenAI
- Prompts (messages) and completions
- Model name, temperature, top-p, max tokens
- Token usage (prompt, completion, total)
- Streaming responses
- Function/tool calls
- Image generation (`dall-e-3`)
- Errors and latency

### Google GenAI (Gemini)
- Prompts (contents) and completions
- System instructions
- Model name, temperature, top-p, max output tokens
- Token usage (prompt, candidates, total)
- Streaming responses
- Function/tool calls
- Errors and latency

### Anthropic
- Prompts (messages) and completions
- Model name, temperature, max tokens
- Token usage (input, output)
- Streaming responses
- Tool use
- Errors and latency

---

## Production Recommendations

Enable batching in production to reduce network overhead:

```ts
overmindClient.initTracing({
  enableBatching: true,
  enabledProviders: { openai: OpenAI },
});
```

Use `enableBatching: false` during local development to see traces immediately.

---

## Resource Attributes

Every trace is automatically tagged with:

| Attribute | Value |
|---|---|
| `service.name` | Value of `appName` |
| `service.version` | SDK version |
| `deployment.environment` | `DEPLOYMENT_ENVIRONMENT` env var or `"development"` |
| `overmind.sdk.name` | `overmind-js` |
| `overmind.sdk.version` | SDK version |
| `overmind.agent.id` | Value of `agentId` (if set) |
| `overmind.agent.name` | Value of `agentName` (if set) |
| `overmind.project.id` | Value of `projectId` (if set) |

## Canonical `genai.*` attributes

On every LLM / generation span the SDK emits the canonical Overmind keys the
platform rolls up — mirrored from the underlying OTel `gen_ai.*` /
`llm.usage.*` attributes and never zero-filled (unknown values are omitted):

| Attribute | Meaning |
|---|---|
| `genai.model` / `genai.response.model` / `genai.provider` | Model + provider |
| `genai.prompt_tokens` / `genai.completion_tokens` / `genai.total_tokens` | Token usage (rolled up) |
| `genai.cost` | USD cost — provider-reported or derived from model pricing (rolled up) |
| `genai.cache_read_tokens` | Prompt-cache read tokens |
| `genai.request.temperature` / `genai.request.max_tokens` / `genai.request.top_p` | Request params |
| `genai.request.message_count` / `genai.request.message_chars` / `genai.request.tool_count` | Request shape |
| `genai.response.finish_reason` / `genai.response.message_chars` | Response shape |
| `genai.streaming` / `genai.time_to_first_token_seconds` | Streaming + TTFT |
| `genai.elapsed_seconds` | Client-measured latency |
