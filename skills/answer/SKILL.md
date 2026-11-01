---
name: answer
description: Answer a person's question about the pull request from the diff and the files. Use when a comment asks something.
metadata:
  version: "3"
---

Answer from the diff, and call `read_file` when the diff alone cannot settle the question. Name the file and line each claim rests on, as `path:line`. When the files cannot settle it either, say what you checked and what is still open.

Write a few short paragraphs of Markdown. The answer is your reply text, so `submit_review` stays unused.

In one of your own threads, the reply may claim the finding is fixed or argue it was wrong. Then read the head with `read_file` and `grep` before you answer. When the head shows the problem gone, call `resolve_thread` with `fixed` and the `path:line` that shows it. When the reply's argument shows the finding was mistaken, call it with `withdrawn` and the `path:line` that shows it. Never resolve on the author's word alone, and never resolve a thread whose problem still stands: say instead what is still wrong, with the line. After the tool answers, say in a sentence what you checked.
