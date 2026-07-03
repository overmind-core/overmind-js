/**
 * Manual span helpers — the JS counterpart to the Python SDK's `@observe` /
 * `@tool` / `@retrieval` decorators and `start_span` context manager.
 *
 * The provider auto-instrumentations cover LLM calls automatically; these
 * helpers let an agent trace its own tool calls, retrieval steps, and
 * workflows with the same canonical `overmind.*` / `tool.*` attributes the
 * server understands. Spans nest under the active OTel context, preserving the
 * parent/child tree across mixed instrumentation.
 */

import {
  type Attributes,
  type AttributeValue,
  type Span,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";

import { version } from "../package.json";
import * as attrs from "./attrs";

export const SDK_TRACER_NAME = "overmind-js";

export enum SpanType {
  FUNCTION = "function",
  ENTRY_POINT = "entry_point",
  WORKFLOW = "workflow",
  TOOL = "tool_call",
  LLM = "llm_call",
  RETRIEVAL = "retrieval",
}

export function getTracer() {
  return trace.getTracer(SDK_TRACER_NAME, version);
}

function coerceAttribute(value: unknown): AttributeValue {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value as string[];
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Add a custom tag to the active span. Rich values are JSON-encoded. */
export function setTag(key: string, value: unknown): void {
  const span = trace.getActiveSpan();
  if (span) span.setAttribute(key, coerceAttribute(value));
}

/** Record an exception on the active span and mark it as errored. */
export function captureException(error: unknown): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  const err = error instanceof Error ? error : new Error(String(error));
  span.recordException(err);
  span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
}

/** Stamp retrieval-step stats on the active span (`overmind.retrieval.*`). */
export function setRetrievalStats(stats: { queryChars?: number; resultCount?: number }): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  if (stats.queryChars !== undefined) {
    span.setAttribute(attrs.RETRIEVAL_QUERY_CHARS, stats.queryChars);
  }
  if (stats.resultCount !== undefined) {
    span.setAttribute(attrs.RETRIEVAL_RESULT_COUNT, stats.resultCount);
  }
}

function finalizeSpan(span: Span, error: unknown, startMs: number): void {
  span.setAttribute(attrs.DURATION_SECONDS, Math.max(0, (performance.now() - startMs) / 1000));
  if (error === undefined) {
    span.setAttribute(attrs.STATUS, "success");
    span.setStatus({ code: SpanStatusCode.OK });
    return;
  }
  const err = error instanceof Error ? error : new Error(String(error));
  span.setAttribute(attrs.STATUS, "failed");
  span.setAttribute(attrs.ERROR_TYPE, err.name || "Error");
  span.setAttribute(attrs.ERROR_MESSAGE, err.message.slice(0, 1024));
  span.recordException(err);
  span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
}

export type WithSpanOptions = {
  type?: SpanType;
  attributes?: Attributes;
  /** Called on failure before the span is finalized (e.g. to stamp `tool.error`). */
  onError?: (span: Span, error: unknown) => void;
};

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Run *fn* inside a new active span, stamping `overmind.span.type` /
 * `overmind.status` / `overmind.duration.seconds` and recording exceptions.
 * Handles both sync and async *fn* (the span stays open until a returned
 * promise settles). The span is the argument to *fn*.
 */
export function withSpan<T>(name: string, fn: (span: Span) => T, opts: WithSpanOptions = {}): T {
  const { type = SpanType.FUNCTION, attributes, onError } = opts;
  return getTracer().startActiveSpan(name, { attributes }, (span): T => {
    span.setAttribute(attrs.SPAN_TYPE, type);
    const startMs = performance.now();
    const fail = (error: unknown): never => {
      onError?.(span, error);
      finalizeSpan(span, error, startMs);
      span.end();
      throw error;
    };
    try {
      const result = fn(span);
      if (isThenable(result)) {
        return result.then(
          (value) => {
            finalizeSpan(span, undefined, startMs);
            span.end();
            return value;
          },
          (error) => fail(error)
        ) as T;
      }
      finalizeSpan(span, undefined, startMs);
      span.end();
      return result;
    } catch (error) {
      return fail(error);
    }
  });
}

function argKeysFrom(args: unknown[]): string[] {
  // JS can't reflect parameter names at runtime; when a tool takes a single
  // options object (the idiomatic pattern) we surface its keys, otherwise a
  // positional `arg0…argN` list.
  if (args.length === 1 && args[0] && typeof args[0] === "object" && !Array.isArray(args[0])) {
    return Object.keys(args[0] as Record<string, unknown>);
  }
  return args.map((_, index) => `arg${index}`);
}

function captureInputs(span: Span, args: unknown[]): void {
  try {
    span.setAttribute(attrs.INPUTS, JSON.stringify(args.length === 1 ? args[0] : args));
  } catch {
    // best-effort — capture never breaks the wrapped call
  }
}

function captureOutput(span: Span, result: unknown): void {
  try {
    span.setAttribute(attrs.OUTPUTS, JSON.stringify(result));
  } catch {
    // best-effort
  }
}

type AnyFn = (...args: never[]) => unknown;

function wrap<F extends AnyFn>(
  name: string,
  fn: F,
  type: SpanType,
  extras?: { toolMeta?: boolean; captureIO?: boolean }
): F {
  const wrapped = (...args: Parameters<F>): ReturnType<F> =>
    withSpan(
      name,
      (span) => {
        if (extras?.toolMeta) {
          span.setAttribute(attrs.TOOL_NAME, name);
          const keys = argKeysFrom(args);
          if (keys.length) span.setAttribute(attrs.TOOL_ARG_KEYS, keys);
        }
        if (extras?.captureIO) captureInputs(span, args);
        const result = fn(...args);
        // Outputs are captured for sync results; async outputs are omitted (a
        // JS divergence from the Python `@observe`, which can await the return).
        if (extras?.captureIO && !isThenable(result)) captureOutput(span, result);
        return result;
      },
      {
        onError: extras?.toolMeta
          ? (span, error) => {
              const err = error instanceof Error ? error : new Error(String(error));
              span.setAttribute(attrs.TOOL_ERROR, err.name || "Error");
            }
          : undefined,
        type,
      }
    ) as ReturnType<F>;
  return wrapped as F;
}

/** Wrap *fn* as a tool-call span (`tool.name` / `tool.arg_keys` / `tool.error`). */
export function tool<F extends AnyFn>(name: string, fn: F): F {
  return wrap(name, fn, SpanType.TOOL, { captureIO: true, toolMeta: true });
}

/** Wrap *fn* as a retrieval span. Use {@link setRetrievalStats} inside *fn*. */
export function retrieval<F extends AnyFn>(name: string, fn: F): F {
  return wrap(name, fn, SpanType.RETRIEVAL, { captureIO: true });
}

/** Wrap *fn* as a workflow span. */
export function workflow<F extends AnyFn>(name: string, fn: F): F {
  return wrap(name, fn, SpanType.WORKFLOW, { captureIO: true });
}

/** Wrap *fn* as an entry-point span. */
export function entryPoint<F extends AnyFn>(name: string, fn: F): F {
  return wrap(name, fn, SpanType.ENTRY_POINT, { captureIO: true });
}

/** Wrap *fn* as a generic function span, capturing inputs/outputs. */
export function observe<F extends AnyFn>(name: string, fn: F): F {
  return wrap(name, fn, SpanType.FUNCTION, { captureIO: true });
}
