# Operator NetSuite IR/IF Line Mapping — Executable Specification

Status: not pre-approved (autonomous run requested on 2026-08-28).

Assurance tier: Tier 3. These paths create inventory-affecting NetSuite Item
Fulfillments (IF) and Item Receipts (IR).

## Setup contract

- Use the existing Node, PostgreSQL, c8, ESLint, TypeScript, and fast-check
  toolchain in `server/package.json`; add no dependency and no migration.
- Preserve stable SuiteQL `transactionline.uniquekey` values as local lineage.
  Translate them only at the NetSuite posting boundary.
- Do not replay a failed command or create a real IF/IR during verification.
- Persist focused tests, mutation checks, a source-state recipe, and a single
  gauntlet entry point.
- After all constraints pass, rebuild the app image and use a short app-only
  cutover. The database and worker remain online.

## Failure model

| Failure | Required protection |
|---|---|
| A SuiteQL unique key is posted as a REST line number | Resolve line IDs from the live source record and map stable local aliases to the REST transform identity before command creation. |
| SO, PO, or either TO direction uses a different line convention | Cover SO→IF, PO→IR, TO→IF, and TO→IR independently; TO accounting mirrors must collapse to one visible logical line. |
| Duplicate items map to the wrong row | Prefer exact source aliases/line identities, retain occurrence identity, and fail before POST when mapping is missing or ambiguous. |
| NetSuite already completed a selected line | Compare the selected quantity with live cumulative progress/remaining quantity; reconcile the covered part locally and post only the uncovered remainder. |
| Every selected line is already complete | Create no transform step, retain authoritative linked-transaction evidence, and finalize the existing local Operator record/workflow. |
| Remote payload line IDs break local receipt bookkeeping | Persist a separate stable local receipt payload and use it for local finalization; REST IDs remain confined to NetSuite payloads. |
| A closed NetSuite source blocks reconciled local completion | Permit the closed-source bypass only for an internally verified reconciliation command, never for ordinary local-only completion. |
| A group overposts a shared split-parent line | Aggregate all selected child quantities by real parent/REST line, then cap the single posted quantity at live remaining quantity. |
| Retry creates a duplicate transaction | Preserve deterministic external IDs, durable claims, and existing external-ID recovery behavior. |

## Executable scenarios

### M1 — SOB119026 regression maps stable keys to REST lines

Given local SO lines `4866005` and `4866006`, and live NetSuite source lines
whose REST `orderLine` values are `1` and `2`, when a Customer Pickup IF draft
is built, then its payload uses only `1` and `2`; stable keys remain in local
line evidence and never appear as REST `orderLine` values.

### M2 — PO Item Receipt uses the source REST transform identity

Given a PO local line key `4850690` mapped to live line `1`, when Receiving
builds an IR, then the remote payload selects line `1`, the local receipt
payload retains `4850690`, and finalization records the stable local line.

### M3 — TO mirrors map both directions to one visible source line

Given one TO logical item with visible outbound key/line `4868177/1`, hidden
outbound key/line `4868178/2`, and destination key/line `4868179/3`, when
Delivery Prep builds IF and Receiving builds IR, then both transforms use the
REST identity of that one logical source item and never apply a numeric `+1`
guess to a stable key.

### M4 — non-sequential and reordered source lines remain exact

Given source REST lines `1` and `4` returned in either order, when local stable
aliases map to them, then payload order is deterministic and each selected
quantity remains attached to its own logical line.

### R1 — fully completed line continues locally without another POST

Given a selected quantity of `5`, live remaining quantity `0`, and linked IF/IR
evidence, when the command is admitted, then it contains zero transform steps,
records the linked transaction evidence, finalizes the local load/receipt, and
makes zero transform calls.

### R2 — partially completed line posts only the uncovered remainder

Given selected quantity `5` and live remaining quantity `3`, when the command
is built, then the remote payload quantity is `3`, reconciliation evidence
records `2` as already covered, and the local finalizer records all `5` selected
units exactly once.

### R3 — split children share one live remainder cap

Given two split children select `4` units each from one parent line with live
remaining quantity `5`, then one parent transform posts exactly `5`, not `8`,
while both child selections remain in local evidence.

### E1 — ambiguous or missing identity fails before NetSuite mutation

Given duplicate/unaligned aliases or no authoritative REST line, when targets
are materialized, then the operation raises
`OPERATOR_NETSUITE_POSTING_LINE_MAPPING_UNRESOLVED` and performs no transform.

## Negative constraints

- Do not change public route request shapes, gate policy, deterministic external
  IDs, stable local line IDs, source quantities, or location authorization.
- Do not infer a REST line by sorting alone or by adding/subtracting an offset.
- Do not treat status text alone as completion evidence.
- Do not auto-retry historical failed commands after deployment.
- Do not add a network, filesystem, subprocess, or credential capability beyond
  the existing authenticated NetSuite read/post boundaries.
- No new dependency or database schema change is authorized.
