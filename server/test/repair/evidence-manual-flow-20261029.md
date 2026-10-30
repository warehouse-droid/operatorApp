# Repair local workflow and manual financial documents — 2026-10-29

Released 2026-10-29T19:09:21Z to the existing Repair application.
Image: `mbbs-operator-app:repair-flow-manual-20261029` (`sha256:8d8d304fada09d8f69807f15e7ce9f707cccff77f442b41f486728fb526868d6`).
All 60 released source hashes and 38 live HTTP checks passed;
application health, configuration and other production services were preserved.
No database migration, Git commit or new production dependency was required.

Scope: criteria 69–75, including 70a and 75a, in `spec.md`. Separate human spec
approval was not obtained in this authorized autonomous run. This evidence
establishes the recorded constraints, not completeness of the business spec.

| Constraint | Evidence |
| --- | --- |
| Local PO/receipt response | Real PostgreSQL transactions while the Dispatch advisory lock is held; browser board/catalog refresh routes blocked. Commit patches update the affected cards without waiting for those routes. |
| Start Job and completed-job exclusion | Server work/completion/photo denial before Start, separate inspection/repair starts, phone/tablet disabled controls, stale links return to the visible job list. Parts receipt preserves an existing start. |
| Manual financial documents | Runtime never claims financial work even with old enable flags true. Separate WOR/SOS/Bill operations use authority checks, durable leases, replay, identity checks and explicit uncertain-outcome reconciliation. |
| Actual Office labour | Real repository and browser edits validate reason, hours/rate, revisions, audit attribution and posting locks. Quotes stay unchanged. Team/requester/approver responses redact actual cost from work and audit data; WOR retains it. |
| WOR/SOS/Bill separation | Adapter boundary tests and 200 seeded property cases keep actual workforce separate from quote quantities/prices. SOS/WOR reciprocal links are checked. Bill uses supplier invoice values after receipt and evidence. |
| Ready and local PO status | Individual document blockers and per-PO stages are verified; invoice Bill readiness is independent of unfinished repair work. |
| PDF design | Branded Letter pages, aligned columns/totals, original PO prices after invoice changes, long descriptions, 70-row continuation pages and large totals. Actual rendered short quote/PO pages were visually reviewed. |

Final frozen-candidate results: **174/174 tests in each of three runs** (normal,
coverage, repeat); **283/283 changed backend/domain executable lines covered**;
**70 distinct fault executions caught**, including 16 new manual-flow faults
and selected property-only checks. Overall collected line coverage was 96.17%,
branch coverage 83.53%, function coverage 93.77%. Browser JS/CSS/HTML is exercised
through real browser flows and is excluded from the Node changed-line report.
Lint, domain type checks, server syntax and secret scanning passed. The affected
regression set passed 40 tests across nine files; three shared-shell files passed.
The pre-existing asset-contract failure is unchanged and narrowly accepted:
`S11: the guarded client ships in a new atomic Driver shell generation`.
The other three checks in that legacy file pass; no new failure is accepted.

Repair source graph SHA-256: `e95c70cf6b4c58883c97fabe4830f79b2da99f8dd71fcbc5934ca9bd0fd768f5`.
Shared integration SHA-256: `18c1690e87625b62b1b547eca03147c421a982c630730c9ddfd1eb0749e26948`.
Atomic Repair asset generation: `20261029-manual-flow`.
Exact file hashes, check summaries and rollback metadata are in
`deployments/repair-flow-manual-20261029/`.

Red evidence: six initial workflow checks and both original PDF checks failed
against the earlier implementation. Additional reproduced failures covered lost
Start state after parts receipt, cross-job labour audit attribution, clipping of
large PDF totals, and shared actual-cost exposure. Assertions stayed frozen
through their fixes. Positive older fixtures explicitly perform Start. Prior
completed-Team-list assertions are superseded by the requested exclusion.

An initial full run had a fake WOR ID collision; the fixture now uses its unique
identity. A repeat run caught an intermittent Office customer-link check. Ten
focused repeats passed with click/response diagnostics; waiting for the Office
sidebar then passed the complete 11-test receipt file three times. The final
full runs retain diagnostics. An older stale-selection fault was masked on
desktop by the independent detail guard; its phone witness now verifies the
visible job list and cleared invalid URL. No prior outcome assertion was removed.

Live read-only audit: `REP-0000002` remains completed with receipt
pending and 3 editable labour records.
`REP-0000002-J02` remains completed/declined with its whole quote
rejected. Completed jobs are absent from Team, and shared hourly costs are hidden.
The existing local PO is at Parts received; its invoice step remains outstanding.
Legacy inspection/work-update intents remain pending with attempt 0.
Both financial posting gates remain false. **No live financial document was
created or posted** during validation, deployment or the operational audit.

Read-only NetSuite metadata verified workforce fields 152 Actual Hours,
153 Work Notes, 154 Completed, 156 Billable Hours and 157 Hourly Rate; WOR status
4 Completed (5 Closed); and reciprocal SOS `custbody14` / WOR `custrecord_wo_so`.
Reciprocal writes/read-backs were tested at the injected record boundary, not
performed on live records. Existing SOS accounting status is preserved on update;
creation uses the supported approved status. Machine-only masters without a
verified WOR vehicle mapping remain explicitly blocked.

Reproduction uses `tools/repair-manual-release.py validate`,
`tools/repair-manual-checks.mjs` and the standard bounded disposable runner.
Rebuild the task-specific image from `docker/Dockerfile.repair-pdf-test` first
when rerunning: Poppler 22.12.0-2+deb12u3 was a test-only dependency and the image
was removed after validation. Tool versions: Node 20.20.2, ESLint 10.8.0,
TypeScript 7.0.2, c8 12.0.0, fast-check 4.9.0, Playwright 1.62.1.

Cleanup is complete: both running/stopped container lists contain only the four
production containers; no Repair test volume or network remains. The unique
runner artifact directories, raw logs, PDFs, images, coverage and mutant copies
were removed automatically, including failed runs. The disposable PDF image is
removed. Only source evidence and deployment/rollback operational records remain.
