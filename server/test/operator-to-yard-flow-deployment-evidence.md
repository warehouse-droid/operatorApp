# Operator TO deployment and reconciliation

The authorized TO flow is deployed. Outbound preparation and truck loading stay
local; loaded goods become available to the destination yard. Ordinary IF posting
requires the matching saved load, complete physical yard receipt and effective
Driver drop-off. The worker verifies IF before admitting IR. Remote delivery
status and quantities do not supply those physical milestones.

The user authorized deployment and reconciliation of every TO, chose to keep
historical completion, and separately requested the two legacy partial transfers
in Receiving. That authorization supersedes the original implementation report's
no-deployment scope. Specification review was not separately obtained; the
inventory change was handled as an autonomous Tier 3 run.

## Production result

Reconciliation checked all **1,053** local TO records, including local splits and
both historical mirrors of TOB00025. It classified 984 as historically completed,
54 as closed, 14 as operational and one as direct to customer. A uniquely verified
Received TOB00025 source alias preserves historical completion without renaming,
merging or deleting either local identity; it cannot authorize active work.

There were **236 changed TOs**, **223 changed headers** and **136 outbound line
repairs**. Twelve lines changed loaded quantity; the other line repairs supplied
the unit associated with the saved physical quantity. Four existing IF jobs were
resolved against verified existing NetSuite IF records. One additional IF job was
captured from an existing durable legacy load and its unique saved assignment,
then attached to its verified existing IF. All 13 IF jobs are completed. These
repairs submitted **zero new NetSuite transactions**.

The second pass checked the same 1,053 records with **zero further repairs**.
Operational audits contain 236 `operator.to.reconcile` entries and two explicit
`operator.to.legacy_receiving_enabled` entries.

| Receiving exception | Destination | Verified receivable shipment |
| --- | --- | --- |
| TOB01134 | 3445 / NetSuite location 1 | Item 2065: 104.91 SQFT; pallet item 1784: 1 EACH |
| TOB01200 | 2967 / NetSuite location 28 | Item 426, Stihl concrete saw: 1 EACH |

Live repository checks confirm both in the destination Receiving list and source
selector, with item search and exact capacity. They are absent from the other
yard's list, and fetching details from that yard is forbidden. TOB01224 also stays
receivable against its actual saved load. Unloaded ordinary TOB01221 stays hidden
from Receiving and rejects receipt admission. TOB01200 and TOB01221 remain in
local outbound work for their outstanding items.

Existing NetSuite IR quantities for the two exceptions remain separate from
local physical receipt progress. TOB01134 already has 104.902 SQFT and a pallet
received in NetSuite; TOB01200's shipped saw already has an IR. Those accounting
facts do not authorize a duplicate IR. Their posting jobs retain physical and
Driver requirements and quantity verification; historical accounting quantities
still require review before any further IR.

Final validation found and repaired two adjacent issues. A fully received first
shipment now leaves other unloaded items partially received; later loading and
receiving them completes the same TO. Two historical completed TOs were also
appearing in outbound because of old packing balances. A terminal local loading
and receiving check now excludes them without changing their saved balances.

## Deployment scope and preservation

The initial app release overlaid the eight reviewed TO modules and migration 279
on its exact live image. The separately deployed worker received only the three
applicable sync/progress patches and migration file; it did not acquire imports
of absent background-posting modules. Subsequent app overlays changed two legacy
Receiving functions, the physical receipt completion calculation, and finally
one outbound terminal-state predicate. No dependencies were installed during
image builds, and builds had networking disabled. Only migration 279 was applied
to production; unrelated pending workspace migrations were not run.

The final app image is
`sha256:c4853edc8d5b324fb7f61abd1e72403fb56ffad218e7b9e2ca8d3c8a3a71b92e`.
The worker remains
`sha256:d1f7eed8916870fa7ebe9ca19a0d733e6e0d595ccdd26b27c937d068126f68c9`.
Source and image hashes are retained in the per-release manifests and final live
check. Live environment values are compared privately and remain unchanged;
production database and Ollama container identities are unchanged.

Other work deployed customer-webhook routing between the first TO image and the
legacy Receiving overlay. The later overlays captured and preserved that exact
live base. Its four-line server delta is retained in
`concurrent-live-server-change.patch`. No other workspace changes were bundled.

