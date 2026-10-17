import { describe, expect, it } from "vitest";
import { isOlder, versionOf } from "../src/version.ts";

describe("versionOf", () => {
  it("reads id and timestamp, and tolerates a missing binding", () => {
    expect(versionOf({ id: "v1", timestamp: "2026-10-17T15:00:00Z" })).toEqual({ id: "v1", timestamp: "2026-10-17T15:00:00Z" });
    expect(versionOf(undefined)).toEqual({ id: "", timestamp: "" });
  });
});

describe("isOlder", () => {
  const a = { id: "a", timestamp: "2026-10-17T15:31:50Z" };
  const b = { id: "b", timestamp: "2026-10-17T15:35:52Z" };

  it("is true only when own is a different, earlier build than the caller", () => {
    expect(isOlder(a, b)).toBe(true);
    expect(isOlder(b, a)).toBe(false);
  });

  it("is false for the same build, no caller, or unparseable timestamps", () => {
    expect(isOlder(a, a)).toBe(false);
    expect(isOlder(a, undefined)).toBe(false);
    expect(isOlder({ id: "a", timestamp: "" }, b)).toBe(false);
    expect(isOlder(a, { id: "b", timestamp: "" })).toBe(false);
  });
});
