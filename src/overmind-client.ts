import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import type { Instrumentation } from "@opentelemetry/instrumentation";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { ConsoleSpanExporter } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

import * as Anthropic from "@anthropic-ai/sdk";
import * as Bedrock from "@aws-sdk/client-bedrock-runtime";
import type * as GoogleGenAI from "@google/genai";
import { AnthropicInstrumentation } from "@traceloop/instrumentation-anthropic";
import { BedrockInstrumentation } from "@traceloop/instrumentation-bedrock";
import type { OpenAI } from "openai";

import { version } from "../package.json";
import * as attrs from "./attrs";
import { identityResourceAttributes, seedIdentity } from "./identity";
import { GoogleGenAIInstrumentation } from "./instrumentation-google-genai";
import { OpenAIInstrumentation } from "./instrumentation-openai";
import { OvermindSpanProcessor } from "./span-processors";

const SDK_NAME = "overmind-js";

type OvermindClientConfig = {
  apiKey: string;
  baseUrl?: string;
  appName?: string;
  /**
   * Agent server UUID. Stamped as `overmind.agent.id` on the resource and every
   * span; resolved by a direct primary-key lookup (drift-proof). Falls back to
   * `OVERMIND_AGENT_ID`. Prefer this over `agentName` when known.
   */
  agentId?: string;
  /**
   * Human-readable agent name. Stamped as `overmind.agent.name`; the server
   * slugifies it for a stable identity, so keep it constant. Falls back to
   * `OVERMIND_AGENT_NAME`.
   */
  agentName?: string;
  /** Project UUID (`overmind.project.id`). Falls back to `OVERMIND_PROJECT_ID`. */
  projectId?: string;
};

const LOCAL_API_KEY_PREFIX = "ovr_core_";
const LOCAL_BASE_URL = "http://localhost:8000";
const DEFAULT_BASE_URL = "https://api.overmindlab.ai";

export class OvermindClient {
  public readonly appName: string;
  private version: string = version;
  private baseUrl: string;
  private apiKey: string;
  private sdk?: NodeSDK;
  private identityConfig: { agentId?: string; agentName?: string; projectId?: string };
  public experimentSlug?: string;

  constructor(config: OvermindClientConfig) {
    // biome-ignore lint/style/noNonNullAssertion: must always set api key
    this.apiKey = config.apiKey || process.env.OVERMIND_API_KEY!;
    this.identityConfig = {
      agentId: config.agentId,
      agentName: config.agentName,
      projectId: config.projectId,
    };

    this.baseUrl =
      config.baseUrl ||
      process.env.OVERMIND_API_URL ||
      process.env.OVERMIND_TRACES_URL ||
      this.apiKey.startsWith(LOCAL_API_KEY_PREFIX)
        ? LOCAL_BASE_URL
        : DEFAULT_BASE_URL;

    this.appName = config.appName || "overmind-js";
    if (!this.apiKey) {
      throw new Error("OVERMIND_API_KEY is not set");
    }
    if (!this.baseUrl) {
      throw new Error("OVERMIND_API_URL is not set");
    }
  }

  initTracing({
    instrumentations = [],
    spanProcessors = [],
    enableBatching = true,
    enabledProviders = {},
  }: {
    instrumentations?: Instrumentation[];
    spanProcessors?: SpanProcessor[];
    enableBatching?: boolean;
    enabledProviders?: Partial<{
      openai: typeof OpenAI;
      anthropic: typeof Anthropic;
      bedrock: typeof Bedrock;
      googleGenAI: typeof GoogleGenAI;
    }>;
  }) {
    const traceExporter = this.baseUrl
      ? new OTLPTraceExporter({
          headers: { "X-API-TOKEN": this.apiKey },
          url: `${this.baseUrl}/api/v1/traces`,
        })
      : new ConsoleSpanExporter();

    const spanProcessor = enableBatching
      ? new BatchSpanProcessor(traceExporter)
      : new SimpleSpanProcessor(traceExporter);

    // Seed identity (config + OVERMIND_AGENT_ID/NAME/PROJECT_ID env fallbacks)
    // before building the resource so both the resource and the on-start
    // processor carry the same agent/project identity.
    seedIdentity(this.identityConfig);

    // The Overmind processor stamps identity on start and mirrors auto-
    // instrumentor usage onto canonical `genai.*` keys on span end. Its
    // enrichment runs in `onEnding` (before export), so order vs. the exporter
    // processor does not matter.
    spanProcessors.unshift(new OvermindSpanProcessor());
    spanProcessors.push(spanProcessor);

    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: this.appName,
      [ATTR_SERVICE_VERSION]: this.version,
      "deployment.environment": process.env.DEPLOYMENT_ENVIRONMENT || "development",
      [attrs.SDK_NAME]: SDK_NAME,
      [attrs.SDK_VERSION]: this.version,
      ...identityResourceAttributes(),
    });

    if (enabledProviders.openai) {
      const openaiInstrumentation = new OpenAIInstrumentation({ enabled: true });
      openaiInstrumentation.manuallyInstrument(enabledProviders.openai);
      instrumentations.push(openaiInstrumentation);
    }

    if (enabledProviders.anthropic) {
      const anthropicInstrumentation = new AnthropicInstrumentation({ enabled: true });
      anthropicInstrumentation.manuallyInstrument(Anthropic);
      instrumentations.push(anthropicInstrumentation);
    }
    if (enabledProviders.bedrock) {
      const bedrockInstrumentation = new BedrockInstrumentation({ enabled: true });
      bedrockInstrumentation.manuallyInstrument(Bedrock);
      instrumentations.push(bedrockInstrumentation);
    }

    if (enabledProviders.googleGenAI) {
      const googleGenAIInstrumentation = new GoogleGenAIInstrumentation({ enabled: true });
      googleGenAIInstrumentation.manuallyInstrument(enabledProviders.googleGenAI);
      instrumentations.push(googleGenAIInstrumentation);
    }

    this.sdk = new NodeSDK({
      instrumentations: [...instrumentations],
      resource,
      spanProcessors,
    });

    this.sdk.start();
  }

  async shutdown() {
    await this.sdk?.shutdown();
  }
}
