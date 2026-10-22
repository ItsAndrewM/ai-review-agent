import { Value } from "typebox/value"
import {
  isLeftOutReason,
  SnapshotRecord,
  type LeftOut,
  type LeftOutReason,
  type SnapshotFile,
  type SnapshotFiles,
} from "./snapshot.ts"

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS snapshot_files (path TEXT PRIMARY KEY, content TEXT)",
  "CREATE TABLE IF NOT EXISTS snapshot_left_out (path TEXT PRIMARY KEY, reason TEXT)",
  "CREATE TABLE IF NOT EXISTS snapshot_meta (id INTEGER PRIMARY KEY CHECK (id = 1), record TEXT)",
]

const TABLES = ["snapshot_files", "snapshot_left_out", "snapshot_meta"]

function parseRecord(text: string): SnapshotRecord | undefined {
  try {
    const parsed = JSON.parse(text)
    return Value.Check(SnapshotRecord, parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export class SqlSnapshotFiles implements SnapshotFiles {
  constructor(private readonly sql: SqlStorage) {
    for (const statement of SCHEMA) {
      sql.exec(statement)
    }
  }

  begin(_sha: string): void {
    this.clear()
  }

  add(files: readonly SnapshotFile[]): void {
    for (const file of files) {
      this.sql.exec("INSERT OR REPLACE INTO snapshot_files (path, content) VALUES (?, ?)", file.path, file.content)
    }
  }

  leaveOut(entries: readonly LeftOut[]): void {
    for (const entry of entries) {
      this.sql.exec("INSERT OR REPLACE INTO snapshot_left_out (path, reason) VALUES (?, ?)", entry.path, entry.reason)
    }
  }

  finish(record: SnapshotRecord): void {
    this.sql.exec("INSERT OR REPLACE INTO snapshot_meta (id, record) VALUES (1, ?)", JSON.stringify(record))
  }

  record(): SnapshotRecord | undefined {
    const rows = this.sql.exec<{ record: string }>("SELECT record FROM snapshot_meta WHERE id = 1").toArray()
    const row = rows[0]
    return row === undefined ? undefined : parseRecord(row.record)
  }

  read(path: string): string | undefined {
    const rows = this.sql.exec<{ content: string }>("SELECT content FROM snapshot_files WHERE path = ?", path).toArray()
    return rows[0]?.content
  }

  reasonFor(path: string): LeftOutReason | undefined {
    const rows = this.sql
      .exec<{ reason: string }>("SELECT reason FROM snapshot_left_out WHERE path = ?", path)
      .toArray()
    const reason = rows[0]?.reason
    return reason !== undefined && isLeftOutReason(reason) ? reason : undefined
  }

  *files(): Iterable<SnapshotFile> {
    yield* this.sql.exec<{ path: string; content: string }>("SELECT path, content FROM snapshot_files ORDER BY path")
  }

  *leftOut(): Iterable<LeftOut> {
    const rows = this.sql.exec<{ path: string; reason: string }>(
      "SELECT path, reason FROM snapshot_left_out ORDER BY path",
    )
    for (const row of rows) {
      if (isLeftOutReason(row.reason)) {
        yield { path: row.path, reason: row.reason }
      }
    }
  }

  has(path: string): boolean {
    return this.sql.exec("SELECT 1 FROM snapshot_files WHERE path = ?", path).toArray().length > 0
  }

  drop(): boolean {
    const hadAnything = TABLES.some((table) => this.sql.exec(`SELECT 1 FROM ${table} LIMIT 1`).toArray().length > 0)
    this.clear()
    return hadAnything
  }

  private clear(): void {
    for (const table of TABLES) {
      this.sql.exec(`DELETE FROM ${table}`)
    }
  }
}
