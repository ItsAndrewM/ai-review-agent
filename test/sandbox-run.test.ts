import { describe, expect, it } from "vitest"
import { parseResult, runArgv, tailBytesOf } from "../src/sandbox/run.ts"

const bytes = (text: string) => new TextEncoder().encode(text)

describe("runArgv", () => {
  it("runs the command under the wrapper with the dir first", () => {
    const argv = runArgv("/workspace/runs/a", ["node", "--version"])
    expect(argv.slice(0, 2)).toEqual(["/bin/sh", "-c"])
    expect(argv.slice(3)).toEqual(["andabot-run", "/workspace/runs/a", "node", "--version"])
  })

  it("puts the command in its own process group and records the exit code atomically", () => {
    const script = runArgv("/workspace/runs/a", ["true"])[2] ?? ""
    expect(script).toContain("setsid")
    expect(script).toContain('"$dir/exit-code.tmp"')
    expect(script).toContain('mv "$dir/exit-code.tmp" "$dir/exit-code"')
  })
})

describe("tailBytesOf", () => {
  it("defaults to 8 KiB", () => {
    expect(tailBytesOf(undefined)).toBe(8192)
  })

  it("caps at Pi Durable's 50 KiB tool-result cap", () => {
    expect(tailBytesOf(100_000)).toBe(51_200)
  })

  it("ignores a non-positive or fractional request", () => {
    expect(tailBytesOf(0)).toBe(8192)
    expect(tailBytesOf(-1)).toBe(8192)
    expect(tailBytesOf(1.5)).toBe(8192)
  })
})

describe("parseResult", () => {
  it("reads an exit code, the size and the tail", () => {
    expect(parseResult(bytes("0\n5\nhello"), 8192)).toEqual({
      outcome: "exited",
      exitCode: 0,
      tail: "hello",
      cut: false,
    })
  })

  it("marks the tail cut when the output is larger than the tail", () => {
    expect(parseResult(bytes("1\n20000\nend"), 8192)).toEqual({
      outcome: "exited",
      exitCode: 1,
      tail: "end",
      cut: true,
    })
  })

  it("reads a missing exit code as a timeout", () => {
    expect(parseResult(bytes("none\n3\nabc"), 8192)).toEqual({ outcome: "timeout", tail: "abc", cut: false })
  })

  it("decodes a tail cut mid-character with a replacement character rather than throwing", () => {
    const euro = bytes("€")
    const result = parseResult(new Uint8Array([...bytes("0\n4\n"), ...euro.slice(1)]), 2)
    expect(result.outcome).toBe("exited")
    expect(result.tail).toContain("�")
    expect(result.cut).toBe(true)
  })

  it("reads an empty output", () => {
    expect(parseResult(bytes("0\n0\n"), 8192)).toEqual({ outcome: "exited", exitCode: 0, tail: "", cut: false })
  })
})
