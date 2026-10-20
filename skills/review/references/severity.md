# Severity

## blocking

Merging would ship a bug, a security hole, data loss or a departure from what a linked issue requires, including when the wrong result happens only on an error path or an edge input you can name. Blocking needs a `defect` or `spec` basis. The basis shows how merging would ship the problem.

- **The cache key leaves out the user.** `reportCache.get(reportId)` returns whatever the first caller stored. When two users open report 7, the second sees the first user's figures. Key the entry by user and report.
- **A price of 19.99 is charged as 19.98.** `Math.floor(parseFloat(price) * 100)` turns `"19.99"` into 1998 cents, because the product is 1998.9999999999998. Round with `Math.round` instead.
- **Exported dates use the US format.** The linked issue says "Dates in the export are ISO 8601", and `toCsv` writes each date with `toLocaleDateString("en-US")`. Write them with `toISOString()`.

## suggestion

A real improvement the author may decline. The code works as it stands, and the change improves its tests or a design that spans more than a few lines. A `standard` or `test` finding is a suggestion or a nitpick.

- **The address is formatted twice.** `invoice.ts` and `receipt.ts` each join the street, city and postcode with the same six lines. Extract one `formatAddress` and call it from both.
- **No test covers the new `h` unit.** `parseDuration("2h")` is new behaviour, and no test fails if that branch breaks. Add one that expects 7200.

## nitpick

Style, naming and small clean-ups: a few lines read better, and nothing else changes.

- **`getConfig` only forwards.** `function getConfig() { return loadConfig() }` gives one call a second name. Cut it and call `loadConfig()` directly.
- **`d` hides what it holds.** In `const d = end - start`, a name such as `elapsedMs` says what the value is.
