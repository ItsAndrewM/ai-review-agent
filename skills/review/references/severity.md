# Severity

## blocking

Merging would ship a bug, a security hole or data loss, including when the wrong result happens only on an error path or an edge input you can name. The finding's failure scenario shows how.

- **The cache key leaves out the user.** `reportCache.get(reportId)` returns whatever the first caller stored. When two users open report 7, the second sees the first user's figures. Key the entry by user and report.
- **A price of 19.99 is charged as 19.98.** `Math.floor(parseFloat(price) * 100)` turns `"19.99"` into 1998 cents, because the product is 1998.9999999999998. Round with `Math.round` instead.

## suggestion

A real improvement the author may decline. The code works as it stands, and the change improves its speed, its tests, or a design that spans more than a few lines.

- **Read the template once.** `renderInvoice` reads `invoice.html` from disk on every call. Reading it once at startup saves a disk read per invoice.
- **No test covers the new `h` unit.** `parseDuration("2h")` is new behaviour, and no test fails if that branch breaks. Add one that expects 7200.

## nitpick

Style, naming and small clean-ups: a few lines read better, and nothing else changes.

- **Avoid magic numbers for JWT timestamps.** The `iat` and `exp` lines use hard-coded offsets of 60 seconds and 9 minutes. Named constants would read better, and the code is correct either way.
- **`d` hides what it holds.** In `const d = end - start`, a name such as `elapsedMs` says what the value is.
