# Operator Linked-Quantity Projection and Completion-Driven SO Fulfillment

Date: 2026-08-25 UTC

Specification status: approved in conversation on 2026-08-26. The revision
below supersedes the earlier Operator-triggered IF scenarios. No deployment or
commit is part of this implementation run.

## 2026-08-26 approved revision

The user rejected fulfillment at Operator load time. Delivery Prep must subtract
active Link PO and direct-to-customer Link TO quantities, then save only the
physical yard residual. A backend scheduler creates the Sales Order IF after
the Driver completes the customer drop (or Dispatch records an audited manual
completion). The scheduler creates only the SO IF; existing PO IR and TO IF/IR
workflows remain separate.

## Purpose

Operator Delivery Prep must describe only the material physically handled at
the MBBS yard. NetSuite Sales Order Item Fulfillment must account for the exact
completed Dispatch target: Operator-loaded residual plus the quantities
supplied by active Link PO and direct-to-customer Link TO relationships. These
are two projections of one immutable line, not one shared quantity.

## Executable scenarios

### L1 — PO-linked quantity is not yard-loaded

Given a Sales Order line for 100 EA with an active PO allocation for 40 EA,
Operator Delivery Prep exposes 60 EA as the physical requirement and retains
100 EA as the original quantity. Cancelled PO allocations do not reduce it.

### L2 — only direct TO quantity is not yard-loaded

Given a Sales Order line for 100 EA, an active `direct_to_customer` TO allocation
for 40 EA exposes 60 EA to Operator. The same allocation in
`yard_replenishment` mode leaves the Operator requirement at 100 EA because the
yard must still load that replenished stock onto the customer route.

### L3 — Operator receives an auditable quantity breakdown

Given 100 EA required, 25 EA Link PO, and 15 EA direct Link TO, the server
returns original 100, PO 25, direct TO 15, combined linked 40, and Operator
required 60. The legacy combined allocation field remains 40 for compatible
clients. A fully linked line is retained as scheduler evidence and is labelled
`No yard load required—direct supply`; it is not confirmable by Operator.

### L4 — over-allocation fails closed

Given 100 EA required and active direct allocations totalling 101 EA, the
projection reports a blocking `LINKED_QUANTITY_EXCEEDS_TARGET` error. It must
not silently clamp the relationship to zero Operator quantity or allow packing,
confirmation, loading, or IF creation.

### L5 — Delivery Prep records local physical work without an SO IF

Given a Delivery SO at a yard whose old Delivery Prep IF gate is enabled,
Operator completion still records only the residual load locally. It creates no
SO NetSuite command. Customer Pickup SO IF and native TO outbound IF keep their
existing gated behavior.

### L6 — Driver completion creates an immutable candidate

Given a server-accepted customer drop, one candidate is created for each real
SO child in that completed Dispatch target. Its frozen line snapshot conserves
`Operator loaded + completed PO link + completed direct TO = target quantity`.
A fully direct order needs no Operator load record. Repeated completion evidence
replays the same candidate.

### L7 — direct evidence is exact

Direct PO pickup and delivery evidence identifies allocation IDs, exact local
line IDs, plan, load, and Driver jobs. Direct TO evidence requires the existing
direct dependency progression. A whole PO header and unrelated residual yard
freight are not prerequisites. `yard_replenishment` never contributes direct
SO IF quantity.

### L8 — split and group lineage remains exact

Each completed split creates a partial IF against its positive NetSuite parent.
Concurrent split candidates are serialized per parent line and cannot claim
more than live remaining quantity. Group children with different positive SO
parents create independent candidates and cannot block or contaminate one
another.

### L9 — line drift stops automatic posting

Immediately before posting, live NetSuite status and remaining lines are
compared with the immutable delivered snapshot. Closed orders never post;
already fulfilled quantities reconcile without duplication. Added, removed, or
changed lines enter attention. Admin may recheck, fulfill the delivered
snapshot, fulfill all live remaining, submit bounded custom quantities, recover
an uncertain post, or skip, with mandatory audit reason where applicable.

### L10 — exactly-once NetSuite posting

One deterministic external ID belongs to one candidate. A worker timeout,
restart, duplicate event, or concurrent worker must recover and verify the same
NetSuite IF instead of transforming again. Local finalization and active line
claim release happen atomically only after verification.

### L11 — activation and manual completion

Each supported yard has a default-off automatic SO IF gate. Enabling it stores
an activation watermark; older completions are not automatically queued. Admin
may preview and queue selected historical SOs. An audited manual Dispatch
completion is an explicit execution override and automatically creates a
candidate when the yard gate is effective.

### L12 — unrelated paths are unchanged

Customer Pickup SO IFs, native TO IFs, PO/TO Item Receipts, local-only and
re-attempt orders, Driver route order, offline replay order, and gate-off
behavior retain their existing contracts. Gate switching is server-side and
does not require a new Driver PWA version.

## Failure model

| Failure | Constraint that detects or prevents it |
| --- | --- |
| Operator loads direct-shipped stock twice | PO and direct-TO projection integration tests; yard-replenishment negative case |
| SO IF omits linked stock | Candidate conservation and exact payload unit/property tests |
| Delivery Prep posts the SO too early | Admission contract test: delivery SO is always local-only |
| Remote IF succeeds but local progress is lost | Verified-command finalization transaction and rollback test |
| Link changes after completion | Immutable evidence plus live comparison fails closed |
| Group/split quantity leaks to another line | Exact local line IDs in snapshots and grouped-line tests |
| Over-fulfillment from malformed values | Finite, nonnegative, canonical-quantity bounds and adversarial/property tests |
| Duplicate IF after timeout or worker race | External-ID recovery and concurrency stress tests |
| Historical backlog posts on first enable | Activation-watermark integration test |
| Admin override silently changes quantity | Mandatory reason, bounded line validation, and audit assertions |
| Existing workflows regress | Focused posting suite, Operator/Order Dependency suites, full relevant regression, lint/types, mutation, and real DB execution |

## Setup and gauntlet

- Reuse Node's test runner, PostgreSQL test container, `c8`, ESLint,
  TypeScript, fast-check, the existing secret scanner, and the existing
  Operator posting mutation framework.
- Add migration 180 for immutable direct-PO execution evidence, automatic SO IF
  gates, durable candidates/attempts/line claims, and activation watermarks. No
  package or external service dependency is added.
- Persist a focused test command, mutation cases, source-state command, and
  gauntlet entry point in the repository.
- Do not commit, deploy, call NetSuite, or mutate production data.
