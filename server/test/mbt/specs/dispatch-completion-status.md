# Universal Dispatch Completion Status

## Purpose

MBBS billing must not interpret a different operational status for each order
family. Dispatch owns one canonical completion contract for Sales Orders,
Transfer Orders, Purchase Orders, Vendor Return Authorizations, and Custom
Orders. Billing consumes that contract and never invents completion from an
unrelated billing rule.

## Canonical contract

Every accepted completion exposes:

- `orderKind`: one of `SO`, `TO`, `PO`, `VRMA`, `CUSTOM`;
- `orderRef`: the retained dispatch reference;
- `dispatchCompletionStatus`: exactly `completed`;
- `dispatchCompletedAt`: the operational completion instant;
- `completionEvidenceType` and `completionEvidenceId`: immutable provenance;
- retained plan/load context when it exists.

No completion row means the order is not completed. Billing conversion state
(`unbilled`, `billed`, or excluded) is separate from Dispatch completion.

## Executable scenarios

### U1 — terminal Driver completion is universal and atomic

Given one terminal Driver drop for each of `SO`, `TO`, `PO`, `VRMA`, and
`CUSTOM`, when the Driver job is committed, each reference has the same
`dispatchCompletionStatus = completed`, timestamp, and `driver_job` evidence.
Rolling back the Driver transaction also rolls back the completion status.

### U2 — non-terminal events cannot complete work

Given a started job, travel job, or completed pickup, no Dispatch completion is
created for its order references.

### U3 — direct-pickup TO completion follows the customer drop

Given a `direct_to_customer` TO linked to an SO, when the linked SO customer
drop completes and the dependency becomes `received_local`, the TO receives a
canonical completed status even if no Driver job row mentions that TO. Billing
shows the SO order charge and exactly one direct-TO additional-drop charge.

### U4 — manual Dispatch recovery is audited

Given an authorized Dispatcher or Admin and an existing order, when they
confirm manual completion with a non-blank reason, the order receives the same
completed status with `manual_dispatch` evidence. The action does not create or
modify a Driver job. Missing confirmation, actor, reason, unknown order, or an
unsupported order kind is rejected. Repeating the same command is idempotent.

### U5 — one order has one canonical status and candidate

Given Driver, dependency, reconciliation, or manual evidence for the same
order, the canonical projection selects one deterministic completion and the
billing list contains no duplicate charge candidate.

### U6 — completed means admitted to billing

Every canonical completed order appears in the billing candidate list. A
missing route or rate may make automatic calculation unavailable, but cannot
hide the candidate; the existing guarded manual amount workflow remains
available.

### U7 — conversion revalidates completion evidence

The server resolves a selected candidate again inside the conversion
transaction. A missing or changed canonical completion fails closed rather
than converting stale browser data. An already converted order remains
deduplicated by the existing immutable billing evidence.

### U8 — historical completion is deterministic

Migration backfill recognizes retained Driver drops, direct dependency
receipts, completed reconciliation rows, fulfilled SO fallback rows, completed
VRMA rows, and completed Custom Orders. Rerunning the migration/backfill adds no
duplicates and does not change the source operational statuses.

## Invariants

- Pickup or start cannot be promoted to completion.
- A manual completion never fabricates Driver evidence.
- Operational NetSuite, SCM, dependency, and Custom Order statuses remain
  intact; the universal status is a Dispatch projection.
- Completion time is stored as `timestamptz` and billing date/month filters use
  the existing America/Toronto boundary rules.
- No new runtime dependency is introduced.
- No deployment is part of this change until explicitly requested.

## Setup and gauntlet

Use the existing Node test runner, PostgreSQL migration runner, Docker-isolated
MBT stack, type checker, ESLint, coverage checks, and mutation harness. Add one
migration, completion repository/service tests, billing integration tests, and
a reproducible focused gauntlet script. No package installation or checkpoint
commit is authorized or required.
