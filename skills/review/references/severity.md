# Severity

Four grades. A `defect` or `spec` finding is blocking or major; a `standard`, `test` or `docs` finding is a suggestion or a nitpick.

## blocking

Merging would ship a wrong result, data loss, a security hole or a departure from what a linked issue requires, and a user of the change meets it. The basis shows how merging ships the problem.

- **The cache key leaves out the user.** `reportCache.get(reportId)` returns whatever the first caller stored. When two users open report 7, the second sees the first user's figures. Key the entry by user and report.
- **A price of 19.99 is charged as 19.98.** `Math.floor(parseFloat(price) * 100)` turns `"19.99"` into 1998 cents, because the product is 1998.9999999999998. Round with `Math.round` instead.
- **Exported dates use the US format.** The linked issue says "Dates in the export are ISO 8601", and `toCsv` writes each date with `toLocaleDateString("en-US")`. Write them with `toISOString()`.

## major

A real defect worth fixing whose reach is bounded: a wrong log line or cosmetic string, an error path that already fails, an input no caller passes today, a race with a benign outcome. It doesn't block the merge.

- **The summary promises a Details link it has no URL for.** `summaryText` writes "Details opens the summary comment" whether or not `detailsUrl` is set, so a run with no comment points at nothing. Write the sentence only when the URL is there.
- **A backtick in a path breaks the rendered line.** `standardsLine` wraps each path in single backticks, so a path holding one ends the code span early. Use the longer fence `checkLabel` already uses.
- **A stale scope is trusted on a path no review reaches.** `pathFilters` reads the stored scope as if a review were in flight; only `summary` calls it between reviews, with the same filters. Read the filters from the record that owns them.

## suggestion

A real improvement the author may decline. The code works as it stands, and the change improves its tests or a design that spans more than a few lines.

- **The address is formatted twice.** `invoice.ts` and `receipt.ts` each join the street, city and postcode with the same six lines. Extract one `formatAddress` and call it from both.
- **No test covers the new `h` unit.** `parseDuration("2h")` is new behaviour, and no test fails if that branch breaks. Add one that expects 7200.
- **The design doc says the snapshot is dropped when the review ends.** `docs/design.md:112` says so, and `dropSnapshot` in `src/repository/snapshot-host.ts:40` now waits for the last answer too. Say so in the doc.

## nitpick

Style, naming and small clean-ups: a few lines read better, and nothing else changes.

- **`getConfig` only forwards.** `function getConfig() { return loadConfig() }` gives one call a second name. Cut it and call `loadConfig()` directly.
- **`d` hides what it holds.** In `const d = end - start`, a name such as `elapsedMs` says what the value is.
- **The README names `grepFiles`.** `README.md:40` still calls the tool `grepFiles`; `src/review/tools.ts:190` renamed it `grep`. Update the name.
