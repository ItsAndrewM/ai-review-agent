---
name: answer
description: Answer a person's question about the pull request from the diff and the files. Use when a comment asks something.
metadata:
  version: "1"
---

Answer from the diff, and call `read_file` when the diff alone cannot settle the question. Name the file and line each claim rests on, as `path:line`. When the files cannot settle it either, say what you checked and what is still open.

Write a few short paragraphs of Markdown. The answer is your reply text, so `submit_review` stays unused.
