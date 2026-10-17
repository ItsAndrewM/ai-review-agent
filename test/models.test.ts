import { describe, expect, it } from "vitest";
import type { Provider } from "@earendil-works/pi-ai";
import { withOutputLimit } from "../src/models.ts";

function stubProvider(record: (options: unknown) => void): Provider {
  return {
    id: "cloudflare",
    name: "Cloudflare",
    auth: { apiKey: { name: "x", resolve: async () => ({ auth: {} }) } },
    getModels: () => [],
    stream: () => ({}) as never,
    streamSimple: (_model: unknown, _context: unknown, options: unknown) => {
      record(options);
      return {} as never;
    }
  } as unknown as Provider;
}

const model = { api: "cloudflare-ai", provider: "cloudflare", id: "@cf/openai/gpt-oss-120b", contextWindow: 128_000, maxTokens: 16_000 } as never;
const context = { messages: [] } as never;

describe("withOutputLimit", () => {
  it("adds the model's output cap when the caller passed none", () => {
    let seen: Record<string, unknown> | undefined;
    withOutputLimit(stubProvider((o) => (seen = o as Record<string, unknown>))).streamSimple(model, context);
    expect(seen?.maxTokens).toBe(16_000);
  });

  it("keeps an explicit output cap the caller passed", () => {
    let seen: Record<string, unknown> | undefined;
    withOutputLimit(stubProvider((o) => (seen = o as Record<string, unknown>))).streamSimple(model, context, { maxTokens: 500 } as never);
    expect(seen?.maxTokens).toBe(500);
  });

  it("leaves the provider's other members in place", () => {
    const wrapped = withOutputLimit(stubProvider(() => {}));
    expect(wrapped.id).toBe("cloudflare");
    expect(wrapped.name).toBe("Cloudflare");
  });
});
