# Evidence — PO Split live schedule parity

Status: GREEN, deployed, and verified against the live production payload.

## Production diagnosis (read-only)

The reported PO Split identity `3022130415` resolves to active NetSuite PO
`POB03728`. Its persisted PO Split catalog entry still contained schedule
`Queued` at `2026-08-31T02:29:06.620731Z`, while the live
`scm_transport_schedule` row had already advanced to `Planned` at
`2026-08-31T02:29:33.265579Z`. PO/TO Schedule reads that live row directly;
PO Split used the catalog plus a partial status overlay.

The audit/database trace also captured a successful schedule upsert at
`02:29:06.629Z` followed by the stored row moving backward to the transaction
start at `02:29:06.620Z`. The nested Packing Slip / Ref synchronization used
PostgreSQL `now()` after the upsert used `clock_timestamp()`. This made the
revision returned by a successful save differ from the committed revision.

## RED proof before implementation

Five production-shaped regressions were added and run before each corresponding
production-code change:

1. The PO Split browser test failed because the old catalog card's `Queued`
   state overwrote a subsequently hydrated `Planned` state for `3022130415`.
2. The catalog integration test failed because list/detail returned stale
   method `MBT` instead of live method `Vendor`; only status and timestamp had
   been overlaid.
3. The transaction test failed because Save returned revision
   `02:37:02.063Z` while the committed row had regressed to
   `02:37:02.024Z`.
4. The exact PO schedule status test failed because a source PO's initial
   `Hold` status downgraded the exact schedule's live `Planned` status.
5. The planning-details test failed because PO Split did not use PO/TO
   Schedule's active-assignment fallbacks for ETA, driver, truck/load note, and
   parking detail when the persisted schedule fields were blank.

The stale-conflict tests were kept intact; the repair does not blindly retry or
accept a genuinely obsolete draft.

## Implemented behavior

- PO Split keeps the indexed catalog for bounded search and PO quantities, but
  overlays every editable schedule field and the exact six-digit live revision
  from `scm_transport_schedule` on list and detail reads.
- A placeholder `Queued` alias can still inherit its linked source status, but
  a live exact status such as `Planned` cannot be downgraded by a source PO's
  initial status. Completion and review rules remain unchanged.
- Method, route, special-order flag, packing slip, group, ETA, driver, notes,
  remark, schedule identity, and revision come from the exact PO identity being
  edited. Blank planning-display fields use the same active-assignment
  fallbacks as PO/TO Schedule; persisted schedule values retain precedence.
- The browser compares full fractional timestamp precision and selects one
  complete schedule state from the newest list-card or hydrated-detail response.
- Unchanged PO references no longer rewrite the PO mirror or schedule revision.
  Real reference changes advance monotonically with `clock_timestamp()` and
  Save rereads/returns the final committed identity and revision.
- The PO Split client cache key is advanced for immediate cutover behavior.

## Verification completed

- 20/20 browser checks, including property/adversarial revision-ordering
  scenarios.
- 17/17 catalog/status integration checks, including complete live-field and
  active-assignment parity, exact-Planned precedence, and linked-identity
  revision isolation.
- 27/27 final focused regression checks passed together.
- 8/8 schedule concurrency checks, including stale rejection, two-writer races,
  unchanged references, and renamed references.
- 18/18 surrounding HTTP, split-editing, destination, residual-schedule, and
  indexed-workload checks.
- 37/37 indexed workload checks passed against a clean disposable database.
- The isolated full suite passed 429/429 files and 2,126/2,126 tests, including
  database, adversarial, and concurrency suites.
- Syntax, TypeScript, and focused zero-warning ESLint gates passed.
- Changed-line probes passed 17/17 (100%).
- Mutation scores: 18/18 PO Split UI, 22/22 catalog/status, and 2/2
  transaction/rename mutants killed (42/42 total); mutation sources restored.
- The production dependency tree check exited successfully, and the new-path
  secret scan found no findings across 16 paths.

## Production deployment verification

- Only `app` and `webhook-worker` were recreated. The measured cutover was
  2.22 seconds; PostgreSQL and Ollama remained running and healthy.
- App image:
  `sha256:c61390178826e05e7a409bb4ca50798335dca61f612b6f0fcdefb9d401bda1bf`
- Worker image:
  `sha256:908911fc1b0b1c3a3f2ced660a8fc3312dfd120d9710a5cce374f88547fe457c`
- The recreated app reported healthy and the worker reported running.
- A read-only post-cutover production query for `3022130415` returned
  `ok: true` with no mismatches across PO Split list, PO Split detail, and
  PO/TO Schedule for status, method, route, special-order flag, packing slip,
  group, ETA, driver, notes, schedule ID, and six-digit revision. The shared
  live values include `Planned`, destination `3445`, ETA
  `2026-08-31 13:57`, driver `Mike`, and note `BL42349 Load 2`.
