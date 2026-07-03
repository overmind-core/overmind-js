import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import * as attrs from "../src/attrs";
import { setAgentId, setAgentName, setProjectId } from "../src/identity";
import { OvermindSpanProcessor } from "../src/span-processors";
import { retrieval, setRetrievalStats, tool, withSpan } from "../src/tracing";

const exporter = new InMemorySpanExporter();

beforeAll(() => {
  const provider = new NodeTracerProvider({
    spanProcessors: [new OvermindSpanProcessor(), new SimpleSpanProcessor(exporter)],
  });
  provider.register();
});

beforeEach(() => {
  exporter.reset();
});

function findSpan(name: string): ReadableSpan {
  const span = exporter.getFinishedSpans().find((s) => s.name === name);
  if (!span) throw new Error(`span ${name} not found`);
  return span;
}

describe("GenAi enrichment span processor", () => {
  test("mirrors auto-instrumentor usage onto canonical genai.* + cost + type", () => {
    const span = trace.getTracer("test").startSpan("openai.chat", {
      attributes: {
        "gen_ai.request.model": "gpt-4o-mini",
        "gen_ai.system": "openai",
        "gen_ai.usage.completion_tokens": 50,
        "gen_ai.usage.prompt_tokens": 100,
      },
    });
    span.end();

    const s = findSpan("openai.chat");
    expect(s.attributes[attrs.LLM_PROMPT_TOKENS]).toBe(100);
    expect(s.attributes[attrs.LLM_COMPLETION_TOKENS]).toBe(50);
    expect(s.attributes[attrs.LLM_TOTAL_TOKENS]).toBe(150);
    expect(s.attributes[attrs.LLM_MODEL]).toBe("gpt-4o-mini");
    expect(s.attributes[attrs.LLM_PROVIDER]).toBe("openai");
    expect(s.attributes[attrs.SPAN_TYPE]).toBe(attrs.SpanTypeValues.LLM);
    expect(s.attributes[attrs.LLM_COST] as number).toBeGreaterThan(0);
    expect(s.attributes[attrs.LLM_ELAPSED_SECONDS] as number).toBeGreaterThanOrEqual(0);
  });

  test("leaves non-LLM spans untouched", () => {
    const span = trace.getTracer("test").startSpan("db.query");
    span.end();
    const s = findSpan("db.query");
    expect(s.attributes[attrs.LLM_TOTAL_TOKENS]).toBeUndefined();
    expect(s.attributes[attrs.SPAN_TYPE]).toBeUndefined();
  });
});

describe("identity stamping (GAP #2)", () => {
  test("stamps overmind.agent.* / project on every span via onStart", () => {
    setAgentId("agent-123");
    setAgentName("Lead Qualifier");
    setProjectId("project-abc");

    const span = trace.getTracer("test").startSpan("some.work");
    span.end();

    const s = findSpan("some.work");
    expect(s.attributes[attrs.AGENT_ID]).toBe("agent-123");
    expect(s.attributes[attrs.AGENT_NAME]).toBe("Lead Qualifier");
    expect(s.attributes[attrs.PROJECT_ID]).toBe("project-abc");
  });
});

describe("manual tracing API (depth parity)", () => {
  test("tool() stamps tool.name / tool.arg_keys / span type / status", async () => {
    const lookup = tool("lookup_order", async (args: { orderId: string }) => {
      return { orderId: args.orderId, status: "shipped" };
    });
    await lookup({ orderId: "42" });

    const s = findSpan("lookup_order");
    expect(s.attributes[attrs.SPAN_TYPE]).toBe(attrs.SpanTypeValues.TOOL);
    expect(s.attributes[attrs.TOOL_NAME]).toBe("lookup_order");
    expect(s.attributes[attrs.TOOL_ARG_KEYS]).toEqual(["orderId"]);
    expect(s.attributes[attrs.STATUS]).toBe("success");
    expect(s.attributes[attrs.DURATION_SECONDS] as number).toBeGreaterThanOrEqual(0);
  });

  test("tool() records exceptions and re-throws (tool.error + ERROR status)", () => {
    const boom = tool("boom", () => {
      throw new Error("nope");
    });
    expect(() => boom()).toThrow("nope");

    const s = findSpan("boom");
    expect(s.attributes[attrs.STATUS]).toBe("failed");
    expect(s.attributes[attrs.TOOL_ERROR]).toBe("Error");
    expect(s.attributes[attrs.ERROR_TYPE]).toBe("Error");
    expect(s.status.code).toBe(SpanStatusCode.ERROR);
    expect(s.events.some((e) => e.name === "exception")).toBe(true);
  });

  test("retrieval() stamps overmind.retrieval.* via setRetrievalStats", () => {
    const search = retrieval("vector_search", (query: string) => {
      setRetrievalStats({ queryChars: query.length, resultCount: 3 });
      return ["doc1", "doc2", "doc3"];
    });
    search("what is overmind?");

    const s = findSpan("vector_search");
    expect(s.attributes[attrs.SPAN_TYPE]).toBe(attrs.SpanTypeValues.RETRIEVAL);
    expect(s.attributes[attrs.RETRIEVAL_QUERY_CHARS]).toBe("what is overmind?".length);
    expect(s.attributes[attrs.RETRIEVAL_RESULT_COUNT]).toBe(3);
  });

  test("preserves parent/child nesting", () => {
    withSpan("parent_workflow", () => {
      const child = tool("child_tool", () => "done");
      child();
    });

    const parent = findSpan("parent_workflow");
    const child = findSpan("child_tool");
    expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
  });
});
