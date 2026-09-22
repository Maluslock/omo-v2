// packages/omo-opencode/src/v2/agent-mapping.ts
import { Model } from "@opencode/plugin"

type V1Tools = Record<string, boolean>

const TOOL_ACTION: Record<string, string> = {
  bash: "shell",
  write: "edit",
  edit: "edit",
  patch: "edit",
}

function normalizeMode(value: unknown): "subagent" | "primary" | "all" {
  return value === "primary" || value === "all" ? value : "subagent"
}

function toPermissions(tools: unknown): Array<{ action: string; resource: string; effect: "allow" | "deny" }> | undefined {
  if (typeof tools !== "object" || tools === null) return undefined
  const entries = Object.entries(tools as V1Tools)
  if (entries.length === 0) return undefined
  return entries.map(([name, enabled]) => ({
    action: TOOL_ACTION[name] ?? name,
    resource: "*",
    effect: enabled ? "allow" : "deny",
  }))
}

export function toV2AgentInfo(id: string, v1: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { name: id, mode: normalizeMode(v1.mode) }

  if (typeof v1.description === "string") out.description = v1.description
  if (typeof v1.prompt === "string") out.system = v1.prompt
  if (v1.hidden === true) out.hidden = true
  if (typeof v1.color === "string") out.color = v1.color
  if (typeof v1.steps === "number") out.steps = v1.steps

  if (typeof v1.model === "string") {
    const parsed = Model.Ref.parse(v1.model)
    out.model = parsed.variant === undefined
      ? { providerID: parsed.providerID, id: parsed.id }
      : { providerID: parsed.providerID, id: parsed.id, variant: parsed.variant }
  } else if (typeof v1.model === "object" && v1.model !== null) {
    out.model = v1.model
  }

  const permissions = toPermissions(v1.tools)
  if (permissions !== undefined) out.permissions = permissions

  const body: Record<string, unknown> = {}
  if (typeof v1.temperature === "number") body.temperature = v1.temperature
  if (typeof v1.top_p === "number") body.top_p = v1.top_p
  if (Object.keys(body).length > 0) out.request = { body }

  return out
}
