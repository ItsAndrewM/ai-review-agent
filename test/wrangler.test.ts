import { describe, expect, it } from "vitest"
import { unstable_readConfig } from "wrangler"

type Vars = ReturnType<typeof unstable_readConfig>["vars"]

const NAMED_PER_DEPLOY = new Set(["BOT_LOGIN", "AUTO_REVIEW"])

const sharedVars = (vars: Vars) => Object.entries(vars).filter(([name]) => !NAMED_PER_DEPLOY.has(name))

const production = unstable_readConfig({ config: "wrangler.jsonc" })
const staging = unstable_readConfig({ config: "wrangler.jsonc", env: "staging" })

describe("the staging deploy", () => {
  it("is andabot-staging, reviewing only when tagged", () => {
    expect(staging.name).toBe("andabot-staging")
    expect(staging.vars.BOT_LOGIN).toBe("andabot-staging")
    expect(staging.vars.AUTO_REVIEW).toBe("false")
  })

  it("leaves production as andabot, reviewing on its own", () => {
    expect(production.name).toBe("andabot")
    expect(production.vars.BOT_LOGIN).toBe("andabot")
    expect(production.vars.AUTO_REVIEW).toBe("true")
  })

  it("matches production's vars but for the name and AUTO_REVIEW, so the two can't drift apart", () => {
    expect(sharedVars(staging.vars)).toEqual(sharedVars(production.vars))
    expect(Object.keys(staging.vars).sort()).toEqual(Object.keys(production.vars).sort())
  })

  it("has its own objects, container and bindings", () => {
    expect(staging.durable_objects.bindings).toEqual(production.durable_objects.bindings)
    expect(staging.containers).toMatchObject([{ class_name: "ReviewSandbox", scheduling_policy: "durable_object" }])
    expect(staging.ai?.binding).toBe("AI")
    expect(staging.version_metadata?.binding).toBe("CF_VERSION_METADATA")
  })
})
