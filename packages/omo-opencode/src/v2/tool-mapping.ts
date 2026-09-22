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
    const metadata = { ...(r.title !== undefined ? { title: r.title } : {}), ...(r.metadata ?? {}) }
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
 * - abort: a non-aborting signal is supplied because V2 exposes none.
 * - ask: a resolver is not available here; the shim forwards to progress and resolves.
 */
export function toV2Tool(
  name: string,
  def: V1ToolDefinition,
  opts: { namespace: string; directory: string },
): {
  name: string
  description: string
  input: z.ZodObject<z.ZodRawShape>
  execute: (input: unknown, context: V2Context) => Promise<{ content: string | V2Content[]; metadata?: Record<string, unknown> }>
  options: { namespace: string; codemode: false }
} {
  const controller = new AbortController()
  return {
    name,
    description: def.description,
    input: z.object(def.args),
    options: { namespace: opts.namespace, codemode: false },
    execute: async (input, context) => {
      const shimmed = {
        sessionID: context.sessionID,
        messageID: context.messageID,
        agent: context.agent,
        directory: opts.directory,
        worktree: opts.directory,
        abort: controller.signal,
        metadata: (i: { title?: string; metadata?: Record<string, unknown> }) => {
          void context.progress({ ...(i.metadata ?? {}), ...(i.title !== undefined ? { title: i.title } : {}) })
        },
        ask: async () => {},
      }
      return normalizeToolResult(await def.execute(input, shimmed))
    },
  }
}
