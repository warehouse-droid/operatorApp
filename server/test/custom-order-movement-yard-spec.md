# Custom Order history yard matching

RP-PER-CAM-1022 has completed pickup/dropoff driver records, six photos, and
pickup `3445 Kennedy Road, Toronto, ON`. On 2026-10-26 the production history
repository returns it for all yards but excludes it for yard 1 because Custom
Orders recognize only bare yard codes. Its source data requires no repair.

Spec approval: not obtained (autonomous run). Use old-coder Tier 3 because
the shared lookup also determines Sales yard authorization.

Acceptance criteria:

1. A completed Custom Order with that configured pickup address appears under
   outbound / Custom / 3445 on its activity date. Both completed stops and all
   six photos survive; pending records stay excluded and source rows stay intact.
2. Each of the four existing exact yard codes retains its mapping. A uniquely
   matching configured Dispatch yard address maps to the same ID, ignoring case
   and whitespace. Use the shared `mbt_yards.address_line_1` master data.
3. Offsite addresses, including `150 Main St, Toronto ON`, prefixes, suffixes,
   SQL-looking input and addresses merely containing a yard number stay unscoped.
   They remain available in unrestricted history, without entering a yard scope.
4. List, detail and CSV agree. Empty/wrong-yard authorization excludes the record;
   authorized yard 1 includes it. Existing date, direction and type filters apply.
5. Inactive configured yards retain historical address identity. Ambiguous shared
   addresses do not grant either yard; blank master addresses do not match.
6. Preserve unrelated history behavior, API shapes, dependencies and source data.
   Production release changes only `src/yard-movement-repository.js`, with a
   captured base image, rollback image and health verification.

Failure model: wrong-yard disclosure (negative/address-collision tests and
mutation); lost history/photos (list/detail/CSV and row-preservation checks);
address normalization errors (seeded generated case/whitespace tests); query
regression (existing history/performance suites); unintended release changes
(runtime hashes and captured-image overlay); leftover host workloads (standard
disposable runner, bounded Compose services, unconditional teardown).

Setup: reuse PostgreSQL, node:test, fast-check, c8, ESLint and TypeScript already
in the repository. No new packages, migrations, credentials or git commits.
Add this spec, focused integration tests, a reproducible checks/mutation runner,
release tooling and concise evidence. All generated test output belongs under
the disposable runner's unique artifact directory and is deleted on completion.
