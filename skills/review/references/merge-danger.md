# Merge danger

Describe whether it's a one-way or two-way door. You can walk back through two-way doors, but not one-way doors. A PR that is cheap to roll back is lower risk. Changes that involve destructive actions or hard-to-reverse decisions are one-way doors.

The blast radius is the potential impact or scope of the changes introduced by this PR. Consider all possibilities. Examples are layout shift, breakages for consumers, mobile responsiveness, etc.

| Change | Door | Blast radius |
| --- | --- | --- |
| A migration drops the `notes` column | one-way: once it runs, the notes are gone | every reader of notes |
| Saved records switch to a new format | one-way: after a revert, the old code cannot read what the new code wrote | every reader of those records |
| A function splits in two inside one module, its tests passing | two-way: revert the commit | that module's callers |
| A new code path ships behind a flag that is off | two-way: leave the flag off | nothing until the flag turns on |
