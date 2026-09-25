# Control damage Inventory Transfer editor

Authorization: user requested reviewing/editing damage ITs in Control and explicitly selected adding/removing lines as well as SKU, quantity, UOM and reason changes. Additional spec review not obtained (autonomous run).

Acceptance scenarios:

- Managers see only their assigned yards; admins see all four. Operators alone cannot use Control reads or writes. Month/yard filters show the matching NetSuite damage transfer, all its lines, linked report photos, posting errors and adjustment history.
- Edit SKU, positive quantity, valid NetSuite UOM, and R1–R5 reason; add and remove lines; preview the resulting lines and save with a required adjustment note. The monthly source/destination, date/memo identity and IT number stay fixed. At least one line remains.
- New Control lines are clearly identified as management adjustments. Existing operator reports and photos remain retained even when their transferred quantity/SKU changes or their line is removed.
- A single accepted adjustment changes the same NetSuite IT. Updating uses keyed lines; removal uses `replace=inventory`, retaining every other existing line by its key. Added lines carry unique descriptions within NetSuite's 40-character limit.
- Saves require the version that was reviewed, fresh item/UOM validation and a fresh NetSuite read under the same monthly lock as operator posting. Stale edits are rejected before writing. Multiple app writers cannot overwrite each other's changes.
- A request UUID is immutable/idempotent. A lost response is reconciled from the desired keyed line values and unique added-line markers; ambiguous writes never blindly resend. Persisted adjustment status/error/retry and before/after/actor/note survive restarts.
- The operator's monthly review reflects the current NetSuite item, quantity, unit and reason and identifies removed/adjusted lines while preserving the original submitted values and photos.
- Existing damage submission, Count Sheets, calculator, Receiving and Control behavior remain intact. No demonstration stock movements will be made; only the user's existing rejected report is recovered separately.

Failure model: unauthorized yard edits (HTTP/repository tests); invalid quantities/UOM or foreign line keys (domain/property/adapter tests); lost manual lines during replacement (contract tests); stale snapshots and races with operator posting (database concurrency tests); timeout after accepted update (fault injection and recheck tests); duplicate additions after retry (unique-marker tests); history/photo loss (retention assertions); incorrect UI status or stale draft (browser execution).

Setup: existing Node/Docker/Postgres, Playwright, fast-check, c8, eslint and TypeScript. No new dependency or git commit. Add a durable adjustment table/migration, focused service/domain/router/UI tests, scoped deployment script, and reproducible verification/evidence. Preserve unrelated workspace changes. External concurrent NetSuite users are checked immediately before writing; no unsupported conditional-write API will be assumed.

Oracle references: [Inventory Transfer](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_0817112542.html), [Working with Sublists](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/chapter_1545142407.html), [Unit of Measure](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_63210224348.html).

Permission amendment (user questioned extra Units permission): the editor must
work with the existing Item and Inventory Transfer access. Unit choices come
from the selected item's configured sales and stock units. An existing transfer
line may retain its current unit even if that unit is no longer one of the item
defaults. Do not request the Units list or enumerate all units types. Quantity is
entered directly in the chosen NetSuite unit, so no UOM conversion rate is needed.
This supersedes the earlier full units-type lookup contract, not its validation
or authorization requirements.
