/**
 * Gives every Pi request an output limit.
 *
 * Pi Durable leaves the limit to pi-ai (its stream settings have no
 * `maxTokens`), and pi-ai's own adapters default it to the model's
 * `maxTokens`, clamped to the context left. The Agents SDK's Cloudflare
 * provider (agents 0.28.1) skips that default and sends `max_tokens` to
 * Workers AI only when the caller passes one, so Workers AI stops at its own
 * default of 256 output tokens, often before a reasoning model reaches its
 * tool call. This applies pi-ai's default on the way in.
 */

import type { Provider } from "@earendil-works/pi-ai"
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options"

export function withOutputLimit(provider: Provider): Provider {
  return {
    ...provider,
    streamSimple: (model, context, options) =>
      provider.streamSimple(model, context, {
        ...options,
        maxTokens: options?.maxTokens ?? clampMaxTokensToContext(model, context, model.maxTokens),
      }),
  }
}
