import { describe, expect, it } from "vitest"
import { killArgv, parseResult, runArgv, tailBytesOf } from "../src/sandbox/run.ts"

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
    const result = parseResult(new Uint8Array([...bytes("0\n4\n"), ...euro.slice(1)]), 3)
    expect(result.outcome).toBe("exited")
    expect(result.tail).toContain("�")
    expect(result.cut).toBe(true)
  })

  it("keeps the decoded tail within the byte limit when replacement characters inflate it", () => {
    const invalid = new Uint8Array(10).fill(0xff)
    const result = parseResult(new Uint8Array([...bytes("0\n10\n"), ...invalid]), 10)
    expect(result.outcome).toBe("exited")
    expect(new TextEncoder().encode(result.tail).length).toBeLessThanOrEqual(10)
    expect(result.tail).toContain("�")
    expect(result.cut).toBe(true)
  })

  it("keeps the decoded tail within the byte limit for every run of invalid bytes and every small cap", () => {
    const encoder = new TextEncoder()
    for (let length = 1; length <= 40; length += 1) {
      for (let cap = 1; cap <= 12; cap += 1) {
        const invalid = new Uint8Array(length).fill(0xff)
        const result = parseResult(new Uint8Array([...bytes(`0\n${length}\n`), ...invalid]), cap)
        expect(encoder.encode(result.tail).length, `length ${length} cap ${cap}`).toBeLessThanOrEqual(cap)
      }
    }
  })

  it("reads an empty output", () => {
    expect(parseResult(bytes("0\n0\n"), 8192)).toEqual({ outcome: "exited", exitCode: 0, tail: "", cut: false })
  })

  it("throws on a result it can't read, so a dead sandbox never reports a clean pass", () => {
    expect(() => parseResult(new Uint8Array(), 8192)).toThrow("unreadable")
    expect(() => parseResult(bytes("\n0\n"), 8192)).toThrow("unreadable")
    expect(() => parseResult(bytes("0x10\n0\n"), 8192)).toThrow("unreadable")
    expect(() => parseResult(bytes(" 0\n0\n"), 8192)).toThrow("unreadable")
  })
})

describe("killArgv", () => {
  it("sends the named signal to the run's process group in the -s form dash accepts before a negative pid, and nothing when the run never started", () => {
    const term = killArgv("/workspace/runs/a", "TERM")[2] ?? ""
    expect(term).toContain('kill -s TERM -- "-$pid"')
    expect(term).not.toContain("kill -TERM")
    expect(term).toContain('[ -f "$1/pid" ] || exit 0')
    expect(killArgv("/workspace/runs/a", "KILL")[2]).toContain('kill -s KILL -- "-$pid"')
  })
})
