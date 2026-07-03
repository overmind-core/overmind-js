/**
 * Overmind JS SDK — OpenAI example.
 *
 * Shows the new agent-identity config (`agentId` / `agentName` / `projectId`,
 * with `OVERMIND_AGENT_ID` / `OVERMIND_AGENT_NAME` / `OVERMIND_PROJECT_ID` env
 * fallbacks) plus the manual `tool()` helper. LLM spans automatically get the
 * canonical `genai.*` token usage and derived `genai.cost`.
 *
 *   OVERMIND_API_KEY=... OPENAI_API_KEY=... bun run examples/openai.ts
 */

import { OvermindClient, setConversationId, tool } from "@overmind-lab/trace-sdk";
import { OpenAI } from "openai";

const overmind = new OvermindClient({
  // Prefer agentId (drift-proof PK). agentName is slugified server-side for a
  // stable identity. Both fall back to OVERMIND_AGENT_ID / OVERMIND_AGENT_NAME.
  agentId: process.env.OVERMIND_AGENT_ID,
  agentName: "Support Triage Agent",
  apiKey: process.env.OVERMIND_API_KEY as string,
  appName: "support-triage",
});

// Must be called before any OpenAI calls.
overmind.initTracing({
  enableBatching: false,
  enabledProviders: { openai: OpenAI },
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// A traced tool — emits tool.name / tool.arg_keys, and tool.error on failure.
const lookupOrder = tool("lookup_order", async ({ orderId }: { orderId: string }) => {
  return { orderId, status: "shipped" };
});

async function main() {
  // Group related traces under one user-visible session.
  setConversationId("session-42");

  const order = await lookupOrder({ orderId: "A-1001" });

  const response = await openai.chat.completions.create({
    messages: [
      { content: "You are a concise support agent.", role: "system" },
      { content: `Summarize the status of order ${JSON.stringify(order)}.`, role: "user" },
    ],
    model: "gpt-4o-mini",
  });

  console.log(response.choices[0]?.message?.content);
  await overmind.shutdown();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
