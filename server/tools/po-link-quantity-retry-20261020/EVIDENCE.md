# PO quantity correction evidence

Spec approval: not obtained (autonomous run). Tier 3 at the rejected-write /
uncertain-retry boundary. Scope and failure model are in [SPEC.md](SPEC.md).

The original PALLET request exceeded the PO's 23 EACH availability. Its ordinary
Error became HTTP 500, so Dispatch retained the frozen request containing 28.
Subsequent submissions therefore reused 28 even after the input changed to 23.
The four SO/PO capacity errors now return HTTP 400 with
`DISPATCH_PO_LINK_QUANTITY_EXCEEDED`. Quantity checks, transaction handling,
idempotency, error messages, and client retry behavior are otherwise unchanged.

Only `src/dispatch-repository.js` is released. Its SHA-256 is
`ce934035eb6205aeb76af9c7c43b6f874ea3760f075d80a65f70d10b2d3200d9`.
The captured production image is
`sha256:3f310150a681591016227e9ed2c0a4a52d38a385425934fb482ea89d7acd4274`.
The exact candidate runtime tree hash and source manifest are in
`../../deployments/po-link-quantity-retry-20261020/manifest.json`.

Reproduce from the repository root:

```sh
bash server/tools/po-link-quantity-retry-20261020/test.sh \
  node tools/po-link-quantity-retry-20261020/checks.mjs
```

The entry point uses the repository's standard isolated Compose configuration,
synthetic data, `mbbs-tests.slice`, bounded CPU/memory/PIDs/tmpfs, and an EXIT/INT/
TERM teardown registered before startup. Each test suite and mutant also gets
its own disposable database. Logs are retained under
`server/test-artifacts/po-link-quantity-retry-20261020/`.

| Requirement | Evidence | Result |
|---|---|---|
| Reject 28, accept corrected 23, leave 5 open | Real HTTP app and real client retry functions, grouped target test | Pass |
| Four capacity errors are definitive HTTP 400 | Four HTTP cases, original messages and error code checked | Pass |
| No partially saved batch | First allocation rolls back when the second exceeds capacity; corrected 10+13 saves 23 | Pass |
| Genuine 500 / lost response preserve request identity | Two retry tests; deliberate client mutation makes both fail | Pass |
| A repeated successful request does not duplicate allocation | Actual HTTP acknowledgement replay checks one active allocation | Pass |
| Both limits, fractions and reservations remain enforced | Seed 122477, 12 generated quantity pairs × base/physical forms | 24 cases pass |
| Existing PO/TO quantity, split, identity and client behavior | Eight related regression files, including Chromium form submission | 80 pass; 1 unchanged baseline failure |
| Main regression suite | Nine new tests | 9 pass |
| Changed executable lines | c8 and exact captured-baseline diff | 16/16 covered |
| Mutation sensitivity | Four HTTP-status mutations, removed PO guard, discarded uncertain request | 6/6 detected |
| Properties independently detect capacity regressions | Five relevant server mutants against properties alone | 5/5 detected |
| Suite ordering check | Base quantities, new retry suite, save reliability rerun in changed file order | 57 pass |
| Static checks | Node syntax and baseline-relative ESLint | Syntax passes; 4 existing diagnostics, 0 new; added test lint clean |
| Dependencies / capabilities | Captured package files identical; patch inspection | No dependencies, schema, network or filesystem capabilities added |

Initial RED run: 7 failed, 2 passed. It reproduced the frozen 28 request and all
four incorrectly classified HTTP errors. Initial GREEN: 9 passed. The final
fresh run after extending property coverage and negative controls is recorded
in `results/summary.json`, `results/mutations.json`, `results/static.json`,
`results/coverage-changed.json`, and `final-gauntlet.log`.

Known baseline issue: `Dispatch loads the PO-ref search client generation`
expects an obsolete script version in the HTML. It fails identically against
the captured production runtime. Neither that assertion nor the HTML was
changed. A first tooling attempt referenced an unavailable `diff` package; the
runner now uses Python's standard-library difflib, without installing anything.

Limits: the entire unrelated MBBS product suite was not run. The changed
JavaScript module is outside the checked TypeScript configuration, so there is
no static type-safety claim. No load test or new simultaneous-writer test was
added; locking and concurrency behavior are unchanged, with existing retry and
transaction checks retained. Test files run in isolation with a changed order;
the runner does not randomize individual test declarations. Dependency and
license audits were unnecessary because no dependency changed.

The live group changed during the investigation: the original
GOB-122477-122479 was retired, and GOB-122477-122479S3 already had active PALLET
allocation 381 for 23 EACH to LOINC-039852 before deployment. No operational
link or quantity was written by this task. Read-only before/after evidence and
release health/configuration checks are retained in the deployment directory.

Deployment completed on 2026-10-20. Image:
`sha256:f97c532f271cb85338ee03dd3997108bc73591a7407db1162c6defe2bf07ce11`.
The built image matched all 1,419 captured candidate runtime files. Runtime
configuration and dependent containers were preserved. The post-release
read-only probe confirmed HTTP 200 health, the exact fixed source hash, all four
classified errors, and the unchanged active 23-EACH allocation 381. Both
`docker ps` and `docker ps -a` contained only the four production containers.
No test project networks or volumes remained.
