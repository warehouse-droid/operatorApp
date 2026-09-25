# Operator-confirmed Return Authorizations

Approved: user requested implementation of the conversation plan, including no
local approval for new returns, IF/IR-style per-yard feature gates, and one stock
RA with distinct reason rows. Assurance: old-coder Tier 3.

## Setup

Use the existing Node/PostgreSQL/Docker, Playwright, ESLint, TypeScript, c8 and
fast-check tooling; no new dependencies or git commits. Preserve prior worktree
changes. Add migration 203, focused tests, a reproducible gauntlet and evidence.
No production deployment, gate activation or NetSuite mutation is part of local
verification. Sandbox round-trip verification is required before gate activation.

## Executable acceptance and failure model

- G1: eight new RA gates (stock/pallet at 3445, 2967, 12441, 150) start off;
  existing IF/IR gates retain their definitions and behavior.
- G2: admission captures the exact server-selected yard/type policy; missing or
  stale tokens cannot post with an effective gate. A disabled gate saves locally.
  Later enabling a gate does not automatically post local-only records.
- V1: records that predate this workflow retain approval and legacy pallet Credit
  Memo behavior. New records have workflow version 2, no approval queue, and
  NOT_RETURNABLE restrictions, photos, quota and yard checks still apply.
- R1: stock submission creates one SO-linked RA; each entered row retains source
  SO line, item, quantity, rate and custcol_atlas_rc_so reason. Repeated source
  lines with different reasons remain separate. No unrequested physical lines.
- R2: pallet submission creates one standalone customer RA, PALLET item,
  receiving yard, $40/Each and GD reason. Combined submissions create two records.
- R3: verify returned/recovered customer, source SO, yard, external ID and exact
  line multiset before success. Persist discovered IDs even on mismatch; retries
  must never create a replacement for a known or uncertain transaction.
- D1: durable admission, record locks and external-ID recovery prevent duplicate
  creation across concurrent retries, lost responses and restarts. Accepted work
  retains its captured gate policy; current direct-access ceiling still applies.
- Q1: a pallet RA reserves its uncredited quantity; observed downstream Credit
  Memos reduce that local reservation only by their PALLET quantities. Partial
  credits, multiple credits and unrelated credits must not double count/release.
- U1: Operator review displays Local only or Creates NetSuite RA; result/history
  distinguish saved local records from pending, failed and verified NetSuite RAs.
  Legacy approval actions stay limited to legacy records; gate UI has RA columns.
- N1: no order-search optimization, historical conversion, automatic Credit Memo
  for new pallets, NetSuite approval-rule changes, or production gate enabling.

Verification: failing behavioral tests before implementation, isolated real SQL
and HTTP tests, regression suites, adversarial and property checks, concurrent
retry tests, lint/types, coverage, targeted mutants and browser rendering. Record
baseline failures and explicit limitations in the evidence report.


2026-09-18 revision: the user requires one RA for a combined stock/PALLET batch.
The two-RA combined behavior above is superseded by [return-batch-ra-spec.md](return-batch-ra-spec.md).
