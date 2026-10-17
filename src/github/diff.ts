/**
 * Unified diff parsing for one purpose: which lines of a pull request can
 * carry a review comment. GitHub accepts a comment on a line that appears
 * in the diff, on the RIGHT side (added or context, numbered in the new
 * file) or the LEFT side (deleted, numbered in the old file).
 */

export type Side = "LEFT" | "RIGHT";

export interface CommentableLines {
  /** New-file line numbers of added and context lines. */
  right: Set<number>;
  /** Old-file line numbers of deleted lines. */
  left: Set<number>;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse the `patch` GitHub returns for one file of a pull request. */
export function commentableLines(patch: string | undefined): CommentableLines {
  const right = new Set<number>();
  const left = new Set<number>();
  if (!patch) return { right, left };
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    const marker = line[0];
    if (marker === "+") {
      right.add(newLine++);
    } else if (marker === "-") {
      left.add(oldLine++);
    } else {
      // context line (" ") or an empty trailing line
      right.add(newLine++);
      oldLine++;
    }
  }
  return { right, left };
}

export interface ChangedFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
  previous_filename?: string;
}

/** Commentable lines for every changed file, keyed by path. */
export function indexCommentableLines(files: readonly ChangedFile[]): Map<string, CommentableLines> {
  const index = new Map<string, CommentableLines>();
  for (const file of files) index.set(file.filename, commentableLines(file.patch));
  return index;
}

/** Renders the changed files as the model reads them: one patch per file, with a header. */
export function renderPatches(files: readonly ChangedFile[], maxCharsPerFile = 40_000): string {
  return files
    .map((file) => {
      const header = `### ${file.filename} (${file.status}, +${file.additions} -${file.deletions})`;
      if (!file.patch) return `${header}\n(no textual diff: binary, too large, or a rename without changes)`;
      const patch =
        file.patch.length > maxCharsPerFile
          ? `${file.patch.slice(0, maxCharsPerFile)}\n... (patch truncated at ${maxCharsPerFile} characters)`
          : file.patch;
      return `${header}\n\`\`\`diff\n${patch}\n\`\`\``;
    })
    .join("\n\n");
}
