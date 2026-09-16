# Completed split PO incoming inventory — evidence

spec approval: not obtained (autonomous run)

User-authorized Tier 2 fix. Specification: [split-inbound-completion-spec.md](split-inbound-completion-spec.md).

## Result

Shared remaining-quantity SQL now excludes an exact completed PO split and a fully received local header. Partial receipts reconcile the fixed baseline, posted physical/sales quantities, and latest NetSuite total without counting the same receipt twice. Confirmation timestamps prevent a new receipt draft from reusing an old partial-receipt status.

The planner, proposal editor, vendor alternative evidence, and new transfer-phase evidence use this rule. Existing approved phase snapshots and source allocation deductions are retained.

## Final checks

- Focused PostgreSQL tests: 13/13 pass, including the live three-by-24-PLT reproduction.
- Draft evidence maintenance: 2/2 pass (unchanged manual quantities, audit, idempotence, revision guard). These maintenance checks were added after the one-time helper; the application fix has observed RED tests.
- Related SCM/receiving suites: 31/32 pass; 1 reproduced baseline failure.
- Reversed file order: 43/45 pass; 2 reproduced baseline failures. Zero new failures in either order.
- Changed application lines: 36/36 exercised; PostgreSQL cases cover completion, status, timestamp, conversion and remaining-quantity conditions.
- Manual mutation: 12/12 assertion kills. Property tests alone detect 4/12; no claim that properties cover all completion/status conditions.
- Property test: 40 generated receipt/ordered-quantity combinations, seed 3737; exact expected balance and lower/upper bounds asserted.
- TypeScript 7.0.2: 1762 baseline / 1762 current diagnostics, zero new.
- Syntax: four application files pass. Lint: 1 existing diagnostic, zero new. New helper complexity <= 12.
- Secret scan: zero findings in the new helper and focused fixtures. No dependency, lockfile, network, authentication, or schema changes.

## Baseline and verification limits

- `smart-scm-harness.js` already fails because its fixture is missing an active Item Master record.
- Reversed order also exposes the existing vendor-alternative harness integer overflow after another fixture leaves very large item IDs. The original source reproduces both failures; no assertion was weakened.
- The whole application suite was not run: the applicable SCM, split receiving and inventory suites above were selected. Unrelated browser flows and external NetSuite writes were not exercised. No UI code changed.
- A timestamp edge case was found after the first deployment; it has its own observed RED (181.6 actual vs 900 expected), regression, and final deployment. Earlier individual guard mutations became redundant after this safeguard; final mutants remove the complete relevant guard and all are detected.
- Local partial counters require a confirmed, posted receipt timestamp. NetSuite remains the authority for other raw on-order balances; this fix changes the local split overlay, not historical source inventory snapshots.

## Acceptance mapping

| Spec | Evidence |
|---|---|
| 1: three completed 24-PLT splits | planner and editor reproduction tests; live item 2277 at 3445 |
| 2: exact identity; sibling/kind/pickup isolation | exact-reference test and real Driver trigger pickup/drop-off test |
| 3–4: posted partial receipts; overlap; bounds | mixed pallet/layer/section/piece example, sales-only property test, full receipt and stale-draft tests |
| 5: consistent consumers and frozen phase | vendor alternative test; approval evidence and repeated approval immutability |
| 6: existing split behavior | same/cross-yard, terminal filters, ordinary parent evidence, related suites |
| 7: retain operational data and manual proposal quantities | read-only query change, maintenance tests, live rollback and fingerprints |

## Reproduce

From the repository root: `bash server/tools/split-inbound-completion-gauntlet.sh`.

Uses cached `mbbs-retired-confirm-test:20260914` (Node 20.20.2, TypeScript 7.0.2, ESLint 10.8.0, c8 12.0.0, fast-check 4.9.0) and disposable PostgreSQL 18. The test runner creates an internal Docker network and removes the database afterwards. Baseline is recoverable from the task-only patch. Live maintenance is a separate explicit command bound to run 389, revision 2; do not rerun `apply` after correction.

Application source set SHA-256: `0a61e5902825a92c2bf4794827e54d1925672c3b66f0e0b4f8402a7dc4fbf538`.

```json
{
  "src/smart-scm-split-inbound-sql.js": "4e928fbc5d58af00dd1eef81f9a91cf3a5e4930e1550b26603cc9267e38e2d77",
  "src/smart-scm-planning-repository.js": "617c5c2614b0ae34774061c6ff9f2ca3af29f40798e679242e99fc0405177245",
  "src/smart-scm-proposal-editor.js": "fd29d7866aa426292c4e5d1856974d461ca3a35f16aafe9b635586a9bf417efb",
  "src/smart-scm-vendor-repository.js": "3032264c2c10927a49e527c64017ca22112a4d78a78bc26810d6be3afc794e79"
}
```

## Live verification

- Final image: `mbbs-operator-app:split-inbound-completion-20260915-v2`, app and webhook worker. Only four source files were layered over the existing deployment.
- Forecast 303; HUNT70S-RDM-CG / 3445: incoming 0 SQFT, backorders 1048.66 SQFT, signed Expected -10.250831 PLT.
- Corrected saved inventory evidence on 12 rows in Blanket run 389; revision 2 → 3. Proposal 34397 / line 119322 stays at 5 PLT.
- Transaction rehearsal was rolled back before apply. Before/after fingerprints match for every proposal header and every non-evidence line value in the run.
- Before/after inventory reasons are retained in the plan revision and `smart_scm.split_inbound_completion.inventory_refresh` audit. Deploy backups are under `/home/ubuntu/operatorapp-deploy-backups/split-inbound-completion-20260915-v2/`.
