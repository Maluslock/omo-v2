// packages/omo-opencode/src/v2/register-tools.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CLIENT_DEPENDENT_TOOLS,
  registerOmoTools,
  resetOmoManagersCache,
} from "./register-tools"

type MockTool = {
  name: string
  description: string
  input: unknown
  options: { namespace: string; codemode: false }
  execute: (input: unknown, context: unknown) => Promise<unknown>
}

function createMockEditor() {
  const registry = new Map<string, MockTool>()
  const namespaceCalls: Array<{ name: string; description: string }> = []
  const addCalls: string[] = []
  const updateCalls: string[] = []
  return {
    registry,
    namespaceCalls,
    addCalls,
    updateCalls,
    list: () => [...registry.values()],
    get: (id: string) => registry.get(id),
    namespace: (ns: { name: string; description: string }) => {
      namespaceCalls.push(ns)
    },
    add: (tool: MockTool) => {
      const id = `${tool.options.namespace}_${tool.name}`
      if (registry.has(id)) throw new Error(`duplicate add: ${id}`)
      registry.set(id, { ...tool, id })
      addCalls.push(id)
    },
    update: (id: string, fn: (tool: MockTool) => void) => {
      const tool = registry.get(id)
      if (tool === undefined) throw new Error(`update miss: ${id}`)
      fn(tool)
      updateCalls.push(id)
    },
    remove: (id: string) => registry.delete(id),
  }
}

type MockEditor = ReturnType<typeof createMockEditor>

function createMockCtx(directory: string, editor: MockEditor) {
  return {
    location: { directory },
    tool: {
      transform: async (callback: (editor: MockEditor) => void) => {
        const returned = callback(editor)
        if (returned !== undefined) throw new Error("transform callback must be synchronous")
        return { dispose: async () => {} }
      },
    },
  } as never
}

function fakeTool(name: string): unknown {
  return {
    description: name,
    args: {},
    execute: async () => ({ title: name, output: name }),
  }
}

function createFakeDeps(tools: Record<string, unknown>) {
  const managers = {
    tmuxSessionManager: {},
    backgroundManager: {},
    skillMcpManager: {},
    configHandler: {},
    modelFallbackControllerAccessor: {},
  }
  let managerCalls = 0
  let lastCtx: unknown
  const deps = {
    createManagers: ((args: { ctx: unknown }) => {
      managerCalls += 1
      lastCtx = args.ctx
      return managers
    }) as never,
    createTools: (async (args: { managers: unknown }) => {
      if (args.managers !== managers) throw new Error("createTools did not receive the memoized managers")
      return { filteredTools: tools }
    }) as never,
  }
  return { deps, getManagerCalls: () => managerCalls, getLastCtx: () => lastCtx }
}

let home: string
let directory: string
let previousHome: string | undefined
let previousXdg: string | undefined

beforeEach(() => {
  previousHome = process.env.HOME
  previousXdg = process.env.XDG_CONFIG_HOME
  home = mkdtempSync(join(tmpdir(), "omo-v2-tools-home-"))
  directory = mkdtempSync(join(tmpdir(), "omo-v2-tools-dir-"))
  // Hermetic: never read the developer's real ~/.omo/omo.jsonc.
  process.env.HOME = home
  process.env.XDG_CONFIG_HOME = join(home, "xdg")
  resetOmoManagersCache()
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = previousXdg
  rmSync(home, { recursive: true, force: true })
  rmSync(directory, { recursive: true, force: true })
})

describe("registerOmoTools", () => {
  it("registers client-free tools namespaced under omo with codemode:false", async () => {
    const editor = createMockEditor()
    const { deps } = createFakeDeps({ glob: fakeTool("glob"), grep: fakeTool("grep") })

    await registerOmoTools(createMockCtx(directory, editor), {} as never, deps)

    expect(editor.namespaceCalls).toEqual([{ name: "omo", description: "oh-my-openagent tools" }])
    expect(editor.addCalls).toEqual(["omo_glob", "omo_grep"])
    for (const id of ["omo_glob", "omo_grep"]) {
      const tool = editor.get(id)
      expect(tool?.options).toEqual({ namespace: "omo", codemode: false })
      expect(typeof tool?.execute).toBe("function")
    }
  })

  it("is idempotent across a second call (update, no duplicate add)", async () => {
    const editor = createMockEditor()
    const { deps } = createFakeDeps({ glob: fakeTool("glob"), grep: fakeTool("grep") })
    const ctx = createMockCtx(directory, editor)

    await registerOmoTools(ctx, {} as never, deps)
    await registerOmoTools(ctx, {} as never, deps)

    expect(editor.addCalls).toEqual(["omo_glob", "omo_grep"])
    expect(editor.updateCalls).toEqual(["omo_glob", "omo_grep"])
    expect(editor.registry.size).toBe(2)
  })

  it("does not pass client-dependent tools to editor.add", async () => {
    const editor = createMockEditor()
    const { deps } = createFakeDeps({
      glob: fakeTool("glob"),
      edit: fakeTool("edit"),
      task: fakeTool("task"),
      call_omo_agent: fakeTool("call_omo_agent"),
      session_list: fakeTool("session_list"),
    })

    await registerOmoTools(createMockCtx(directory, editor), {} as never, deps)

    expect(editor.addCalls).toEqual(["omo_glob", "omo_edit"])
    for (const name of ["task", "call_omo_agent", "session_list"]) {
      expect(CLIENT_DEPENDENT_TOOLS.has(name)).toBe(true)
      expect(editor.get(`omo_${name}`)).toBeUndefined()
      expect(editor.addCalls).not.toContain(`omo_${name}`)
    }
  })

  it("passes no client into createManagers (never fabricates one)", async () => {
    const editor = createMockEditor()
    const { deps, getLastCtx } = createFakeDeps({ glob: fakeTool("glob") })

    await registerOmoTools(createMockCtx(directory, editor), {} as never, deps)

    expect(getLastCtx()).toEqual({ directory })
    expect((getLastCtx() as { client?: unknown }).client).toBeUndefined()
  })

  it("memoizes createManagers per directory across calls", async () => {
    const editor = createMockEditor()
    const { deps, getManagerCalls } = createFakeDeps({ glob: fakeTool("glob") })
    const ctx = createMockCtx(directory, editor)

    await registerOmoTools(ctx, {} as never, deps)
    await registerOmoTools(ctx, {} as never, deps)

    expect(getManagerCalls()).toBe(1)
  })

  it("re-creates managers when the config fingerprint changes for the same directory", async () => {
    const editor = createMockEditor()
    const { deps, getManagerCalls } = createFakeDeps({ glob: fakeTool("glob") })
    const ctx = createMockCtx(directory, editor)

    await registerOmoTools(ctx, {} as never, deps)
    await registerOmoTools(ctx, { monitor: { enabled: true } } as never, deps)

    expect(getManagerCalls()).toBe(2)
  })

  it("skips manager assembly when the V2 tool domain is unavailable", async () => {
    const { deps, getManagerCalls } = createFakeDeps({ glob: fakeTool("glob") })

    await expect(
      registerOmoTools({ location: { directory } } as never, {} as never, deps),
    ).resolves.toBeUndefined()
    expect(getManagerCalls()).toBe(0)
  })
})
