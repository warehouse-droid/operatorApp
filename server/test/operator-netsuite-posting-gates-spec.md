# Operator NetSuite Posting Gates — Executable Specification

Status: approved through the user's 2026-08-24 implementation plan.

Assurance tier: Tier 3. These commands create inventory-affecting NetSuite Item
Fulfillments (IF) and Item Receipts (IR).

## Setup contract

- Use the existing Node, PostgreSQL, Playwright, ESLint, c8, and fast-check
  toolchain from `server/package.json`; add no runtime or development dependency.
- Add one additive migration. It must be safe on an existing database and seed
  every new posting gate disabled.
- Preserve the existing dirty worktree. Do not deploy, back up, commit, or run
  a production NetSuite mutation as part of implementation verification.
- Use fake NetSuite boundaries for deterministic tests. A real transform and
  external-ID recovery check may run only in the explicitly allowlisted
  NetSuite sandbox and is a release prerequisite, not an ordinary test.
- Persist a focused gauntlet, mutation runner, source-state recipe, and evidence
  report so the verification can be reproduced from the repository.

## Failure model

| Failure | Required protection |
|---|---|
| The wrong yard or function posts | Server derives the canonical yard and resolves one exact yard/function gate; browser yard input is never authoritative. |
| A retry creates a duplicate IF/IR | Durable request/step identities, unique active claims, deterministic NetSuite external IDs, and recovery lookup precede every retry. |
| NetSuite succeeds but the local commit fails | The posted step is durable; retry performs local finalization without another transform. |
| A group partially posts | Posted children are retained, unposted children resume, and the local group draft remains visible but frozen until every required step is verified. |
| A validation/transport failure falsely completes locally | No local loaded/received completion occurs until all required IF/IR steps are verified. |
| A gate changes while an Operator is confirming | Revision mismatch fails before mutation; an already accepted durable command retains its captured policy. |
| Split/group mapping posts the full parent | Payloads contain only the exact packed/confirmed split quantities and explicitly skip every other eligible parent line. |
| Multiple app replicas race | Database claims and expiring leases admit one worker; deterministic external IDs remain the final duplicate guard. |
| A cached Operator client misunderstands gated posting | Gate-on commands require a current policy revision and UUID request ID; missing/stale policy fails closed. Gate-off legacy local completion remains compatible. |
| A local-only order is posted remotely | Local CO, VRMA, re-load, and re-attempt paths never create a NetSuite step even when the yard/function gate is on. |
| Driver execution regresses | Delivery Prep keeps its existing Loaded/Partial Loaded state and emits its existing events only after finalization; Driver endpoints and PWA data are unchanged. |

## Gate scenarios

### Scenario G1 — all gates are initially off

Given migrations are applied to an existing or empty database, when Admin reads
the gate inventory, then exactly twelve Operator NetSuite gates exist for yards
3445/2967/12441/150 and functions Customer Pickup/Receiving/Delivery Prep, every
row is configured off, and every action remains local-only.

### Scenario G2 — one cell is isolated

Given only `operator_netsuite_delivery_prep_if_12441` is configured on and direct
NetSuite access is enabled, when equivalent actions run at all yards and all
three functions, then only canonical yard 15 Delivery Prep is effective and may
create IF steps. The other eleven cells perform their current local-only flow.

### Scenario G3 — deployment ceiling fails closed

Given a database gate is configured on but direct NetSuite access is disabled,
then the Admin page reports configured-on/effective-off and the Operator action
performs local-only completion without a NetSuite request.

### Scenario G4 — canonical yard and policy revision are authoritative

Given an order belongs to yard 2967, when the client submits yard 12441 or a
missing/stale gate revision, then the server returns a 409 policy/location error
and changes neither local state nor NetSuite state. Legacy location 13 is
normalized to canonical location 28.

### Scenario G5 — Admin changes are audited and live

Given Admin supplies a reason, expected revision, and idempotency key, when one
cell is toggled, then only that row advances revision and new Operator policy
reads reflect it without a restart. Duplicate Admin requests replay safely.

## Posting scenarios

### Scenario P1 — gated Customer Pickup posts one exact SO IF

Given a Pick-Up Sales Order at an enabled yard has confirmed partial quantities,
when Operator completes Customer Pickup with a current policy and UUID request,
then one SO IF is verified, the existing photo policy is enforced independently,
and the existing local pickup load is finalized once with the IF evidence.

