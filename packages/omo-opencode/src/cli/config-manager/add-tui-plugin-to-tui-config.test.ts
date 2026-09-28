import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  LEGACY_PLUGIN_NAME,
  PLUGIN_NAME,
  getOpenCodeVersion,
  setVersionCache,
} from "../../shared"
import { ensureTuiPluginEntry } from "./add-tui-plugin-to-tui-config"

const tempDirs: string[] = []
// The version cache is process-global and other suites depend on whatever value they inherited, so
// pin a version for a test and restore the previous one instead of resetting it.
let previousVersion: string | null = null

function pinVersion(version: string): void {
  previousVersion = getOpenCodeVersion()
  setVersionCache(version)
}

function tempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omo-tui-config-"))
  tempDirs.push(dir)
  return dir
}

function writeConfig(dir: string, name: string, value: unknown): void {
  writeFileSync(join(dir, name), JSON.stringify(value, null, 2) + "\n", "utf-8")
}

function readTuiPlugins(dir: string): string[] {
  return JSON.parse(readFileSync(join(dir, "tui.json"), "utf-8")).plugin
}

function readClientConfig(dir: string): { schema?: string; plugins: string[]; [key: string]: unknown } {
  return JSON.parse(readFileSync(join(dir, "cli.json"), "utf-8"))
}

function writeFilePackage(dir: string, name = PLUGIN_NAME): string {
  const packageDir = join(dir, "package")
  mkdirSync(packageDir, { recursive: true })
  writeConfig(packageDir, "package.json", { name, exports: { ".": "./dist/index.js", "./tui": "./dist/tui.js" } })
  return `file:${packageDir}`
}

