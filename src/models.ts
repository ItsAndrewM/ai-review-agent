import type { Provider } from "@earendil-works/pi-ai"
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options"

export function withOutputLimit(provider: Provider, limit: number): Provider {
  return {
    ...provider,
    streamSimple: (model, context, options) =>
      provider.streamSimple(model, context, {
        ...options,
        maxTokens: options?.maxTokens ?? clampMaxTokensToContext(model, context, Math.min(model.maxTokens, limit)),
      }),
  }
}
