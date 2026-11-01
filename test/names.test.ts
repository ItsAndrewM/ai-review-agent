import { describe, expect, it } from "vitest"
import {
  budgetRefusalMarkerOf,
  closesMarkersOf,
  configFileOf,
  pausedMarkerOf,
  scriptNameOf,
  summaryMarkerOf,
} from "../src/names.ts"

describe("names from the login", () => {
  it("gives andabot today's names, so its earlier comments and config files keep working", () => {
    expect(configFileOf("andabot")).toBe(".andabot.yaml")
    expect(summaryMarkerOf("andabot")).toBe("<!-- andabot:summary -->")
    expect(pausedMarkerOf("andabot")).toBe("<!-- andabot:paused -->")
    expect(closesMarkersOf("andabot")).toEqual({ start: "<!-- andabot:closes -->", end: "<!-- andabot:closes-end -->" })
    expect(budgetRefusalMarkerOf("andabot")).toBe("andabot:review-budget-refused")
    expect(scriptNameOf("andabot", "checkout")).toBe("andabot-checkout")
  })

  it("gives another login its own, so two deploys never share a marker", () => {
    expect(configFileOf("andabot-staging")).toBe(".andabot-staging.yaml")
    expect(summaryMarkerOf("andabot-staging")).toBe("<!-- andabot-staging:summary -->")
    expect(pausedMarkerOf("andabot-staging")).toBe("<!-- andabot-staging:paused -->")
    expect(closesMarkersOf("andabot-staging")).toEqual({
      start: "<!-- andabot-staging:closes -->",
      end: "<!-- andabot-staging:closes-end -->",
    })
    expect(budgetRefusalMarkerOf("andabot-staging")).toBe("andabot-staging:review-budget-refused")
    expect(scriptNameOf("andabot-staging", "run")).toBe("andabot-staging-run")
  })
})