afterEach(() => {
  setVersionCache(previousVersion)
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("ensureTuiPluginEntry", () => {
  // 1.x hosts read tui.json; pin the version so the suite never picks up whatever opencode is
  // installed on the machine running the tests.
  beforeEach(() => pinVersion("1.5.0"))

  it("#given named server entry #when ensuring TUI config #then it adds package entry once and preserves others", () => {
    // given
    const dir = tempConfigDir()
    writeConfig(dir, "opencode.json", { plugin: [PLUGIN_NAME] })
    writeConfig(dir, "tui.json", { plugin: ["some-other/tui"], theme: "dark" })

    // when
    const first = ensureTuiPluginEntry({ configDir: dir })
    const second = ensureTuiPluginEntry({ configDir: dir })

    // then
    expect(first).toEqual({ changed: true, reason: "added" })
    expect(second).toEqual({ changed: false, reason: "already-present" })
    expect(readTuiPlugins(dir)).toEqual(["some-other/tui", PLUGIN_NAME])
    expect(readFileSync(join(dir, "tui.json"), "utf-8")).toContain('"theme": "dark"')
  })

  it("#given versioned named server entry #when ensuring TUI config #then it reuses the package spec", () => {
    // given
    const dir = tempConfigDir()
    writeConfig(dir, "opencode.json", { plugin: [`${PLUGIN_NAME}@4.9.2`] })

    // when
    const result = ensureTuiPluginEntry({ configDir: dir })

    // then
    expect(result).toEqual({ changed: true, reason: "added" })
    expect(readTuiPlugins(dir)).toEqual([`${PLUGIN_NAME}@4.9.2`])
  })

  it("#given file server entry and stale named TUI entry #when ensuring #then it adds the matching file entry", () => {
    // given
    const dir = tempConfigDir()
    const fileEntry = writeFilePackage(dir)
    writeConfig(dir, "opencode.json", { plugin: [fileEntry] })
    writeConfig(dir, "tui.json", { plugin: [`${PLUGIN_NAME}/tui`] })

    // when
    const first = ensureTuiPluginEntry({ configDir: dir })
    const second = ensureTuiPluginEntry({ configDir: dir })

    // then
    expect(first).toEqual({ changed: true, reason: "added" })
    expect(second).toEqual({ changed: false, reason: "already-present" })
    expect(readTuiPlugins(dir)).toEqual([fileEntry])
  })

  it("#given legacy server entry #when legacy TUI entry already exists #then it does not duplicate", () => {
    // given
    const dir = tempConfigDir()
    writeConfig(dir, "opencode.json", { plugin: [LEGACY_PLUGIN_NAME] })
    writeConfig(dir, "tui.json", { plugin: [LEGACY_PLUGIN_NAME] })

    // when
    const result = ensureTuiPluginEntry({ configDir: dir })

    // then
    expect(result).toEqual({ changed: false, reason: "already-present" })
    expect(readTuiPlugins(dir)).toEqual([LEGACY_PLUGIN_NAME])
  })

  it("#given missing or source-only server entry #when ensuring #then it does not write", () => {
    // given
    const missing = tempConfigDir()
    const sourceOnly = tempConfigDir()
    writeConfig(sourceOnly, "opencode.json", { plugin: ["file:///repo/src/index.ts"] })

    // when
    const missingResult = ensureTuiPluginEntry({ configDir: missing })
    const sourceResult = ensureTuiPluginEntry({ configDir: sourceOnly })

    // then
    expect(missingResult).toEqual({ changed: false, reason: "no-server-entry" })
    expect(sourceResult).toEqual({ changed: false, reason: "no-server-entry" })
    expect(existsSync(join(missing, "tui.json"))).toBe(false)
    expect(existsSync(join(sourceOnly, "tui.json"))).toBe(false)
  })

  it("#given malformed TUI config #when ensuring #then it preserves the original file and leaves no temp", () => {
    // given
    const dir = tempConfigDir()
    writeConfig(dir, "opencode.json", { plugin: [PLUGIN_NAME] })
    writeFileSync(join(dir, "tui.json"), "{bad json", "utf-8")

    // when
    const result = ensureTuiPluginEntry({ configDir: dir })

    // then
    expect(result).toEqual({ changed: false, reason: "malformed" })
    expect(readFileSync(join(dir, "tui.json"), "utf-8")).toBe("{bad json")
    expect(existsSync(join(dir, "tui.json.tmp"))).toBe(false)
  })
})

describe("ensureTuiPluginEntry on OpenCode 2.x", () => {
  beforeEach(() => pinVersion("2.0.11"))

  it("#given a 2.x host #when ensuring #then it writes cli.json with a plugins array and the schema", () => {
    // given a 2.x host whose client config already carries unrelated settings
    const dir = tempConfigDir()
    writeConfig(dir, "opencode.json", { plugin: [PLUGIN_NAME] })
    writeConfig(dir, "cli.json", { tabs: { mode: "off" } })

    // when
    const result = ensureTuiPluginEntry({ configDir: dir })

    // then the entry lands in cli.json (not tui.json) and unrelated settings survive
    expect(result).toEqual({ changed: true, reason: "added" })
    const written = readClientConfig(dir)
    expect(written.plugins).toEqual([PLUGIN_NAME])
    expect(written.$schema).toBe("https://opencode.ai/v2/cli.json")
    expect(written.tabs).toEqual({ mode: "off" })
    expect(existsSync(join(dir, "tui.json"))).toBe(false)
  })

  it("#given a 2.x host with the entry present #when ensuring again #then it is idempotent", () => {
    // given
    const dir = tempConfigDir()
    writeConfig(dir, "opencode.json", { plugin: [PLUGIN_NAME] })

    // when
    const first = ensureTuiPluginEntry({ configDir: dir })
    const second = ensureTuiPluginEntry({ configDir: dir })

    // then
    expect(first).toEqual({ changed: true, reason: "added" })
    expect(second).toEqual({ changed: false, reason: "already-present" })
    expect(readClientConfig(dir).plugins).toEqual([PLUGIN_NAME])
  })

  it("#given a 2.x host with a file server entry #when ensuring #then cli.json carries the file entry", () => {
    // given
    const dir = tempConfigDir()
    const fileEntry = writeFilePackage(dir)
    writeConfig(dir, "opencode.json", { plugin: [fileEntry] })

    // when
    const result = ensureTuiPluginEntry({ configDir: dir })

    // then
    expect(result).toEqual({ changed: true, reason: "added" })
    expect(readClientConfig(dir).plugins).toEqual([fileEntry])
    expect(existsSync(join(dir, "tui.json"))).toBe(false)
  })

  it("#given a 2.x host and a malformed cli.json #when ensuring #then the original file is preserved", () => {
    // given
    const dir = tempConfigDir()
    writeConfig(dir, "opencode.json", { plugin: [PLUGIN_NAME] })
    writeFileSync(join(dir, "cli.json"), "{bad json", "utf-8")

    // when
    const result = ensureTuiPluginEntry({ configDir: dir })

    // then
    expect(result).toEqual({ changed: false, reason: "malformed" })
    expect(readFileSync(join(dir, "cli.json"), "utf-8")).toBe("{bad json")
    expect(existsSync(join(dir, "cli.json.tmp"))).toBe(false)
  })
})
