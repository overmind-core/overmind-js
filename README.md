# @overmind-lab/trace-sdk

JavaScript/TypeScript SDK for [Overmind](https://overmindlab.ai) — automatic LLM observability powered by OpenTelemetry.

Instrument your OpenAI calls with a single `initTracing()` call. Traces are exported to the Overmind platform with zero changes to your existing AI code.

---

## Installation

```bash
bun add @overmind-lab/trace-sdk openai
# or
npm install @overmind-lab/trace-sdk openai
```

---

## Quick Start with OpenAI

```ts
import { OpenAI } from "openai";
import { OvermindClient } from "@overmind-lab/trace-sdk";

// 1. Create the client
const overmindClient = new OvermindClient({
  apiKey: process.env.OVERMIND_API_KEY!,
  appName: "my fintech app",
});

// 2. Initialize tracing — must be called before any OpenAI calls
overmindClient.initTracing({
  enableBatching: false,
  enabledProviders: { openai: OpenAI }, // this is important to patch the correct client
  instrumentations: [],
});

// 3. Use OpenAI as normal — all calls are automatically traced
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const response = await openai.chat.completions.create({
  model: "gpt-5-mini",
  messages: [{ role: "user", content: "Hello, how are you?" }],
});
```

Traces are sent automatically to `https://api.overmindlab.ai` and will appear in your Overmind dashboard.

---

## Configuration

### `OvermindClient(config)`

| Option | Type | Required | Description |
|---|---|---|---|
| `apiKey` | `string` | Yes | Your Overmind API key. Falls back to `OVERMIND_API_KEY` env var. |
| `appName` | `string` | No | Name of your service, shown in the dashboard. Defaults to `"overmind-js"`. |
| `baseUrl` | `string` | No | Override the Overmind ingest endpoint. Defaults to `OVERMIND_TRACES_URL` env var or `https://api.overmindlab.ai`. |

### `initTracing(options)`

| Option | Type | Required | Description |
|---|---|---|---|
| `enabledProviders` | `{ openai?: typeof OpenAI }` | Yes | Pass the imported provider class to monkey-patch. e.g. `{ openai: OpenAI }` where `OpenAI` is imported from `"openai"`. |
| `enableBatching` | `boolean` | Yes | `true` to batch spans before export (recommended for production), `false` to export immediately. |
| `instrumentations` | `Instrumentation[]` | No | Additional OpenTelemetry instrumentations to register. |
| `spanProcessors` | `SpanProcessor[]` | No | Additional span processors (e.g. custom exporters). |

---

## Environment Variables

| Variable | Description |
|---|---|
| `OVERMIND_API_KEY` | Your Overmind API key |
| `OVERMIND_TRACES_URL` | Override the traces ingest base URL |
| `DEPLOYMENT_ENVIRONMENT` | Tag traces with an environment (e.g. `production`, `staging`). Defaults to `development`. |
| `OPENAI_API_KEY` | Your OpenAI API key |

---

## What Gets Traced

When `enabledProviders: { openai: OpenAI }` is set, the SDK automatically captures:

- Prompts and completions
- Model name, temperature, top-p, max tokens
- Token usage
- Latency per request
- Errors and exceptions

All data is attached to OpenTelemetry spans and exported to Overmind.

---

## Production Recommendations

Enable batching in production to reduce network overhead:

```ts
overmindClient.initTracing({
  enableBatching: true, // buffer spans and flush in batches
  enabledProviders: { openai: OpenAI },
});
```

Use `enableBatching: false` during local development to see traces immediately.

---

## Resource Attributes

Every trace is tagged with the following attributes automatically:

| Attribute | Value |
|---|---|
| `service.name` | Value of `appName` |
| `service.version` | SDK version |
| `deployment.environment` | `DEPLOYMENT_ENVIRONMENT` env var or `"development"` |
| `overmind.sdk.name` | `overmind-js` |
| `overmind.sdk.version` | SDK version |
