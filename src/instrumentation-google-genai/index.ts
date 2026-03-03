/*
 * Copyright Overmind
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { type Attributes, context, type Span, SpanKind, trace } from "@opentelemetry/api";
import {
  InstrumentationBase,
  type InstrumentationModuleDefinition,
  InstrumentationNodeModuleDefinition,
  safeExecuteInTheMiddle,
} from "@opentelemetry/instrumentation";
import {
  ATTR_GEN_AI_COMPLETION,
  ATTR_GEN_AI_PROMPT,
  ATTR_GEN_AI_REQUEST_MAX_TOKENS,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_REQUEST_TEMPERATURE,
  ATTR_GEN_AI_REQUEST_TOP_P,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_SYSTEM,
  ATTR_GEN_AI_USAGE_COMPLETION_TOKENS,
  ATTR_GEN_AI_USAGE_PROMPT_TOKENS,
} from "@opentelemetry/semantic-conventions/incubating";

import type * as googleGenAI from "@google/genai";
import type {
  Content,
  GenerateContentParameters,
  GenerateContentResponse,
  Part,
} from "@google/genai";
import {
  CONTEXT_KEY_ALLOW_TRACE_CONTENT,
  SpanAttributes,
} from "@traceloop/ai-semantic-conventions";

import { version } from "../../package.json";
import type { GoogleGenAIInstrumentationConfig } from "./types";

export class GoogleGenAIInstrumentation extends InstrumentationBase {
  protected declare _config: GoogleGenAIInstrumentationConfig;

  constructor(config: GoogleGenAIInstrumentationConfig = {}) {
    super("overmind-js/google-genai-instrumentation", version, config);
  }

  public override setConfig(config: GoogleGenAIInstrumentationConfig = {}) {
    super.setConfig(config);
  }

  public manuallyInstrument(module: unknown) {
    this._diag.debug("Manually instrumenting @google/genai");

    const googleModule = module as any;

    if (googleModule.Models?.prototype) {
      this._wrap(
        googleModule.Models.prototype,
        "generateContentInternal",
        this.patchGenerateContent()
      );
      this._wrap(
        googleModule.Models.prototype,
        "generateContentStreamInternal",
        this.patchGenerateContentStream()
      );
    }
  }

  protected init(): InstrumentationModuleDefinition {
    const module = new InstrumentationNodeModuleDefinition(
      "@google/genai",
      [">=1 <2"],
      this.patch.bind(this),
      this.unpatch.bind(this)
    );
    return module;
  }

  private patch(moduleExports: typeof googleGenAI, moduleVersion?: string) {
    this._diag.debug(`Patching @google/genai@${moduleVersion}`);

    this._wrap(
      (moduleExports.Models as any).prototype,
      "generateContentInternal",
      this.patchGenerateContent()
    );
    this._wrap(
      (moduleExports.Models as any).prototype,
      "generateContentStreamInternal",
      this.patchGenerateContentStream()
    );

    return moduleExports;
  }

  private unpatch(moduleExports: typeof googleGenAI, moduleVersion?: string): void {
    this._diag.debug(`Unpatching @google/genai@${moduleVersion}`);

    this._unwrap((moduleExports.Models as any).prototype, "generateContentInternal");
    this._unwrap((moduleExports.Models as any).prototype, "generateContentStreamInternal");
  }

  private patchGenerateContent() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const plugin = this;
    // eslint-disable-next-line
    return (original: Function) => {
      return async function method(this: any, ...args: unknown[]) {
        const params = args[0] as GenerateContentParameters & {
          extraAttributes?: Record<string, any>;
        };

        const span = plugin.startSpan({ params });
        const execContext = trace.setSpan(context.active(), span);

        const execPromise = safeExecuteInTheMiddle(
          () => {
            return context.with(execContext, () => {
              if ((params as any).extraAttributes) {
                delete (params as any).extraAttributes;
              }
              return original.apply(this, args);
            });
          },
          (e) => {
            if (e) {
              plugin._diag.error("Google GenAI instrumentation: error", e);
            }
          }
        );

        try {
          const result = (await context.bind(
            execContext,
            execPromise as any
          )) as GenerateContentResponse;
          plugin._endSpan({ result, span });
          return result;
        } catch (e) {
          span.end();
          throw e;
        }
      };
    };
  }

  private patchGenerateContentStream() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const plugin = this;
    // eslint-disable-next-line
    return (original: Function) => {
      return async function method(this: any, ...args: unknown[]) {
        const params = args[0] as GenerateContentParameters & {
          extraAttributes?: Record<string, any>;
        };

        const span = plugin.startSpan({ params });
        const execContext = trace.setSpan(context.active(), span);

        const execPromise = safeExecuteInTheMiddle(
          () => {
            return context.with(execContext, () => {
              if ((params as any).extraAttributes) {
                delete (params as any).extraAttributes;
              }
              return original.apply(this, args);
            });
          },
          (e) => {
            if (e) {
              plugin._diag.error("Google GenAI instrumentation: error", e);
            }
          }
        );

        const generator = (await context.bind(
          execContext,
          execPromise as any
        )) as AsyncGenerator<GenerateContentResponse>;

        return context.bind(execContext, plugin._wrapStreamingGenerator(generator, span));
      };
    };
  }

  private async *_wrapStreamingGenerator(
    generator: AsyncGenerator<GenerateContentResponse>,
    span: Span
  ) {
    let lastChunk: GenerateContentResponse | undefined;
    let accumulatedText = "";

    try {
      for await (const chunk of generator) {
        yield chunk;
        lastChunk = chunk;

        const chunkText =
          chunk.candidates?.[0]?.content?.parts
            ?.filter((p) => p.text)
            .map((p) => p.text)
            .join("") ?? "";
        accumulatedText += chunkText;
      }

      if (lastChunk) {
        this._endSpanStreaming({ accumulatedText, lastChunk, span });
      } else {
        span.end();
      }
    } catch (e) {
      span.end();
      throw e;
    }
  }

  private startSpan({
    params,
  }: {
    params: GenerateContentParameters & { extraAttributes?: Record<string, any> };
  }): Span {
    const attributes: Attributes = {
      [ATTR_GEN_AI_SYSTEM]: "Google",
      [SpanAttributes.LLM_REQUEST_TYPE]: "chat",
    };

    try {
      attributes[ATTR_GEN_AI_REQUEST_MODEL] = params.model;

      if (params.config?.maxOutputTokens) {
        attributes[ATTR_GEN_AI_REQUEST_MAX_TOKENS] = params.config.maxOutputTokens;
      }
      if (params.config?.temperature) {
        attributes[ATTR_GEN_AI_REQUEST_TEMPERATURE] = params.config.temperature;
      }
      if (params.config?.topP) {
        attributes[ATTR_GEN_AI_REQUEST_TOP_P] = params.config.topP;
      }
      if (params.config?.frequencyPenalty) {
        attributes[SpanAttributes.LLM_FREQUENCY_PENALTY] = params.config.frequencyPenalty;
      }
      if (params.config?.presencePenalty) {
        attributes[SpanAttributes.LLM_PRESENCE_PENALTY] = params.config.presencePenalty;
      }

      if (params.extraAttributes !== undefined && typeof params.extraAttributes === "object") {
        Object.keys(params.extraAttributes).forEach((key) => {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          attributes[key] = params.extraAttributes![key];
        });
      }

      if (this._shouldSendPrompts()) {
        const contents = normalizeContents(params.contents);
        let promptIndex = 0;

        if (params.config?.systemInstruction) {
          attributes[`${ATTR_GEN_AI_PROMPT}.${promptIndex}.role`] = "system";
          attributes[`${ATTR_GEN_AI_PROMPT}.${promptIndex}.content`] = normalizeSystemInstruction(
            params.config.systemInstruction
          );
          promptIndex++;
        }

        contents.forEach((content) => {
          attributes[`${ATTR_GEN_AI_PROMPT}.${promptIndex}.role`] = content.role ?? "user";
          attributes[`${ATTR_GEN_AI_PROMPT}.${promptIndex}.content`] = extractPartsText(
            content.parts ?? []
          );
          promptIndex++;
        });

        (params.config?.tools as any[])?.forEach((tool: any, toolIndex: number) => {
          if (tool.functionDeclarations) {
            (tool.functionDeclarations as any[]).forEach((func: any, funcIndex: number) => {
              const attrIndex = toolIndex * 100 + funcIndex;
              const attrBase = `${SpanAttributes.LLM_REQUEST_FUNCTIONS}.${attrIndex}`;
              attributes[`${attrBase}.name`] = func.name;
              if (func.description) {
                attributes[`${attrBase}.description`] = func.description;
              }
              if (func.parameters) {
                attributes[`${attrBase}.arguments`] = JSON.stringify(func.parameters);
              }
            });
          }
        });
      }
    } catch (e) {
      this._diag.debug(String(e));
      this._config.exceptionLogger?.(e);
    }

    return this.tracer.startSpan("google_genai.generate_content", {
      attributes,
      kind: SpanKind.CLIENT,
    });
  }

  private _endSpan({ span, result }: { span: Span; result: GenerateContentResponse }) {
    try {
      if (result.modelVersion) {
        span.setAttribute(ATTR_GEN_AI_RESPONSE_MODEL, result.modelVersion);
      }

      if (result.usageMetadata) {
        if (result.usageMetadata.totalTokenCount !== undefined) {
          span.setAttribute(
            SpanAttributes.LLM_USAGE_TOTAL_TOKENS,
            result.usageMetadata.totalTokenCount
          );
        }
        if (result.usageMetadata.promptTokenCount !== undefined) {
          span.setAttribute(ATTR_GEN_AI_USAGE_PROMPT_TOKENS, result.usageMetadata.promptTokenCount);
        }
        if (result.usageMetadata.candidatesTokenCount !== undefined) {
          span.setAttribute(
            ATTR_GEN_AI_USAGE_COMPLETION_TOKENS,
            result.usageMetadata.candidatesTokenCount
          );
        }
      }

      if (this._shouldSendPrompts()) {
        result.candidates?.forEach((candidate, index) => {
          span.setAttribute(
            `${ATTR_GEN_AI_COMPLETION}.${index}.finish_reason`,
            candidate.finishReason ?? "stop"
          );
          span.setAttribute(`${ATTR_GEN_AI_COMPLETION}.${index}.role`, "model");

          const parts = candidate.content?.parts ?? [];
          const text = parts
            .filter((p) => p.text && !p.thought)
            .map((p) => p.text)
            .join("");
          span.setAttribute(`${ATTR_GEN_AI_COMPLETION}.${index}.content`, text);

          parts.forEach((part, partIndex) => {
            if (part.functionCall) {
              span.setAttribute(
                `${ATTR_GEN_AI_COMPLETION}.${index}.tool_calls.${partIndex}.name`,
                part.functionCall.name ?? ""
              );
              span.setAttribute(
                `${ATTR_GEN_AI_COMPLETION}.${index}.tool_calls.${partIndex}.arguments`,
                JSON.stringify(part.functionCall.args ?? {})
              );
            }
          });
        });
      }
    } catch (e) {
      this._diag.debug(String(e));
      this._config.exceptionLogger?.(e);
    }

    span.end();
  }

  private _endSpanStreaming({
    lastChunk,
    accumulatedText,
    span,
  }: {
    lastChunk: GenerateContentResponse;
    accumulatedText: string;
    span: Span;
  }) {
    try {
      if (lastChunk.modelVersion) {
        span.setAttribute(ATTR_GEN_AI_RESPONSE_MODEL, lastChunk.modelVersion);
      }

      if (lastChunk.usageMetadata) {
        if (lastChunk.usageMetadata.totalTokenCount !== undefined) {
          span.setAttribute(
            SpanAttributes.LLM_USAGE_TOTAL_TOKENS,
            lastChunk.usageMetadata.totalTokenCount
          );
        }
        if (lastChunk.usageMetadata.promptTokenCount !== undefined) {
          span.setAttribute(
            ATTR_GEN_AI_USAGE_PROMPT_TOKENS,
            lastChunk.usageMetadata.promptTokenCount
          );
        }
        if (lastChunk.usageMetadata.candidatesTokenCount !== undefined) {
          span.setAttribute(
            ATTR_GEN_AI_USAGE_COMPLETION_TOKENS,
            lastChunk.usageMetadata.candidatesTokenCount
          );
        }
      }

      if (this._shouldSendPrompts()) {
        span.setAttribute(`${ATTR_GEN_AI_COMPLETION}.0.role`, "model");
        span.setAttribute(`${ATTR_GEN_AI_COMPLETION}.0.content`, accumulatedText);

        const finishReason = lastChunk.candidates?.[0]?.finishReason;
        if (finishReason) {
          span.setAttribute(`${ATTR_GEN_AI_COMPLETION}.0.finish_reason`, finishReason);
        }
      }
    } catch (e) {
      this._diag.debug(String(e));
      this._config.exceptionLogger?.(e);
    }

    span.end();
  }

  private _shouldSendPrompts() {
    const contextShouldSendPrompts = context.active().getValue(CONTEXT_KEY_ALLOW_TRACE_CONTENT);

    if (contextShouldSendPrompts !== undefined) {
      return contextShouldSendPrompts;
    }

    return this._config.traceContent !== undefined ? this._config.traceContent : true;
  }
}

function normalizeContents(contents: unknown): Content[] {
  if (typeof contents === "string") {
    return [{ parts: [{ text: contents }], role: "user" }];
  }

  if (Array.isArray(contents)) {
    if (contents.length === 0) return [];

    const first = contents[0];
    const isPartArray =
      typeof first === "string" ||
      (typeof first === "object" && first !== null && !("role" in first) && !("parts" in first));

    if (isPartArray) {
      return [
        {
          parts: contents.map((p: any) => (typeof p === "string" ? { text: p } : p)),
          role: "user",
        },
      ];
    }

    return contents as Content[];
  }

  if (typeof contents === "object" && contents !== null) {
    const obj = contents as any;
    if ("role" in obj || "parts" in obj) {
      return [obj as Content];
    }
    return [{ parts: [obj as Part], role: "user" }];
  }

  return [];
}

function normalizeSystemInstruction(sysInstruction: unknown): string {
  if (typeof sysInstruction === "string") {
    return sysInstruction;
  }

  if (Array.isArray(sysInstruction)) {
    return sysInstruction
      .map((p: any) => (typeof p === "string" ? p : (p.text ?? JSON.stringify(p))))
      .join(" ");
  }

  if (typeof sysInstruction === "object" && sysInstruction !== null) {
    const obj = sysInstruction as any;
    if (obj.parts) {
      return extractPartsText(obj.parts);
    }
    if (obj.text) {
      return obj.text;
    }
    return JSON.stringify(sysInstruction);
  }

  return "";
}

function extractPartsText(parts: Part[]): string {
  return parts
    .map((p) => {
      if (p.text) return p.text;
      if (p.functionCall) return `[function_call: ${p.functionCall.name}]`;
      if (p.functionResponse) return "[function_response]";
      return "";
    })
    .join("");
}
