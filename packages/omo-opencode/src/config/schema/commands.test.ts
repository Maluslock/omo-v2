// packages/omo-opencode/src/config/schema/commands.test.ts
import { describe, expect, it } from "bun:test"
import { loadBuiltinCommands } from "../../features/builtin-commands/commands"
import { BuiltinCommandNameSchema } from "./commands"

describe("BuiltinCommandNameSchema", () => {
  it("accepts exactly the built-in commands that actually ship", () => {
    // given the shipped command definitions and the config enum
    const shipped = Object.keys(loadBuiltinCommands()).sort()
    const accepted = [...BuiltinCommandNameSchema.options].sort()

    // then drift in either direction fails here instead of silently at config load time
    expect(accepted).toEqual(shipped)
  })

  it("accepts handoff, whose absence used to discard the whole disabled_commands list", () => {
    // given a config that disables handoff / when the value is parsed by the enum
    // then it survives instead of collapsing the array to []
    expect(BuiltinCommandNameSchema.safeParse("handoff").success).toBe(true)
  })
})
