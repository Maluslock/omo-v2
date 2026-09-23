// packages/omo-opencode/src/v2/model-request-hook-mapping.ts
import { isRecord } from "../shared"

/**
 * V2 `session.hook("context")` → V1 `chat.params` bridge (the only portable part of V2's
 * `model.request` surface).
 *
 * V1 `chat.params` received `{sessionID, agent, model, provider, message}` and wrote generation
 * settings (`temperature` / `topP` / `topK` / `maxOutputTokens` / `options`). V2's
 * `SessionModelRequest` carries no generation options — only `{sessionID, agent, model, kind,
 * baseURL, headers}` — while `SessionContext` does carry `options`. So the settings are bridged
 * onto the `context` hook, where they reach the request.
 *
 * `input.message` has no V2 counterpart, which matters: omo's `applyAgentVariant` reads
 * `message.variant`. That half is reported through `onUnmapped` instead of being dropped
 * silently. `chat.headers` is deliberately not bridged at all: its gate needs the user
 * message's `id` and `role`, which `SessionModelRequest` does not carry, so it would always
 * no-op (see the P3 findings).
 */

export type V1ChatParamsInput = {
  sessionID: string
  agent?: string
  model: { providerID: string; modelID: string }
  provider: { id: string }
}
export type V1ChatParamsOutput = {
  temperature?: number
  topP?: number
  topK?: number
  maxOutputTokens?: number
  options: Record<string, unknown>
}

/** V1 scalar generation settings, lifted onto V2 `options`. */
export const GENERATION_KEYS = ["temperature", "topP", "topK", "maxOutputTokens"] as const

export function toV1ChatParams(
  event: unknown,
): { input: V1ChatParamsInput; output: V1ChatParamsOutput } | undefined {
  if (!isRecord(event) || typeof event.sessionID !== "string") return undefined
  const model = isRecord(event.model) ? event.model : undefined
  const providerID = typeof model?.providerID === "string" ? model.providerID : undefined
  const modelID = typeof model?.id === "string" ? model.id : undefined
  if (providerID === undefined || modelID === undefined) return undefined
  return {
    input: {
      sessionID: event.sessionID,
      ...(typeof event.agent === "string" ? { agent: event.agent } : {}),
      model: { providerID, modelID },
      provider: { id: providerID },
    },
    output: { options: isRecord(event.options) ? { ...event.options } : {} },
  }
}

/** Merge the handler's generation settings back onto the V2 context options. */
export function applyV1ChatParams(event: unknown, output: V1ChatParamsOutput): void {
  if (!isRecord(event)) return
  const base = isRecord(event.options) ? event.options : {}
  const merged: Record<string, unknown> = { ...base }
  for (const key of GENERATION_KEYS) {
    const value = output[key]
    if (typeof value === "number") merged[key] = value
  }
  Object.assign(merged, output.options)
  event.options = merged
}
