# Smart SCM phased planning and PO split editing — implementation evidence

Date: 2026-08-26 UTC

Status: implemented and validated in the isolated
`mbbs-smart-scm-phased-plan-test` stack. Not deployed.

## Historical-data rehearsal

The isolated database was seeded from the existing Smart SCM decision inputs
and sales history without modifying the source files. The import contained 400
items, 1,600 yard policies, and 88,672 sales facts. The initial historical-seed
rehearsal produced 843 forecasts and 232 PO proposals. The final baked-image
rerun, after the concurrency tests intentionally committed additional eligible
fixture policies, produced 851 forecasts and the same 232 PO proposals. Both
runs used five active historical inputs and rolled the planning results back.
The harness now pins its own legacy capacity and feature settings so prior
isolated-test fixtures cannot change that baseline.

## Executable evidence

| Check | Result |
| --- | --- |
| Focused unit/property/UI/PostgreSQL/concurrency suite | 48/48 passed |
| Randomized Skip-12441 demand conservation | 1,000/1,000 cases passed |
| Core-module coverage | 99.67% statements/lines, 100% functions, 91.73% branches |
| Mutation tests | 12/12 mutants killed (100%) |
| Existing historical Smart SCM harnesses | 8/8 passed |
| Existing PO link/route/split/schedule/Blanket regressions | 70/70 passed |
| Existing Smart SCM manual-control regressions | 12/12 passed |
| Existing Blanket merge tests (including nested cases) | 11/11 passed |
| Migration 181 upgrade/idempotence rehearsal | passed |
| Task-scoped ESLint | passed with zero warnings |
| JavaScript syntax and MBT TypeScript checks | passed |
| Changed-line secret scan | passed; no high-confidence findings |

The PostgreSQL proofs include concurrent split editors, a schedule-save versus
quantity-edit race, Blanket allocation conservation, concurrent Phase 1
approval, one-time Phase 2 construction, immutable Phase 2 evidence, and stale
revision rejection. The broader regressions cover PO ref search, Link PO,
direct-ship residual routing, destination overrides, corrected receipts,
source remaining quantities, schedule status concurrency, manual TO backorder,
and Blanket reallocation/merge behavior.

Legacy UI harnesses initially rejected intentional cache-key bumps already
present in the pages. Their expected asset versions were aligned and the
affected cache-contract harnesses then passed. No operational test failed after
the implementation was finalized.
