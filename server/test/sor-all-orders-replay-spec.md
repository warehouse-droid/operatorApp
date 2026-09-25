# All stored SOR orders: isolated replay

Authorized by the request to replay all SOR orders; spec review not separately obtained (autonomous run).

- Capture all 137 stored SOR headers and their 365 lines, item policies, existing returns, split/group definitions, assignments and recorded SOR execution in one read-only database snapshot. Report snapshot counts/hash and any omitted context.
- Import the fixture into a disposable database on an internal Docker network. No production credentials or external write credentials; no live changes or NetSuite posting. Use the exact currently deployed source with catalog mode explicitly `on`.
- Drain every SOR reference through the real Admin-triggered worker and real catalog executor. Force both to contend for the fleet lock, and confirm that staff bootstrap/login remain responsive throughout.
- Repeat ordinary updates of existing headers and lines with no new order, then drain all references again. Return identities/content must remain stable, with no duplicate returns or unexpected review flags. Verify the paused gate leaves queued work untouched.
- Execute the same forced overlap with the pre-fix worker: it must fail with the original lock cycle. Preserve the failing and passing reports, source hashes and a reproducible runner.
- This verifies the captured order state and deterministic lock contention. It cannot prove every future source change, external outage, or unrepresented production workload safe.

Setup: existing PostgreSQL 18 and Playwright image; no new dependencies or git commits. Snapshot is a private ignored local artifact; application code remains unchanged by this replay.

Replay finding and scope extension: the full snapshot exposes 14 CUSTOM rental returns incorrectly stored with definition_kind=split. The worker drops the delivery parent and cancels its return. Add regression constraints before repairing: a return is a derived collection, not a delivery split; legacy malformed definitions cannot suppress the source draft; genuine SO -S1 splits retain their exact quantities. Repair only these SOR return definitions, retain their IDs/assignments/status, and keep the live gate off. After replay, all initially open valid returns must remain open; no new review flags or duplicates.
# Planning and Driver PWA extension

User additionally requires delivery and return orders to be plannable and completable in the normal Driver PWA. For every eligible rental source, save and confirm a real plan, verify pickup at 3445 Kennedy Road and reversed return stops with identical rental contents, and complete pickup/dropoff using the actual mobile browser, photo uploads, optional delivery signature and completion APIs. A collection before its delivery must be rejected; after delivery it must work. User explicitly authorizes dummy addresses for SOR00030, SOR00085, SOR00183 and SOR00185 in the isolated fixture only; test SOR00030 as Delivery. Report those substitutions. Preserve the live gate off and do not modify live order addresses or create live return orders.
# Planning replay finding

The first complete HTTP save/confirm replay saved the plan but rejected confirmation: old return definitions inherited the source Delivery's `Rental` pickup, so authoritative projection inserted an extra SCM-managed pickup. Preserve canonical custom-return address/cargo over old global delivery projections; source refresh must not copy delivery fields into a rental collection. Genuine sales splits must still refresh. Record failing full replay and focused tests before the fix.
