import { z } from "zod"

// Keep in sync with `features/builtin-commands/types.ts` (BuiltinCommandName). A name present there
// but missing here is not merely rejected: Zod drops the WHOLE `disabled_commands` array, so a user
// who lists that one name silently gets nothing disabled. `commands.test.ts` pins the two lists.
export const BuiltinCommandNameSchema = z.enum([
 "goal",
 "refactor",
 "start-work",
 "stop-continuation",
 "handoff",
 "remove-ai-slops",
 "hyperplan",
])

export type BuiltinCommandName = z.infer<typeof BuiltinCommandNameSchema>
