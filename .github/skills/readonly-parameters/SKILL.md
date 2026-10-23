---
name: readonly-parameters
description: "Flag an array parameter typed as mutable when the function never changes it; use when reviewing TypeScript changes that add or change function signatures."
---

A function that takes an array it does not change types that parameter `readonly T[]`, so a caller's array passes without a copy and the signature says the function leaves it alone.

Check each function, method or arrow the diff introduces or changes whose parameter is typed as an array, written `T[]` or `Array<T>`. A parameter the body changes, through `push`, `pop`, `splice`, `sort`, `reverse` or an index assignment, is not a match.

Report each match as a `standard` finding anchored on the line that declares the parameter. Grade it a suggestion or a nitpick, because a blocking `standard` finding is rejected. Its basis names this skill's `SKILL.md` and the rule, as in `readonly-parameters/SKILL.md: an array parameter the function never changes is typed readonly`.

Suggest the `readonly` form. Leave alone a parameter the diff did not introduce or change.
