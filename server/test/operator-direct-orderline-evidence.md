# Direct Operator IF/IR — deployed verification

Deployed app and webhook worker together as
`mbbs-operator-app:operator-direct-orderline-20260916-v3`.
Image: `sha256:fa730d5b7614fad1efd126d3ceb32606919c5d3b74e915aa8aace9479544891e`.
The stored-orderLine switch is enabled in both services. Local/public health and
the public Operator asset version passed. Database and Ollama containers,
mounts, ports and other environment settings were preserved. The earlier IR fix
remains included. No migration or dependency change was needed.

## Result and scope

- New native Operator IF/IR commands use persisted parent `orderLine` mappings.
  Fresh posting makes the transform POST and verification GET, without a live
  source/quantity query or transaction-history scan. Confirmed quantities are
  sent unchanged; NetSuite decides acceptance. Local identity, yard, eligibility,
  split lineage and duplicate protections remain.
- Uncertain work recovers by exact external ID and cannot automatically transform
  again. Failed verification after possible remote success retains the order
  hold. Legacy commands retain their original recovery behavior.
- Independent source steps share a pool of at most three Operator requests.
  Partial batches wait for in-flight results and cannot finalize locally.
- The UI renders the NetSuite stage before submitting. R2 uploads remain durable
  background work after verified completion. After 15 seconds the UI reports the
  delay and continues waiting for actual confirmation.

Spec: [approved criteria and quantity-check revision](operator-direct-orderline-spec.md).
Tier 3 inventory/concurrency validation used the existing toolchain. Spec approval
was obtained through “Implement the plan”; the explicit later instruction removed
the live quantity check.

## Production data evidence

At 2026-09-16 17:18 UTC, the final guarded backfill covered **290 eligible incomplete
orders: 236 SO, 47 PO and 7 TO**. All **1,137 eligible stored line rows** matched;
there were zero missing local orders, mapping updates, unresolved identities or
concurrent-update conflicts. Existing exclusions for cross-charge orders,
billing-only completion, subtotals and inactive history were preserved.

SOA08816 had one removed source line still active locally. It was reconciled with
the existing missing-line sync function. Its row remains as inactive history;
operator progress hashes before and after were identical. An earlier broader
refresh rolled back when its preservation check detected a parsing timestamp
change; the narrower repair left those header fields unchanged.

The final webhook check verified **76 posting lines across 50 SOs and one PO**, with
zero stored mapping mismatches. **No updated TO webhook was observed**; transfer
webhook behavior is covered by existing integration tests and TO mappings by the
backfill, rather than claimed as production webhook evidence.

After deployment, read-only source resolution passed for SO IF, PO IR, TO IF/IR and
SN1400625 → PO 939701. The background photo queue reported five uploaded jobs and
no outstanding jobs. No production NetSuite transaction was created for testing.

## Final validation

| Layer | Result |
| --- | --- |
| Full baseline | 500 files; 2,541 passed, 1 failed, 1 skipped |
| Full final | 505 files; 2,578 passed, 1 failed, 1 skipped |
| Regression difference | Zero new failures; all 37 added tests passed |
| Focused regression | 177 passed, zero failures |
| Actual shuffled execution | 28 files, seed 160920, all passed in separate processes sharing the isolated DB |
| Types | 233 baseline and 233 final diagnostics; zero new |
| Lint | 951 baseline and 951 final diagnostics; zero new violations |
| Changed backend lines | 194/194 executed |
| Changed UI lines | 16/16 executed in Chromium |
| New helper branch coverage | Stored mapper 87.5%; request pool 100% |
| Fault injection | 7/7 killed by unit tests and independently 7/7 by property tests; one additional invalid-limit guard mutant killed |
| Secrets/dependencies | Zero changed-line secret findings; dependency manifests unchanged |
| Candidate and deployment | Isolated startup passed; both live services healthy; public assets updated |

