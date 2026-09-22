// packages/omo-opencode/src/v2/tool-mapping.ts
import { z } from "zod"

export type V1ToolDefinition = {
  description: string
  args: z.ZodRawShape
  execute: (args: any, context: any) => Promise<unknown>
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
  input: z.ZodObject<z.ZodRawShape>
  execute: (input: unknown, context: V2Context) => Promise<{ content: string | V2Content[]; metadata?: Record<string, unknown> }>
  options: { namespace: string; codemode: false }
} {
  return {
    name,
    description: def.description,
    input: z.object(def.args),
    options: { namespace: opts.namespace, codemode: false },
    execute: async (input, context) => {
      const controller = new AbortController()
      const shimmed: V1ToolContext = {
        sessionID: context.sessionID,
        messageID: context.messageID,
        agent: context.agent,
        directory: opts.directory,
        worktree: opts.directory,
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