### Scenario P2 — gated Receiving posts PO/TO IR

Given a PO or TO has confirmed receiving quantities at an enabled destination,
when Operator receives it, then one exact IR is verified before the existing
local receipt is finalized. A PO uses its effective schedule destination
override. A local CO remains local-only.

### Scenario P3 — gated Delivery Prep posts native SO/TO IF

Given a packed native SO or TO at an enabled outbound yard, when Operator loads
it, then one exact IF is verified before the existing Loaded/Partial Loaded state
and downstream dependency events are applied.

### Scenario P4 — groups and splits use real parents and exact lines

Given grouped, split, or grouped-split SO/TO children, when Operator loads the
group, then children are resolved to positive NetSuite parents, quantities are
aggregated by distinct parent within that click, and one IF per parent contains
only mapped packed lines. Different parents receive different IFs. Local CO,
VRMA, re-load, and re-attempt children add no remote step.

### Scenario P5 — successful commands are idempotent

Given a completed command, when the same UUID/payload is submitted repeatedly or
concurrently, then the stored response replays and transform count remains one
per step. Reusing the UUID with another canonical payload returns 409.

### Scenario P6 — crash and timeout recovery cannot duplicate

Given NetSuite created an IF/IR but the response or local transaction was lost,
when a lease expires or the command is retried, then lookup by deterministic
external ID plus source/line verification recovers that record, no second
transform occurs, and local finalization runs once.

### Scenario P7 — failure preserves the draft

Given preflight or a definitive NetSuite validation fails before any verified
write, when the command terminates, then all packed/confirmed quantities and
photo references remain available, no local completion is recorded, and the
claim is released for a corrected request.

### Scenario P8 — partial or ambiguous groups require attention

Given at least one group step is posted or uncertain and another step cannot be
verified, then the command enters attention, every local child draft is frozen,
and Admin can only recheck/resume deterministic steps. There is no force-success,
silent local-only fallback, or unsafe cancellation.

### Scenario P9 — accepted commands survive a gate toggle or restart

Given a command was accepted under an effective revision, when Admin disables
that cell or the process restarts, then no new command is admitted under the old
policy but the leased durable command resumes under its captured revision.

## Interface and usability scenarios

### Scenario U1 — Operator sees the effective mode

The Operator UI fetches a no-store policy for the selected yard/function and
shows Local only or Creates NetSuite IF/IR. Gate-on submission displays durable
step progress and final NetSuite references; failures explicitly state that the
order was not locally completed.

### Scenario U2 — Admin sees a 4 by 3 gate matrix and attention work

The Admin gate page groups the twelve cells by yard/function, exposes configured
and effective state, retains accessible controls and mandatory audit reason, and
lists attention commands with safe recheck/resume only.

### Scenario U3 — public compatibility

Gate-off existing completion routes and response fields remain valid. Gate-on
routes add a durable command/job response. The existing Receiving job lookup can
resolve the durable command. Cached clients without the new policy token are
blocked only when the relevant gate is effective.

## Negative constraints

- Never post historical local completions or backfill IF/IR automatically.
- Never trust request location, source IDs, line IDs, quantities, gate keys, or
  transaction type without resolving them from current canonical records.
- Never expose M2M credentials, OAuth tokens, photo bodies, or secrets in a
  command response, audit record, error, or log.
- Never change Driver PWA endpoints, offline data, completion sequencing, or
  Dispatch planning/snapshot behavior.
- Gate-off paths must make zero NetSuite HTTP calls and must not acquire a
  durable remote-post claim.
- No new package dependency is authorized.

## Release acceptance

- Focused unit, property, integration, concurrency, adversarial, UI contract,
  and Playwright tests pass.
- New policy/deduplication logic reaches at least 90% changed-line coverage and
  the persisted mutation suite kills at least 90% of non-equivalent mutants.
- Full MBT Node suite, full explicit legacy baseline, and full desktop/mobile
  Chromium plus mobile WebKit suite show zero new failures.
- Syntax/type checks, ESLint, secret scan, dependency/license checks, migration
  upgrade/rollback rehearsal, repeated runs, and one realistic fake-NetSuite
  execution pass.
- The NetSuite sandbox proves IF and IR transforms accept/recover the deterministic
  external ID. Until that proof passes, every production gate stays off and the
  feature is not ready to enable.
