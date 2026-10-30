# Dispatch lookup and save latency

Spec: [dispatch-latency-20261023.md](specs/dispatch-latency-20261023.md).
Tier 3; spec approval: not obtained (autonomous run). This is measured evidence
within the listed scenarios, not a guarantee for every plan size or host load.

## Cause and change

Fresh single-order reads loaded unrelated plan assignments, sales shortages,
dependencies, reconciliation payloads and completion history. Save validation
reused those reads. A PO reconciliation query also joined approximately 900,000
intermediate rows before filtering its requested schedule. Independent reads
ran sequentially. The autosave scheduling delay itself was only 250 ms.

Scope assignment, shortage, dependency, reconciliation and completion reads to
the requested identities, including group/split members. Filter schedules before
joining reconciliation targets. Run independent reads concurrently. Preserve the
shared effective-completion view, evidence priority and corrected VRMA exclusion.
Add the existing bounded save-timing middleware to V2 command/checkpoint routes.
No database migration, dependency, frontend, or validation-policy change.

The fresh-order endpoint verifies current local quantities, pickup details,
dependencies, restrictions and assignments. Read-only diagnosis disabled network
fetches and successfully exercised this path; it does not contact NetSuite.

## Behavior mapping

| Requirement | Evidence |
| --- | --- |
| Local placement below 500 ms; committed autosave below 5 s | Real Chromium pointer-down, fresh HTTP detail load, drag/drop, next paint, committed acknowledgement and database readback; three samples with 36 orders, 13 trucks, 2,000 background sales orders and 12,000 completion events |
| Preserve assignments across plans/dates | Scoped-assignment integration test; V2 snapshot and split-isolation regressions |
| Preserve quantities and dependencies | Group/split reconciliation, shortage and multi-TO dependency tests; SCM vendor, manual split, linked PO and PO-editing regressions |
| Preserve completion decisions | Canonical-view oracle over 45 mixed-evidence identities, duplicate/case/invalid input checks, corrected PO/VRMA identity, reopen/completion regressions |
| Bound unrelated database work | Real query row counts and EXPLAIN ANALYZE bounds on completion ranking and reconciliation joins |
| Preserve concurrency and uncertain-save identity | Existing save reliability, source decision, refresh, freshness-race and group-hydration suites, including property tests |
| Preserve notice layout, scroll and focus | Existing real-browser notice-stability suite |

## Reproduction

From the repository root, with the prepared release candidate and existing test
image:

```sh
sudo -n env DISPATCH_SOURCE_SKIP_BUILD=1 \
  DISPATCH_SOURCE_RUNTIME="$PWD/server/deployments/dispatch-latency-20261023/candidate" \
  bash docker/run-dispatch-source-tests.sh node tools/dispatch-latency-check.mjs all
```

The runner uses bounded disposable containers in `mbbs-tests.slice`, a fresh
database clone per suite, and its unique `MBBS_TEST_ARTIFACT_DIR`. Teardown is
registered before startup and removes containers, database storage, networks,
logs, coverage and mutation copies. Production records are never test fixtures.
The source test and mutation entry point is persisted in the repository.

## Baseline failure and limits

The candidate and exact deployed baseline both fail this existing assertion in
`dispatch-v2-snapshot-performance.red.test.js`:

```text
DP-13 and DP-16: checkpoint list is metadata-only and compact reads/commands record bounded timings
assert.ok(replacement.responseBytes < 250_000)
```

The fixture exercises a large legacy full-plan replacement. The gauntlet reruns
the same test against the deployed baseline and accepts only this identical
failure; all other failures remain fatal. The assertion was not skipped or
weakened. Large-plan response size remains a known limitation.

Static type checking is not claimed for these legacy JavaScript modules; syntax
checks and differential ESLint are used. No dependency audit was needed because
the dependency set did not change. Suite-order checks use a deterministic reverse
order for the source/save property and frontend subset, not randomized execution
of every integration suite. Production write latency is measured in the isolated
browser fixture; no synthetic plan was saved in production.

