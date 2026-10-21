# Non-inventory resale fulfillment evidence

The fix was deployed on 2026-09-30 at 16:13 UTC. All `NonInvtPart` items remain visible and are excluded from future item-fulfillment posts by type. This applies to manual pickup, delivery, sales-order and transfer-order fulfillment, and automatic delivery completion. Receiving keeps its existing behavior. Kit components remain internal membership evidence; only the kit parent is posted.

The acceptance criteria and failure model are in [the executable specification](noninventory-fulfillment-spec.md). This was an autonomous Tier 3 run following the user's request; separate specification approval was not obtained.

## Behavioral evidence

| Acceptance criterion | Executable evidence |
| --- | --- |
| Keep resale items visible; omit selected and deselected resale rows from SO/TO IF payloads | Unit payload tests, display-contract test, integration detail/batch test |
| Ignore missing or ambiguous resale transform identities before validation | Stored/live resolver tests, real SO/TO query integration test, live SOM06789 preview |
| Complete packed resale-only operations locally; preserve empty-selection validation | Unit local-only test; automatic skipped-candidate integration test |
| Do not mark ignored rows fulfilled or keep inventory fulfillment partial | Integration completion-status and fulfilled-quantity test |
| Exclude future automatic snapshots and live IF reads | Automatic snapshot integration test and live-read unit test |
| Preserve receiving, split TO mappings, and whole-kit quantity | Receiving, split transfer, and mixed kit tests; existing regression suites |
| Apply by type with arbitrary names, IDs, quantities and line order | 150 seeded property examples asserting exact inventory selections, deselections, and unchanged inputs |

The new tests are in [unit](mbt/unit/noninventory-fulfillment.test.js) and [integration](mbt/integration/noninventory-fulfillment.test.js). Existing regression tests were not altered.

| Check | Result |
| --- | --- |
| New tests against captured pre-change source | 13 failed; 2 passed; 15 total, exit 1 |
| New tests against final source | 15 passed; no failures or skips |
| Existing relevant regression suites, baseline | 364 passed across 53 files; no failures or skips |
| Existing relevant regression suites, final | Same 364 passed; no failures or skips |
| New tests with reversed file order | 15 passed |
| Changed executable line coverage | 53/53: delivery repository 7/7, posting targets 35/35, live NetSuite reader 1/1, automatic repository 10/10 |
| Targeted mutation checks | 7/7 killed; virtual-source mutations left runtime files unchanged |
| Payload property | Seed 20260930; 150 examples; kills selection and deselection mutants |
| Static checks | Syntax passed; no added ESLint or scoped TypeScript diagnostics; new JS tests/tools lint passed |
| Dependency and credential changes | No dependencies added; no credential patterns in added runtime lines |

The remaining five mutants cover outstanding status, stored mapping, automatic completion, receiving, and visibility. Deterministic tests kill these; the payload property does not cover those layers. TypeScript and lint results compare with the captured baseline and do not claim that the entire existing repository is free of diagnostics.

The complete 714-file MBT suite was also attempted. The ordinary test image lacked Chromium, and the browser image stalled in an unrelated aggregate-request workflow. Those incomplete runs are preserved as `baseline-initial-browser-unavailable`, `baseline-full-broad-incomplete`, and `final-full-broad-incomplete` artifacts. They are not counted as successful checks. The completed regression run covers all existing fulfillment, posting, kit, line-mapping, pickup, receiving-posting, child-location, and consolidation test files selected by the recorded runner.

## Live order and release

A read-only preview of SOM06789 showed all five order lines, including item 9920, `150-Dumping-Soil/Asphalt/Concrete`. The fulfillment draft contained only inventory order lines 1, 2, 3, and 8 with quantities 62.76, 10.46, 1, and 1. The automatic live reader returned the same four lines. The preview created no NetSuite transaction.

Release image: `mbbs-operator-app:noninventory-fulfillment-20260930`, ID `sha256:3698d953d601304a65197b62577c7603fe684f31c39c98cf585aa92509c68f48`.

The release overlays four source files on the latest captured live image. All 1,147 runtime source, public, and migration file hashes matched the prepared candidate. Application configuration and the worker, database, and Ollama dependencies were preserved. No posting operation was active at cutover. Local and public health returned 200, the operator page returned 200, and the anonymous order API retained its 401 response. Rollback configuration and the previous image were retained. No customer fulfillment was posted or retried during this task.

Verified runtime SHA-256 values:

```text
src/delivery-repository.js 6698aa3abd06fbcdf0b521d37511b163ca23a050059fd0145497ae910ce17ece
src/operator-netsuite-posting-targets.js 265822af3e2c24e2ef7f1001e499a53d2b35eaca106d83952593c11ad0ce3f7e
src/netsuite.js a9d3cfd387cd544f746f95b3fe0c7c3624759cfd10d8f9d788e86ad7db9b4369
src/sales-order-auto-fulfillment-repository.js 3a1713ef8060be59f525b5d22e417f8464f68cc97a3f253d9edf493cd36e39ba
```

## Reproduction and artifacts

Run from the server directory using the existing Docker images `mbbs-regular-v2:test`, `mbbs-regular-v2:e2e`, and `postgres:18-alpine`. Verification uses a disposable database on an internal Docker network with external writes disabled. The before snapshot was captured before implementation and is retained; do not replace it with the fixed source.

```bash
python3 tools/noninventory-fulfillment-run.py baseline
python3 tools/noninventory-fulfillment-run.py final
python3 tools/noninventory-fulfillment-deploy.py verify
```

The baseline and final commands require the retained `test-artifacts/noninventory-fulfillment/before` snapshot. Logs, JSON summaries, coverage, mutation evidence, the release patch, and verified hashes are in `test-artifacts/noninventory-fulfillment`. Live preview, manifest, build, cutover, rollback configuration, and verification results are in `deployments/noninventory-fulfillment-20260930`. These artifacts are local and may be excluded from version control by repository rules.

Recorded tools: Node 20.20.2, TypeScript 7.0.2, ESLint 10.8.0, fast-check 4.9.0, v8-to-istanbul 9.3.0.
