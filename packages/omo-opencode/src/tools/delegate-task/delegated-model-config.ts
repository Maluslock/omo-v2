import type { CategoryConfig } from "../../config/schema"
import type { DelegatedModelConfig } from "./types"

export function applyCategoryParams(
  base: DelegatedModelConfig,
  config: CategoryConfig | undefined,
): DelegatedModelConfig {
  if (!config) {
    return base
  }

  return {
    ...base,
    ...(config.reasoning !== undefined
      ? { reasoning: config.reasoning }
      : config.reasoningEffort !== undefined
        ? { reasoningEffort: config.reasoningEffort }
        : {}),
    ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
    ...(config.top_p !== undefined ? { top_p: config.top_p } : {}),
    // `CategoryConfigSchema` documents `max_tokens` and keeps `maxTokens` only as a deprecated
    // alias; reading the deprecated key alone meant a user's `max_tokens` never reached the
    // delegated model. Same documented-first precedence as reasoning above.
    ...(config.max_tokens !== undefined
      ? { maxTokens: config.max_tokens }
      : config.maxTokens !== undefined
        ? { maxTokens: config.maxTokens }
        : {}),
    ...(config.thinking !== undefined ? { thinking: config.thinking } : {}),
    ...(config.tools !== undefined ? { tools: config.tools } : {}),
  }
}
