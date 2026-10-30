# Delivery kit fulfillment evidence — 2026-10-29

Tier 3; spec approval not obtained (autonomous run). The user requested the kit-line fix and subsequent retries. Acceptance and failure model: [delivery-kit-spec.md](delivery-kit-spec.md).

The delivery worker now compares saved physical components against exact live identities, maps complete component quantities to their NetSuite kit parent, and persists that mapping for preflight and recovery. Existing Operator kit validation is reused. Loading evidence remains physical and immutable. The authoritative source reader identifies kit parents so unselected kits are explicitly deselected.

| Acceptance | Executable evidence |
| --- | --- |
| Exact parent, quantity and retained physical evidence | `mbt/unit/delivery-kit.test.js`, generated property, durable integration |
| Missing/fractional/stale/duplicate/cross-kit identity rejected | Negative unit cases and existing Operator kit property/adversarial regressions |
| Ordinary lines, billing exclusions and unselected kits | Source-reader and ordinary-only loading unit cases |
| Preflight drift, read failure, timeout and durable location recovery | Real processor/native adapter boundary tests; durable timeout integration |
| No duplicate processing | Twelve-worker real PostgreSQL integration and external-ID recovery tests |
| Already fulfilled reconciliation without POST | Unit/integration plus the production retry audit below |

RED failures were observed before implementation and for unselected-kit handling and durable recovery metadata. The recovery failure was fixed by retaining the original kit posting evidence across a fresh source read. Assertions were not weakened. Harness corrections included a claim-table column name and a missing baseline RESTlet fixture; uncovered ID-only response handling received a regression test. Two new implicit-any warnings were fixed with explicit types.

Final candidate checks: 24 new checks pass (20 unit/property, 4 PostgreSQL integration). The selected suite reports **306 pass / 2 fail out of 308**, in both normal and reversed file order. The exact live baseline reports **282 pass / 2 fail out of 284**. Both existing failures concern resale-line automatic fulfillment:

- `future automatic fulfillment snapshots ignore resale rows while retaining loaded inventory evidence`
- `an automatic completion containing only resale items is skipped without an IF`

There are zero new failures. Changed executable-line coverage is **108/108**. Property generation uses seed 20261029 and 30 cases. All four property-only mutations were killed: wrong parent item, missing durable kit evidence, component used as REST line, and inflated parent quantity. Secret scan and lint add zero findings; selected-file TypeScript diagnostics remain 303 before/after, with zero new diagnostics. Tools: Node 20.20.2, fast-check 4.9.0, TypeScript 7.0.2, ESLint 10.8.0, c8 12.0.0.

Reproduce with `python3 server/tools/delivery-kit-release.py validate` against an undeployed prepared candidate. The script uses the standard bounded disposable runner, unique artifact directory, and per-file disposable databases. All task test containers, volumes, networks, coverage, logs and temporary copies were removed. Both `docker ps` and `docker ps -a` were checked. A separate active `mbbs-repair-tests-1077602` project was preserved; it is not this task's test run.

The verified five-file overlay was deployed as `mbbs-operator-app:delivery-kit-20261029`, image `sha256:9fedebbbe84900ccee9994ce4b7dafdbd11b4748fe8354506d3ffe2b448b61e7`, over the current `d69d6f26…` production image. All 1,610 runtime files matched the candidate. Production configuration and dependencies remained unchanged. No schema change. Local/public health returned 200; anonymous driver access returned 401. Rollback: `mbbs-operator-app:delivery-kit-rollback-20261029`. The initial image-check wrapper incorrectly re-entered the older release script; its wrapper was corrected and the actual kit image check passed before cutover.

Live read-only evidence for SOA10934 confirmed parent key 5202231/item 10126 and physical component key 5202232/item 599, ratio 1, loaded quantity 8. All seven affected sources were freshly verified fully fulfilled before retry. The normal application recheck/processor ran in one transaction with external transforms disabled in that one-off process. **SOA10598, SOA10890, SOA10934, SOB123258, SOB123259, SOB123344 and SOM07147 all committed as reconciled, with cleared errors and zero posting attempts.** Audit contains seven `admin_recheck` and seven `already_fulfilled` events. All 37 line claims are released; claim history is retained rather than deleted. Loading records, driver jobs, immutable snapshots/payloads and the two unrelated candidates have identical before/after fingerprints. The remaining attention entries are SOM07128 (legacy quantity conservation) and SOR00250 (legacy unsupported yard).

Operational evidence, full hashes and rollback manifests are in `server/deployments/delivery-kit-20261029`: `verified.json`, `manifest.json`, `deployment-result.json`, `retry-audit.jsonl`, and `final-verification.json`. These are operational records, not disposable test output. No production test fulfillment was created. Synthetic posting tests exercise the real adapter with a mocked external boundary; a future NetSuite edit between preflight and POST remains subject to NetSuite's validation and the existing uncertain-result recovery rules.
