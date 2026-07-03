/**
 * The Overmind span processor.
 *
 * Two responsibilities, matching the Python SDK's on-start + on-end processors:
 *
 * 1. `onStart` — stamp the ambient agent / project / conversation identity onto
 *    every span (including spans from third-party auto-instrumentors) so the
 *    server can resolve them to a concrete Agent/Project.
 * 2. `onEnding` — mirror any `gen_ai.*` / `llm.usage.*` usage produced by
 *    auto-instrumentors onto the canonical `genai.*` keys the server rolls up,
 *    derive cost, and stamp the LLM depth attributes. `onEnding` receives a
 *    still-writable span (before export), so we use `setAttribute` directly —
 *    no private-field mutation, and it runs regardless of processor order.
 */

import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";

import * as attrs from "./attrs";
import { canonicalUsageUpdates } from "./genai-usage";
import { getIdentity } from "./identity";

function hrTimeToSeconds(duration: readonly [number, number]): number {
  return duration[0] + duration[1] / 1e9;
}

export class OvermindSpanProcessor implements SpanProcessor {
  onStart(span: Span, _parentContext: Context): void {
    const identity = getIdentity();
    if (identity.agentId) span.setAttribute(attrs.AGENT_ID, identity.agentId);
    if (identity.agentName) span.setAttribute(attrs.AGENT_NAME, identity.agentName);
    if (identity.projectId) span.setAttribute(attrs.PROJECT_ID, identity.projectId);
    if (identity.conversationId) span.setAttribute(attrs.CONVERSATION_ID, identity.conversationId);
  }

  onEnding(span: Span): void {
    const durationSeconds = hrTimeToSeconds(span.duration);
    const updates = canonicalUsageUpdates(span.attributes, durationSeconds);
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) span.setAttribute(key, value);
    }
  }

  onEnd(_span: ReadableSpan): void {}

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
