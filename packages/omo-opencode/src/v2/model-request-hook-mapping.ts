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

/**
 * V1 scalar generation setting -> V2 `SessionRequestOptions` name.
 *
 * V2's typed generation fields are `maxTokens`, `temperature`, `topP`, `topK`,
 * `frequencyPenalty`, `presencePenalty`, `seed`, `stop` (`@opencode/ai` `GenerationOptionsFields`).
 * There is no `maxOutputTokens`: writing that name lands as an unknown provider option instead of a
 * generation setting, so the max-output clamp silently did nothing. The V1 name stays in the V1
 * view because omo's hooks read and write it.
 */
export const GENERATION_KEY_MAP = {
  temperature: "temperature",
  topP: "topP",
  topK: "topK",
  maxOutputTokens: "maxTokens",
} as const

export const GENERATION_KEYS = Object.keys(GENERATION_KEY_MAP) as Array<keyof typeof GENERATION_KEY_MAP>

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
    // Seed the V1 scalars from the current V2 options so omo's chain sees the live values, the way
    // V1 handlers received the host's current params rather than an empty object.
    output: {
      ...seedV1GenerationFromV2Options(isRecord(event.options) ? event.options : {}),
      options: isRecord(event.options) ? { ...event.options } : {},
    },
  }
}

/** Read the current V2 generation options back into the V1 scalar names. */
export function seedV1GenerationFromV2Options(options: Record<string, unknown>): Omit<V1ChatParamsOutput, "options"> {
  const seeded: Omit<V1ChatParamsOutput, "options"> = {}
  for (const [v1Key, v2Key] of Object.entries(GENERATION_KEY_MAP)) {
    const value = options[v2Key]
    if (typeof value === "number") seeded[v1Key as keyof typeof GENERATION_KEY_MAP] = value
  }
  return seeded
}

/** Merge the handler's generation settings back onto the V2 context options, under V2's names. */
export function applyV1ChatParams(event: unknown, output: V1ChatParamsOutput): void {
  if (!isRecord(event)) return
  const base = isRecord(event.options) ? event.options : {}
  const merged: Record<string, unknown> = { ...base }
  for (const [v1Key, v2Key] of Object.entries(GENERATION_KEY_MAP)) {
    const value = output[v1Key as keyof typeof GENERATION_KEY_MAP]
    if (typeof value === "number") merged[v2Key] = value
  }
  Object.assign(merged, output.options)
  event.options = merged
}
