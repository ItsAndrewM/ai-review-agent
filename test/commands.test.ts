import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/commands.ts";

describe("parseCommand", () => {
  it("finds the mention anywhere and reads the command after it", () => {
    expect(parseCommand("@andabot review", "andabot")).toEqual({ kind: "review", full: false });
    expect(parseCommand("Please @AndaBot Full Review", "andabot")).toEqual({ kind: "review", full: true });
    expect(parseCommand("@andabot", "andabot")).toEqual({ kind: "review", full: false });
    expect(parseCommand("@andabot help", "andabot")).toEqual({ kind: "help" });
    expect(parseCommand("@andabot why is this blocking?", "andabot")).toEqual({ kind: "chat", text: "why is this blocking?" });
  });

  it("ignores comments without the mention, and other logins that share a prefix", () => {
    expect(parseCommand("looks good", "andabot")).toBeUndefined();
    expect(parseCommand("@andabot-review help", "andabot")).toBeUndefined();
    expect(parseCommand("mail@andabot.dev", "andabot")).toBeUndefined();
  });
});
