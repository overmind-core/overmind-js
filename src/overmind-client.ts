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

import type { OpenAI } from "openai";

import { name, version } from "../package.json";
import { OpenAIInstrumentation } from "./instrumentation-openai";

type OvermindClientConfig = {
  apiKey: string;
  baseUrl?: string;
  appName?: string;
};

export class OvermindClient {
  public readonly appName: string;
  private version: string = version;
  private baseUrl: string;
  private apiKey: string;
  private sdk?: NodeSDK;
  public experimentSlug?: string;

  constructor(config: OvermindClientConfig) {
    this.baseUrl =
      config.baseUrl || process.env.OVERMIND_TRACES_URL || "https://api.overmindlab.ai";

    this.apiKey = config.apiKey || process.env.OVERMIND_API_KEY!;

    this.appName = config.appName || "overmind-js";
    if (!this.apiKey) {
      throw new Error("OVERMIND_API_KEY is not set");
    }
    if (!this.baseUrl) {
      throw new Error("OVERMIND_TRACES_URL is not set");
    }
  }

  initTracing({
    instrumentations = [],
    spanProcessors = [],
    ...config
  }: {
    instrumentations?: Instrumentation[];
    spanProcessors?: SpanProcessor[];
    enableBatching: boolean;
    enabledProviders: { openai: OpenAI };
  }) {
    const traceExporter = this.baseUrl
      ? new OTLPTraceExporter({
          headers: {
            "X-API-TOKEN": this.apiKey,
          },
          url: `${this.baseUrl}/api/v1/traces/create`,
        })
      : new ConsoleSpanExporter();

    const spanProcessor = config.enableBatching
      ? new BatchSpanProcessor(traceExporter)
      : new SimpleSpanProcessor(traceExporter);

    spanProcessors.push(spanProcessor);

    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: this.appName,
      [ATTR_SERVICE_VERSION]: this.version,
      "deployment.environment": process.env.DEPLOYMENT_ENVIRONMENT || "development",
      "overmind.sdk.name": name,
      "overmind.sdk.version": this.version,
    });

    if (config.enabledProviders.openai) {
      const openaiInstrumentation = new OpenAIInstrumentation({
        enabled: true,
      });
      openaiInstrumentation.manuallyInstrument(config.enabledProviders.openai);
      instrumentations.push(openaiInstrumentation);
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