Before/after snapshots retain the same 1,053 headers, 7,355 lines, 183 physical
load records and 42 physical receipt records. No physical record was fabricated
or deleted. The 13 original TO native commands and steps are unchanged, including
their immutable inputs, external references and results. Existing job snapshots
are unchanged. Packing, receiving drafts and confirmation fields are unchanged
on every existing line. Only five load responses gained verified existing IF
attachments. Concurrent sync refreshed a few timestamps; the comparison permits
those metadata fields and verifies that no other line content changed.

Private operational snapshots, source captures, configuration and rollback
overrides are kept under
`/home/ubuntu/operatorapp-deploy-backups/operator-to-yard-flow-20261009` with a
restricted directory and files. They are operational rollback and audit data,
not disposable test data. Each deployment retained an image rollback and checked
health and hashes after cutover.

## Executed evidence and reproduction

The final exact app candidate passed **118/118** focused checks. The original 77
checks include real PostgreSQL, authenticated Express HTTP, Driver and dispatch
scope, immutable background queue replay, concurrency, PO regression coverage,
and 450 generated TO property examples. The maintenance additions exercise
historical completion, identity ambiguity, strict existing IF verification,
transactional rollback, legacy scope recovery, audited Receiving exceptions,
two-stage physical receipt and historical outbound visibility.

Eight maintenance mutations were detected: adding cumulative snapshots, accepting
wrong units, accepting a wrong source, reopening historical transfers, dropping
the atomic transaction, omitting legacy job capture, forgetting unloaded items,
and reopening historical outbound work. The initial implementation also detected
all eight original mutations and all four applicable property-only mutations.
Targeted maintenance lint checked 11 files with zero errors or warnings. Python
tools compile, and the deployed receipt module passes syntax checking.

The three maintenance modules exercised 417/420 statements: planner 123/123,
posting proof 72/72, application 222/225. The three missed statements are the
legacy IF mismatch catch that returns attention at lines 97–99; this is a known
coverage limit, not a claimed 100% result. New SQL and receipt helper lines were
executed by the positive and adversarial integration checks. Raw coverage and
RED failures are retained, including the fixtures corrected to supply the
existing packed-state prerequisite for a later truck load. Assertions were not
weakened. The final historical list regression failed before its predicate was
added, and its removal is caught by mutation.

The original full-suite comparison and fair compiler comparison remain in
[operator-to-yard-flow-evidence.md](operator-to-yard-flow-evidence.md): zero
unresolved new failures against 109 pre-existing failing test files, and 866
compiler diagnostics on both sides. The full suite and compiler comparison were
not repeated for the final small Receiving/list additions; those additions were
checked in the 118-test exact-candidate suite. No live NetSuite transform was
used as a test. The production NetSuite audit was read-only.

From the repository root, repeat the final candidate checks with:

```sh
TO_YARD_RELEASE_LABEL=terminal \
TO_YARD_CANDIDATE_ROOT=/home/ubuntu/operatorapp-deploy-backups/operator-to-yard-flow-20261009/terminal-candidate/app \
bash server/tools/operator-to-yard-flow-release-checks.sh
```

The default entry point only tests; it does not deploy or repair production.
Read-only live verification uses `operator-to-yard-flow-live-check.py`, and the
saved preservation comparison uses `operator-to-yard-flow-preservation-check.py`.
The production repair tool retains separate plan, apply and verify outputs and
protects prior audit files from replacement.

All test work used the repository's disposable isolated Compose setup or bounded
one-off containers, `mbbs-tests.slice`, init, explicit memory/CPU/PID/tmpfs bounds
and the disposable lifecycle label. Teardown was registered before launch and
removed containers, database volumes and networks on both failing and passing
runs. Final health, both Docker container lists, resource cleanup and redacted
secret-scan output are retained in `test-artifacts/operator-to-yard-flow-deployment`.

The subsequent 2026-10-10 direct-customer overlay completes TOB01208 using its
delivered SOA09895, existing IF157104, and verified IR15082. It supersedes this
report's app image and migration total while preserving the ordinary TO flow,
historical reconciliation, Receiving exceptions and worker image. Current hashes,
173 selected checks, migration 280, live accounting confirmation and cleanup are
in [operator-to-direct-customer-evidence.md](operator-to-direct-customer-evidence.md).
