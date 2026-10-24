---
name: linked-rules
description: "Flag a function that returns the array it was given; use when reviewing TypeScript changes."
---

A function that returns the array a caller passed in lets the caller's later changes leak into the result.

Report each match as a `standard` finding, graded a suggestion or a nitpick, whose basis names this skill's `SKILL.md` and the rule.