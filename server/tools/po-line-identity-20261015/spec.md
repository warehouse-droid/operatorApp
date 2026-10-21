# PO link line identity

Spec approval: not obtained (autonomous run). The user requested the affected
record first, followed by investigation and a general fix.

## Record correction

For GOA-9948S1-9949S1, the first material line must be BLU slab, line 5100029,
947.73 SQFT, source row -67318607752703. The second must be SIENASTONE coping,
line 5100032, 11 PC, source row -4131836072916. Their existing target line keys
must remain stable. No purchase order is to be linked on the user's behalf.
The saved order lines are correct; correct the lookup and verify this record
before broadening the repair. A first release may prioritize exact NetSuite
line IDs in the affected resolution path.

## General correction

Exact database row identity must take priority over a shared item or SKU.
Exact NetSuite line identity must take priority over a shared item or SKU.
Materialized split lines must resolve by their line IDs when snapshots retain
parent row IDs. Nonmaterialized splits must still resolve parent lines.
Legacy item/SKU fallback remains available when exact identities are absent.
Apply the same precedence to allocation remapping during split materialization.
Grouped and split orders must preserve separate descriptions, units, quantities,
source rows, target keys and compatible PO candidates for repeated item codes.
Properties: reordering canonical lines cannot change an exact match; the lookup
must not mutate its inputs. Persisted allocation tests must verify the actual
sales-line foreign key and reject incompatible purchase units.

## Failure model and verification

- Wrong repeated item selected: exact-record regression, ordering properties,
  unit tests for identity precedence and end-to-end repository integration.
- Wrong UOM or allocation row: distinct-unit PO candidates and persisted-link tests.
- Existing links break: stable target keys and split remapping integration tests.
- Unrelated production changes: overlay only the verified repository file on
  the captured production image; preserve configuration and other containers.
- Disposable resources survive: register teardown before testing, use the
  standard isolated Compose configuration and bounded one-off containers,
  remove containers/volumes/networks, inspect both docker ps and docker ps -a.

## Setup

Use existing Node, node:test, fast-check, c8, ESLint, TypeScript and Playwright
tooling. Add no dependencies and make no commits. Store capture, regression,
static, coverage, mutation and release evidence under test-artifacts and
deployments. Preserve unrelated workspace changes. All test workloads use
mbbs-tests.slice and explicit container limits. All production diagnostics
use read-only transactions; deployment has an automatic image rollback.

## Added after the user's retired-group report

The user reported GOA-9948-9949-9998 still linked to SN1402535 after ungrouping,
then explicitly requested removing every PO link from that group before further
investigation. Cancel allocations 259, 260, 261 and 262, preserving the rows and
quantities as audit evidence. This operational data repair is separate from
the duplicate-line lookup correction.

Investigation confirmed retirement updates global definitions, catalog rows,
assignments and relation edges, but does not cancel PO allocations. Extend the
same retirement transaction to cancel active PO allocations targeting a known
retired definition. Keep active groups, normal orders and member links intact.
Repeated retirement must be safe, including cleanup of an already retired target.
Rollback must restore both retirement and PO allocation state. Retain cancelled
rows and emit an audit record. Existing HTTP relationship commands and plan
mutations serialize with the shared fleet planning lock; exercise transaction
rollback and verify no other retired groups retain active PO links.

The user additionally required detecting PO allocations before Ungroup and
warning that confirmation removes every PO allocation targeting the group.
Fetch current server allocations after flushing pending plan saves. Show the
group reference, allocation count and PO references. Cancelling must leave the
group and links intact. Detection failures must block the ungroup. Groups with
no PO allocations and non-SO groups retain their existing behavior. Add a client
cache revision and verify the production click action calls the warning path.

The broader regression suite exposed one check coupled to the old inline
Ungroup handler: it searched that branch for the retirement call. The handler
now awaits the PO-check helper, which retains the same retirement call. Update
that source-location check to follow the helper, keeping its retirement
requirement and the existing lifecycle assertions. The focused click and
browser tests separately execute this path and verify cancellation behavior.