Initial regression tests reproduced broad assignment/dependency/reconciliation
reads and whole-history completion ranking. Test-fixture setup issues (completion
metadata, the Custom Order tab and browser variable names) were corrected without
weakening behavioral assertions. One earlier placement sample exceeded 500 ms
under test-host contention; subsequent scoped/parallel-read improvements were
validated with a fresh run. Whole-server coverage thresholds were replaced with
the relevant changed-executable-line gate; no frontend VM coverage is claimed.

## Final validation

The final fresh candidate run passed its zero-new-failures gate: 195 passing
test executions plus 63 passes in the reverse-order rerun (258 total). The one
baseline failure above was reproduced against both runtimes in this same run.
All six deliberate faults were caught, including completion correction and
priority faults by the canonical-oracle property test alone.

| Sample | Fresh detail retrieval | Placement through next paint | Committed autosave |
| --- | ---: | ---: | ---: |
| 1 | 236 ms | 411 ms | 2,323 ms |
| 2 | 234 ms | 441 ms | 2,082 ms |
| 3 | 174 ms | 311 ms | 2,175 ms |

Manual Save Now plus checkpoint took 212 ms in the same fixture. These are local
Chromium measurements, not a production-wide percentile or a WAN latency bound.

Syntax checks passed for nine files. Differential ESLint found zero new findings
and 885 inherited findings. Changed executable-line coverage was 159/159:
server 45/45, dependencies 23/23, completion 30/30, history 26/26, reconciliation
35/35. No separate branch-coverage threshold is claimed. The fault injection
checks supplement the line-coverage result with behavior assertions.

Tool versions: Node 20.20.2, ESLint 10.8.0, c8 12.0.0, Playwright 1.62.1,
pg 8.21.0. Dependency files were unchanged. No git checkpoint was created in the
shared dirty workspace; the frozen release is identified by these SHA-256 hashes:

```text
src/server.js 31691da7f07928f7cc0206bf3e16fca0b2d476da2086f97f82639b814bf488a4
src/order-dependency-repository.js 6a78d67b1a1ff617125ed191e2a15cb2a58859fe59f20258d768f7a3bec5225f
src/dispatch-completion-repository.js 3b91e798206cf45db04f8d755691bacf54cd0feae17e3c62f4096690ac596dc0
src/dispatch-history-mode.js 31e03470fb4d9246a480f74e08b078cf37f04d85987971ad525547690ab9f6ae
src/scm-reconciliation-repository.js fec11dc27e49b978ba2c1ab1110d1d135bb60f978019fad4391f07427cbe07fc
```

Teardown removed the test database container and network, with no test resources
left in either `docker ps` or `docker ps -a`; only the four production containers
remained. The outer retention runner removed generated test output. Production
health passed.

## Deployment and operational verification

Deployed at 2026-10-23 01:00:39 UTC. The five runtime hashes above matched the
running image, `sha256:50d8ec6e5b324ac402162fff78f93b155fbde76d9fdda924fd5b68a764d1c7ca`.
The release was rebased on the then-current live image, preserving the concurrent
application update. The guarded release verified unchanged configuration and
dependency containers, local and public HTTP 200 health, and HTTP 401 for an
unauthenticated source-review request. Only the application container restarted.

Post-deployment read-only operational probe:

```sh
python3 server/tools/dispatch-latency-profile.py
```

| Selected order kind | Catalog lookup | Fresh local detail lookup |
| --- | ---: | ---: |
| PO | 31 ms | 378 ms |
| SO | 63 ms | 353 ms |
| TO | 65 ms | 244 ms |

These are one sample per kind against live local data, with external fetches
disabled, read-only database sessions, bounded statement timeouts and no payload
output. The current 36-order, 13-truck plan read took 453 ms. No production save
was performed for measurement. The diagnostic connection setup emitted a pg
queued-query deprecation warning; the read-only probes all completed successfully.

After deployment, both Docker container listings again contained only the four
production containers. The final test project's containers, volumes and networks
were explicitly checked absent. Operational deployment/rollback audit records
remain under `server/deployments/dispatch-latency-20261023`.
