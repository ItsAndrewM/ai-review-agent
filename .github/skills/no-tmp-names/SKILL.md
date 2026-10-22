---
name: no-tmp-names
description: "Flag identifiers whose name contains the word tmp; use when reviewing TypeScript changes."
---

An identifier containing `tmp`, as in `tmpValue` or `tmp_count`, names its lifetime instead of its meaning: it says the value is short-lived, not what it holds.

Check each identifier the diff introduces, whether a variable, parameter, function, property or type. Match the letters `tmp` together, in any case, anywhere in the name. A name such as `temperature` is not a match.

Report each match as a `standard` finding anchored on the line that introduces the identifier. Grade it a suggestion or a nitpick, because a blocking `standard` finding is rejected. Its basis names this skill's `SKILL.md` and the rule, as in `no-tmp-names/SKILL.md: an identifier containing tmp names its lifetime instead of its meaning`.

Suggest a name for what the value holds. Leave alone an identifier the diff did not introduce.