## Added after the user's 3445 pickup question

The failed recovery snapshots have parent pickup locations at 2967 plus PO
vendors, but empty member placeholders at 3445. A synthetic reproduction using
the actual compact-card serializer, normalization, assignment refresh and
pickup validation shows that missing member details become default 3445 SOs.
The server reloads the real member rows at 2967, causing a wrong-yard rejection.
Mark generated member placeholders as unhydrated and keep a missing source yard
unknown until it is supplied. Assignment refresh must not invent a pickup yard.
Preserve explicitly configured 3445 sources, real child pickups, legacy full SO
defaults and idempotence across repeated assignment refreshes. This correction
does not change any source yard in production data.

The same missing member details also replace a compact group's authoritative
pallet total with the sum of empty placeholders (zero). Preserve the reported
group pallet total until member cargo details are available. Once full members
are present, retain the existing member-based pallet calculation.

The user clarified that physical pickup should follow the order lines. Every
current line on SOA09948, SOA09949 and SOA09998 specifies 2967. Keep that source
data authoritative; do not change yard data or re-create the removed TO link.

## Requested historical replay

Before deployment, replay all retained PO-link planning evidence that can be
reconstructed, plus the last seven complete planning dates (October 8–14).
Use read-only production capture and bounded disposable test environments.
Compare the captured live baseline and candidate on identical inputs. Check
line identity, units, quantities, pickup requirements, group pallet totals,
relationship projections, allocation creation and retired-target cleanup.
Retained link/unlink receipts are evidence, not original request bodies; mark
missing source versions or incomplete cases explicitly. October 12 has no
retained plan. Do not claim unavailable dates or missing requests as passes.

The replay fixture contains 452 archived and 111 current states (563 total),
146 retained allocation rows and 64 successful link/unlink outcomes. Compare
actual full-order and compact-card normalization/assignment refresh for every
captured order, including quantities, pickup requirements, pallet counts and
refresh idempotence. Run the real pickup validator and relationship projections
on every saved state; distinguish existing invalid recovery drafts from new
violations. Reconstruct individual allocation create/cancel/retire operations,
material batches from link outcomes, and unlinks from their original saved row.
Use the same captured NetSuite rows for baseline and candidate, modeling
pre-link eligibility and zero receipts but never increasing source quantities.
Any missing or changed source quantity/version is a reported reconstruction
gap, not a passing historical command. Original service selections and SCM
requests are unavailable, so this does not claim exact end-to-end request replay.
The deployment gate requires no unexplained differences and matching replay,
gauntlet and candidate hashes, with both replay stacks fully disposed.

The initial live-baseline replay exposed a pre-existing rule transition:
older MBBS-Special allocations stored physical quantities, while the current
production creation path normalizes MBBS-Special to sales quantity only.
The historical-quantity acceptance clause must distinguish that transition.
Keep the submitted historical quantities unchanged, assert sales quantity
preservation and the existing physical-zero rule for item 2055, and record
every such historical normalization separately. Baseline and candidate must
produce identical normalization; this task does not alter that rule or rewrite
those historical allocation rows.

The replay investigation recovered one original split-link context from the
receipt's parent row IDs and the allocation's later child-row remap. Where
target, PO row and stable source-identity suffix all agree, temporarily hide
the materialized child header in the disposable transaction to exercise the
original parent-line lookup. Assert the exact original parent IDs, retain all
captured quantities, and roll back the context change. Do not classify that
recoverable materialization transition as missing historical data.

Independently restore all 146 allocation rows in one disposable transaction,
including historical links whose creation cannot be reconstructed today.
Retire their known group/split targets using the real repository function.
Assert cancellation of every active link on those targets, preservation of all
other statuses and immutable history/quantity fields, and rollback of the full
dataset afterward. Missing legacy definitions remain an explicit limit.
