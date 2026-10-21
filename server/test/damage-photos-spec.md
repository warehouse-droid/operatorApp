# Damage stock photo links and download

Authorization: the user asked why IT00571's saved photo was absent from its line,
then requested one-click download of every image on `/control/damage-stock`
with correct line names. Spec approval: not obtained (autonomous run).
Tier 2: read-only photo association and a browser download. Posting, stock
movements, saved report status, photo authorization and database schema stay
unchanged.

Acceptance scenarios:

- P1: IT00571-style readback has a normal item description and one exact line
  matching an uncertain saved report's transfer, SKU, quantity, UOM and reason.
  Show its saved photos on that line without changing the persisted report,
  retry flag, audit history or NetSuite record.
- P2: recover only a unique report-to-line match. Duplicate matching lines,
  duplicate reports, foreign transfers, known different report/Control markers,
  already claimed lines, and reports safe to retry cannot inherit photos.
  Existing explicit marker and posted-line associations keep their behavior.
- Z1: one button downloads all original photos for the selected yard and month
  into one ZIP. Each reference occurs once, including reports retained after
  removal or awaiting reconciliation. Use saved transfer data rather than edits
  in an unsaved draft.
- Z2: attached names are `IT00571_line-001_UNI-PISAS-COP-SAFARI_photo-01.jpg`.
  Preserve actual line keys and image formats. Unmatched/removed reports are
  named with their report identity/status instead of inventing a current line.
  Names cannot contain paths; duplicate names remain distinct.
- Z3: fetch original images through the existing authenticated photo preview
  endpoint. Empty, failed, or non-image responses produce a visible error and
  no incomplete ZIP. Progress is visible; an empty review disables download.
- Z4: the ZIP opens with standard readers and retains exact bytes and CRCs,
  including Unicode filenames and several photos per line. No new dependency.
- R1: existing Damage Stock edits, adjustments, report history, yard scope and
  photo permissions still pass their tests. No production stock write is part
  of validation. Preserve unrelated workspace and deployed changes.

Setup: existing Node/PostgreSQL/Playwright/c8/ESLint/TypeScript/fast-check in a
dedicated isolated test container and database, with NetSuite disabled. Add
focused tests, a reproducible check script and evidence. No new packages, git
commit, migration or credential export. Release only the changed files over
the current production image, with source/configuration checks and rollback.

Failure model: wrong photograph association (ambiguity and hostile-value
tests), unsafe ZIP paths/collisions (property and round-trip tests), missing
photos (all-or-error browser test), stale draft names (browser test), and
regressions (baseline/full suite comparison and existing feature suites).

Scope addition: the user also reported unusually slow `/damage-stock` loading.
- S1: load the yard directory and source-yard transfer list concurrently. Fetch
  matching complete records in bounded parallel batches, still validating memo
  month, source, destination and complete line coverage.
- S2: include unit labels in the transfer-list query and reuse those labels for
  that exact returned record. Direct record reads and incomplete label sets keep
  the existing unit lookup. No stale transfer cache or stock-write change.
- S3: compare read-only timing for the live IT00571 review before/after. Record
  NetSuite latency as measured, without promising a fixed external response time.
- Z5: the download button and photo grid fit a 390-pixel viewport with the
  existing sidebar open, without horizontal scrolling.

Live-query correction: Inventory Transfer header location fields are empty in
SuiteQL, despite the REST source location. The source-yard filter must use the
transfer's `mainline='T'` transaction line (confirmed as yard 1 for IT00571).
The initial header-filter query returned zero rows and will not be released.

Performance design correction: the mainline/unit join took 96.2 seconds in a
live read and is rejected. Replace S1/S2's query design with a small month-only
transfer-ID lookup, run the directory check while the REST records load, and
validate exact source/destination on those complete records. Reuse labels from
saved reports when all current units are known; otherwise retain the live unit
query. All ambiguity, completeness and posting rules remain in force.

Live queue correction: Control's review route did not enter the existing
foreground NetSuite request context. During background syncs, this serializes
and delays even independent review reads. S4: apply the existing priority
middleware only to GET `/review`, keep role/yard validation, and retain the
shared four-request limit. A real HTTP test must observe foreground context in
both transfer and fallback unit reads. Existing priority-queue tests must keep
their bounded-concurrency and background-progress assertions.
