/**
 * Agent / project identity for Overmind traces.
 *
 * The Overmind server attaches every span to a concrete Agent/Project row via
 * `overmind.agent.id` (direct primary-key lookup — drift-proof), falling back
 * to slugifying `overmind.agent.name`. Identity is stamped on the OTel resource
 * (from `initTracing` config) AND, via the identity span processor, onto every
 * span — including spans from third-party auto-instrumentors — so runtime
 * changes through the setters below propagate too.
 *
 * `agentId` is preferred over `agentName`: it is a stable PK, whereas renaming
 * an agent changes its slug and spawns a new server-side Agent.
 */

import type { Attributes } from "@opentelemetry/api";

import * as attrs from "./attrs";

export type Identity = {
  agentId?: string;
  agentName?: string;
  projectId?: string;
  conversationId?: string;
};

const identity: Identity = {};

/**
 * Seed identity from explicit config, falling back to the
 * `OVERMIND_AGENT_ID` / `OVERMIND_AGENT_NAME` / `OVERMIND_PROJECT_ID` env vars.
 * Called by `OvermindClient.initTracing`. Values already set (e.g. via the
 * setters) are preserved unless overridden by a provided/env value.
 */
export function seedIdentity(config: {
  agentId?: string;
  agentName?: string;
  projectId?: string;
}): void {
  const agentId = config.agentId ?? process.env.OVERMIND_AGENT_ID;
  const agentName = config.agentName ?? process.env.OVERMIND_AGENT_NAME;
  const projectId = config.projectId ?? process.env.OVERMIND_PROJECT_ID;
  if (agentId) identity.agentId = agentId;
  if (agentName) identity.agentName = agentName;
  if (projectId) identity.projectId = projectId;
}

/** Bind every subsequent span to *agentId* (the Agent's server UUID). */
export function setAgentId(agentId: string): void {
  identity.agentId = agentId;
}

/**
 * Bind every subsequent span to *agentName*. The server slugifies this for a
 * stable identity, so keep it constant across runs. Prefer {@link setAgentId}.
 */
export function setAgentName(agentName: string): void {
  identity.agentName = agentName;
}

/** Bind every subsequent span to *projectId* (only needed for session auth). */
export function setProjectId(projectId: string): void {
  identity.projectId = projectId;
}

/** Group subsequent spans under a stable `conversation.id` (chat sessions). */
export function setConversationId(conversationId: string): void {
  identity.conversationId = conversationId;
}

/** Current identity snapshot (used by the identity span processor). */
export function getIdentity(): Readonly<Identity> {
  return identity;
}

/** Identity as OTel resource attributes (omitting anything unset). */
export function identityResourceAttributes(): Attributes {
  const resourceAttrs: Attributes = {};
  if (identity.agentId) resourceAttrs[attrs.AGENT_ID] = identity.agentId;
  if (identity.agentName) resourceAttrs[attrs.AGENT_NAME] = identity.agentName;
  if (identity.projectId) resourceAttrs[attrs.PROJECT_ID] = identity.projectId;
  return resourceAttrs;
}
