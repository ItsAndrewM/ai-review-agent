---
name: dual
description: "Flag a helper exported from a module that only one file imports; use when reviewing TypeScript changes that add exports."
---

An exported helper with a single importer belongs beside that importer until a second one needs it.

Report each match as a `standard` finding, graded a suggestion or a nitpick, whose basis names this skill's `SKILL.md` and the rule.