The sole full-suite failure is unchanged:
`P3.12: browser specs share one worker-owned database-pool lifecycle`.
It is reported rather than suppressed. Lint comparison retains existing violations
by function/rule despite moved line numbers or changed complexity counts. The
existing NetSuite recovery dispatcher increased from complexity 23 to 25; the new
helpers stay within the configured limit.

The five-source benchmark completed in **8,119 ms** with simulated four-second
NetSuite transforms and peak concurrency three. It exercises the real command
database, processor and HTTP transport; remote service timing and the local
finalizer boundary are controlled. **15 seconds is a target, not a guaranteed
production limit.** Slow NetSuite responses still hold the screen until verified.

## Acceptance coverage

| Behavior | Executable evidence |
| --- | --- |
| Webhooks, incomplete orders, progress preservation | `tools/operator-direct-orderline-live.mjs`; guarded `tools/order-line-storage-backfill.mjs`; live JSONL artifacts |
| Exact mappings, inactive PO history, duplicate items and TO stages | `test/mbt/integration/operator-direct-orderline.test.js`; unchanged `sn1400625-receiving.test.js` and order-line storage tests |
| Exact confirmed quantities; no cached clamp or live source read | Direct mapping unit/property cases and actual HTTP tests |
| Correct source, type, quantity and reference verification | Direct service tests plus unchanged posting domain/adapter tests; SN1400625 memo and `custbody9` assertions |
| Fresh attempts, lost responses, parent claims, partial batches | `operator-direct-orderline-http.test.js`; direct service properties; existing repository/state-machine tests |
| Legacy compatibility and quantity drift | Unchanged `consolidation-load.test.js` and existing posting regressions |
| Bounded concurrency and latency | `operator-direct-orderline-pool.test.js`; five-source HTTP benchmark |
| Photo timing, local-only paths, delayed confirmation | Direct client tests, existing photo worker tests, Chromium browser tool and cache contracts |

RED evidence was retained for fresh-call behavior, mapping failures, UI progress,
pool behavior, legacy recovery routing and verification-permission failures.
Regression exposed the legacy lookup mismatch and the missing cache-version
assertion update; both were corrected. Repeated test execution exposed durable
fixture claims, fixed by cleaning up that fixture's own commands. Assertions were
not weakened to accept posting failures.

## Reproduce and audit

Base commit: `8640191ca7709a882c00bb684dfe24db10b03b2d`.
Final validation manifest hash:
`bb61e15e27364c27bcc677fcb81d391ac309e76a0a6615a22a9bebeeb274598b`.
Per-file hashes and changed lines are in the generated `changes.json`; the full
run also captures `full-source-state.json`. This report is written afterward.
Tools: Node 20.20.2, PostgreSQL 18, dependencies pinned by `package-lock.json`, and
the repository's Docker test/Playwright images.

From the repository root, the complete validation entry point is:

```sh
sudo -n bash server/tools/operator-direct-orderline-gauntlet.sh
```

If the existing test images are unavailable, rebuild them from the pinned
`server/Dockerfile.test` and lockfile before running that command:

```sh
docker build --target test-base -f server/Dockerfile.test -t mbbs-retired-confirm-test:20260914 server
docker build --target test-e2e -f server/Dockerfile.test -t mbbs-mbt-p1-test-e2e:latest server
```

Generated logs, snapshots, coverage, screenshots and summaries are under
`server/test-artifacts/operator-direct-orderline/`. Deployment preparation,
configuration comparisons and rollback image metadata are under
`/home/ubuntu/operatorapp-deploy-backups/operator-direct-orderline-20260916-v3/`.
The environment switch defaults off in code and can restore legacy admission;
the saved image provides full release rollback.

Known limits: cached state can become stale between sync and posting, in which case
NetSuite may reject the transform. NetSuite preferences determine which exact
quantities it accepts. Not every defensive optional-cache branch was exercised.
Production completion latency must be measured from normal operator work.
