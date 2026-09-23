// packages/omo-opencode/src/v2/tool-mapping.ts
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"

export type V1ToolDefinition = {
  description: string
  args: z.ZodRawShape
  execute: (args: any, context: any) => Promise<unknown>
}

/**
 * V2 extracts a tool input schema by walking the schema object's own internals. `def.args`
 * are built with `@opencode-ai/plugin`'s bundled zod (`tool.schema`), whose module instance
 * differs from this package's zod (4.4.3). Wrapping a foreign zod's raw shape with
 * `z.object(def.args)` (this package's zod) makes V2's JSON-Schema extraction throw
 * (`seen.ref` / "Non-representable type encountered"), so the tool is silently skipped at
 * registration. `tool.schema.object(...)` uses the args' own zod instance instead.
 */
type PluginArgsShape = Parameters<typeof tool.schema.object>[0]

/**
 * Root-zod schemas (this package's `zod`, 4.4.3) expose `_zod.processJSONSchema`; the schema
 * objects produced by `tool.schema` (the plugin's bundled zod, 4.1.8) do not. V2's tool loader
 * walks the input schema's own internals, so the wrapper and every arg schema must share the
 * `tool.schema` provenance. Mixing instances makes extraction throw
 * (`undefined is not an object (evaluating 'seen.ref')` / "Non-representable type encountered")
 * and the tool is silently dropped at registration. See the F1/F4 findings.
 */
const TOOL_SCHEMA_PROVENANCE = hasRootZodProvenance(tool.schema.string())

function hasRootZodProvenance(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false
  const marker = (value as { _zod?: { processJSONSchema?: unknown } })._zod?.processJSONSchema
  return typeof marker === "function"
}

/** Thrown when a tool's `args` were built with a different zod instance than the wrapper. */
export class ArgSchemaProvenanceError extends Error {
  readonly toolName: string
  readonly offendingArgs: readonly string[]

  constructor(toolName: string, offendingArgs: readonly string[]) {
    super(
      `tool "${toolName}" has args from a mismatched zod instance (${offendingArgs.join(", ")}); `
        + "build args with @opencode-ai/plugin's `tool.schema` so V2 can extract a JSON Schema. "
        + "Refusing to register the tool, which V2 would otherwise silently skip.",
    )
    this.name = "ArgSchemaProvenanceError"
    this.toolName = toolName
    this.offendingArgs = offendingArgs
  }
}

/**
 * Fail loudly instead of letting V2 silently skip a tool whose `args` could not have been built
 * with the same zod instance as the `tool.schema.object(...)` wrapper.
 */
export function assertArgSchemaProvenance(toolName: string, args: Record<string, unknown>): void {
  const offenders = Object.entries(args)
    .filter(([, schema]) => hasRootZodProvenance(schema) !== TOOL_SCHEMA_PROVENANCE)
    .map(([key]) => key)
  if (offenders.length > 0) throw new ArgSchemaProvenanceError(toolName, offenders)
}

type V2Context = {
  sessionID: string
  agent: string
  messageID: string
  id: string
  progress: (update: Record<string, unknown>) => Promise<void> | unknown
}

type V2Content = { type: "text"; text: string } | { type: "file"; uri: string; mime: string; name?: string }

export type V1AskInput = {
  permission: string
  patterns: string[]
  always: string[]
  metadata: Record<string, unknown>
}

export type V1ToolContext = {
  sessionID: string
  messageID: string
  agent: string
  directory: string
  worktree: string
  // hashline-edit keys its metadata store off any of these; V2 exposes the call id as `id`.
  callID: string
  callId: string
  call_id: string
  abort: AbortSignal
  metadata: (input: { title?: string; metadata?: Record<string, unknown> }) => void
  ask: (input: V1AskInput) => Promise<void>
}

export function normalizeToolResult(result: unknown): {
  content: string | V2Content[]
  metadata?: Record<string, unknown>
} {
  if (typeof result === "string") return { content: result }
  if (typeof result === "object" && result !== null) {
    const r = result as {
      title?: string
      output?: string
      metadata?: Record<string, unknown>
      attachments?: Array<{ type: "file"; mime: string; url: string; filename?: string }>
    }
    const metadata = { ...(r.metadata ?? {}), ...(r.title !== undefined ? { title: r.title } : {}) }
    const base = r.output ?? ""
    const attachments = r.attachments ?? []
    const content: string | V2Content[] =
      attachments.length === 0
        ? base
        : [
            { type: "text", text: base },
            ...attachments.map((a) => ({
              type: "file" as const,
              uri: a.url,
              mime: a.mime,
              ...(a.filename !== undefined ? { name: a.filename } : {}),
            })),
          ]
    return Object.keys(metadata).length > 0 ? { content, metadata } : { content }
  }
  return { content: String(result) }
}

/**
 * V2 ToolContext has no `directory`, `worktree`, `abort`, `ask`, or `metadata`.
 * - directory/worktree: static fallback to the plugin location (session moves are NOT reflected; see P2 findings).
 * - abort: a fresh non-aborting signal is created per `execute` call because V2 exposes no
 *   cancellation; the signal isolates calls but never aborts.
 * - ask: fail-closed. Unless an `ask` resolver is supplied via `opts.ask`, the shim rejects
 *   with "ask() is not available in this host; refusing to auto-approve" rather than silently
 *   granting consent.
 */
export function toV2Tool(
  name: string,
  def: V1ToolDefinition,
  opts: { namespace: string; directory: string; ask?: (input: V1AskInput) => Promise<void> },
): {
  name: string
  description: string
  input: ReturnType<typeof tool.schema.object>
  execute: (input: unknown, context: V2Context) => Promise<{ content: string | V2Content[]; metadata?: Record<string, unknown> }>
  options: { namespace: string; codemode: false }
} {
  assertArgSchemaProvenance(name, def.args as unknown as Record<string, unknown>)
  return {
    name,
    description: def.description,
    // Must use the args' own zod instance (`tool.schema`), not this package's zod — see above.
    input: tool.schema.object(def.args as unknown as PluginArgsShape),
    options: { namespace: opts.namespace, codemode: false },
    execute: async (input, context) => {
      const controller = new AbortController()
      const shimmed: V1ToolContext = {
        sessionID: context.sessionID,
        messageID: context.messageID,
        agent: context.agent,
        directory: opts.directory,
        worktree: opts.directory,
        callID: context.id,
        callId: context.id,
        call_id: context.id,
        abort: controller.signal,
        metadata: (i: { title?: string; metadata?: Record<string, unknown> }) => {
          void context.progress({ ...(i.metadata ?? {}), ...(i.title !== undefined ? { title: i.title } : {}) })
        },
        ask: (i: V1AskInput): Promise<void> =>
          opts.ask === undefined
            ? Promise.reject(new Error("ask() is not available in this host; refusing to auto-approve"))
            : opts.ask(i),
      }
      return normalizeToolResult(await def.execute(input, shimmed))
    },
  }
}
