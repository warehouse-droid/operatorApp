# Stock exchange acceptance specification

Spec approval: not obtained (autonomous run). Tier 3: inventory, concurrency,
and external posting. Existing uncommitted work is preserved; no checkpoint
commits or new dependencies are planned.

1. Return offers Pallet Return, Stock Return, and Stock exchange. Exchange uses
   the stock editor, fixed to Quality Issue (R1–R5), with per-reason photos.
   Draft save/resume, review, history and management distinguish exchanges.
2. Server rejects normal/GD exchanges, missing quality photos, unsupported yards,
   empty exchanges and mixed pallet/exchange submissions before posting.
3. Stock returns and exchanges reserve the same fulfilled SO-line quantity.
   Concurrent requests cannot exceed it. Posted exchanges continue consuming it.
   Drafts reserve nothing; voiding an unposted exchange releases its reservation.
4. Exchanges never create a Return Authorization or Credit Memo. A dedicated
   per-yard Inventory Transfer gate controls posting using the existing reviewed
   policy contract. Existing return behavior and gates remain intact.
5. One Inventory Transfer per receiving yard and Toronto calendar month. Exact
   memo: `3445 2026 Oct Exchange` (also 2967 and 150). Transfer from the main
   yard to its active Return child location. Append exact exchange quantities,
   sales units and `custcol_atlas_rc_so` reasons without replacing existing lines.
6. SO number goes in a text field named Original SO Line. Read-only metadata on
   2026-10-29 identifies `custcolcustcol_pick_original_line` as boolean. Posting
   must not put SO text in that checkbox. Await the user's field clarification;
   validate the actual schema before writing. No speculative field IDs.
7. Serialize monthly writes; durable pre-write checkpoints prevent duplicate
   creation/appends after timeouts or local rollback. Verify the complete remote
   record, destinations, month and every added line before marking success.
   Uncertain writes block new monthly writes and local voids until reconciled.
8. Invalid/multiple monthly matches, edited or incomplete readback, bad units,
   invalid destinations and unavailable field mapping fail with a visible error.

Failure model: over-return (database race tests), duplicate inventory movement
(lost-response and repeat tests), lost existing lines (append contract tests),
wrong yard/month/unit/reason (domain/property and remote readback tests), malformed
requests (adversarial tests), accidental credit posting (regression suite and
transport assertions), migration damage (fresh isolated migrations and rerun).

Setup: existing Node test runner, fast-check, ESLint, TypeScript, c8 and Playwright
where applicable. Add migration, exchange domain/adapter/service, focused tests,
bounded validation runner and concise evidence. All execution uses the existing
mbbs-tests.slice budget and retention wrapper; temporary files, coverage,
containers, volumes and networks are removed in teardown. Production reads are
limited to metadata/location inspection and health; no test NetSuite writes.

Amendment 2026-10-29: user selected Position for the SO number. Read-only
Inventory Transfer metadata confirms `custcol_position` is a string and
`custcol_atlas_rc_so` is a record reference. Criterion 6 now uses Position,
with the exact SO number as its value; the Original SO Line checkbox is untouched.

HTTP contract clarification: successful creation returns the existing endpoint's
201 Created status; replay uses 200. The first HTTP test expected 200 for a new
record and was corrected to 201 after reading the unchanged route contract.

Validation amendment: the exact admin gate inventories include the three new
exchange IT gates. Monthly serialization must also finish when concurrent
exchange requests occupy the connection pool; checkpoints must not wait for an
extra connection held by another request waiting on that same monthly lock.
The stress-test barrier releases after pool saturation or a bounded wait; filling
the pool itself is setup, not required behavior. Its assertions require every
concurrent exchange to finish with exactly one posted quantity per submission.
Existing stock/pallet fallback retry fingerprints must stay identical across
the release; only exchanges add a distinct identity component.

Admin-controls amendment 2026-10-29: Feature Gates must expose a Stock exchange
→ IT column in Operator NetSuite posting by yard, with independent audited
switches for 3445, 2967 and 150. Yard 12441 shows Not available. Enabling a
switch displays Creates IT when the environment ceiling is open; disabling it
displays Local only. Audit reason, revision and idempotency protections apply.
Existing return controls remain usable. Publishing these controls does not
change any gate values or post any production Inventory Transfers.
