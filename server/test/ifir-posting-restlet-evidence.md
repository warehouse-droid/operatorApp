# IR/IF response RESTlet evidence

Tier 3. Spec approval: **not obtained (autonomous run)**. The user authorized the
script and explicitly required retaining the old flow until deployment. The
spec is `test/ifir-posting-restlet-spec.md`; independent human review of that
spec remains outstanding. This report provides bounded confidence in the local
implementation, not proof of target-account NetSuite behavior.

The RESTlet and deployment guide were prepared locally. The implementation task
did not deploy to NetSuite, perform an API write, switch the application endpoint,
change production configuration, migrate the database or restart production.
The gauntlet checked
all seven baseline application/configuration files against their initial SHA256
hashes: unchanged.

## Deployment health check, 2026-10-21

The user subsequently deployed script 507, deployment 1 in account 6518947.
At 04:33:09 UTC, a read-only authenticated GET through the existing app's M2M
connection returned HTTP 200 in 1,683 ms (including authentication). All eight
health-contract checks passed: version 1, PRODUCTION, the four expected
transforms, saved-record readback capability and expected limits. Both
`writesEnabled` and `productionAllowed` were false. The application posting
configuration remains unchanged, and no transaction POST was attempted.

Raw health evidence is in
`artifacts/ifir-posting-restlet-20261021/deployed-health.json`; the operational
probe is `tools/ifir-posting-restlet-live-read.mjs`. Credentials remained in
memory in the existing application container. No test containers were created;
both `docker ps` and `docker ps -a` showed only the four production containers,
with the app healthy. This verifies deployment reachability, authentication and
the GET contract, not transaction permissions, account workflows or live saved
document numbers.

## Source and reproduction

RESTlet SHA256:
`1417ea1730e2cc0398dd5094c9e9a1df91f821294ff48c349882c66f3ab39b09`.
The machine-readable source hashes, commands, results and dependency versions
are in `artifacts/ifir-posting-restlet-20261021/final/report.json`. Source-tree
hashes identify the tested work because the shared repository contains unrelated
concurrent work; this task did not create commits.

Reproduce from the repository root using the existing tooling used in this run:

```sh
IFIR_TEST_IMAGE=mbbs-operator-app:dispatch-editor-control-browser-test-20261015 \
IFIR_TEST_NODE_MODULES=/home/ubuntu/apps/operatorApp/server/test-artifacts/operator-to-yard-flow-tooling/node_modules \
bash server/tools/ifir-posting-restlet-checks.sh
```

The same entry point defaults to the standard `mbbs-mbt-p1-test-test:latest`
image, when that image has been built with the repository's test toolchain.
The runner uses the standard isolated Compose configuration with a small
read-only source overlay. Each run removes its project using
`down --volumes --remove-orphans`. No database service is started for these
checks. All Node test workloads run under `mbbs-tests.slice` with the standard
memory, CPU, PID and tmpfs limits and disposable-test label.

Versions in the final run: Node v20.20.2, fast-check 4.9.0, TypeScript 7.0.2,
ESLint 10.8.0, c8 12.0.0. No dependencies were added or installed.

## Specification mapping

All named tests below are in `test/mbt/unit/ifir-posting-restlet.test.js`.

| Spec behavior | Executable evidence | Status |
| --- | --- | --- |
| Four allowed transformations, actual saved numbers, selected lines, pack fields and references | Four `saved ... response passes the existing posting verifier` tests; reordered lines test; IF header/reference test | pass |
| Never echo requested quantities as saved evidence | Saved quantity change test; identity/missing evidence test | pass |
| PO charge source, rate, amount, units and classifications | Native purchase charges test; missing amount test; post-save classification test | pass |
| No second save for the same external ID | Repeated key test; duplicate race test; changed-request replay test | pass |
| Source/type conflicts do not create another record | External-ID conflict test; saved identity test | pass |
| Ambiguous saves/readbacks retain recovery information | Save exception test; known-ID read failure/retry test; missing assigned number test | pass |
| Invalid/unsupported data cannot save | Invalid fields test; malformed envelope/header test; duplicate line/kit/inventory test; read-limit/search tests | pass |
| Unrequested material is not posted | Reordering test; 100 seeded property examples; omitted-material mutant | pass |
| Mandatory validation remains enabled | Four transform contracts; mandatory-validation mutant | pass |
| Read-only health and deployment-owned activation | Health/activation test; production-gate mutant | pass |
| Returned inventory detail reflects the saved record | Save-workflow inventory assignment test | pass |
| Existing flow stays unchanged | SHA256 comparison of all seven baseline files; 66 existing posting regression tests | pass |
| Live NetSuite fields, permissions, workflow context and native uniqueness | No live deployment or NetSuite credentials used in tests; sandbox validation remains required | unverified |

## Final fresh gauntlet

All figures below come from the successful run after the final implementation
edit. Detailed commands are persisted in the gauntlet entry point and report.

| Layer | Result |
| --- | --- |
| Behavioral stub failures | 25 tests failed against the throwing stub |
| New contracts/adversarial tests | 25 passed, 0 failed |
| Existing posting regressions | 66 passed, 0 failed |
| Reversed file-order repeat | 91 passed, 0 failed |
| Types | 0 errors, using local declarations for the N/* API boundary |
| Syntax | 0 errors |
| Lint/complexity | 0 errors, 0 warnings; maximum function complexity 12 |
| V8/c8 coverage of the new script | 402/402 lines, 42/42 functions, 190/198 branches (95.95%) |
| Property testing | 100 examples, seed 20261021, selected quantities/omitted material/repeated IDs |
| Manual mutation | 6/6 killed by the complete new suite |
| Property-only mutation | 3/6 killed: omitted material, wrong saved quantity, duplicate repost |
| Restored-source verification | 25 passed; original source unchanged by mutation runs |
| Secret scan | 4 JavaScript files, 0 findings |
| Saved-response execution | Actual RESTlet entry point executed with simulated N/* modules; full JSON retained in `final/example-response.json` |
| Old-flow preservation | 7/7 initial source/configuration hashes match |
| Teardown | Test container and network removed; final `docker ps` and `docker ps -a` show only the four production containers; app healthy |

The property-only suite does **not** catch activation, mandatory-field validation
or known-ID error-response mutations. Those are covered by the example-based
contracts. Mutation scores are not evidence that every test independently
verifies every invariant.

## Limits and issues encountered

- Full unrelated application/database/browser suites were not run: the change is
  an unwired standalone RESTlet, and the relevant posting suites were run in full.
- Real NetSuite execution and concurrent writes remain unverified. Native N/*
  boundaries are simulated, including external-ID uniqueness and save failures.
  See the deployment guide for the required sandbox cases. No claim is made
  that local tests prove custom mandatory fields or account scripts work.
- Kits/groups and explicit lot/bin/serial allocation requests are rejected before
  save. Those cases must stay on the existing flow until separately supported.
- Eight defensive/optional branches were not exercised. All script lines were
  executed; line coverage does not imply exhaustive API or workflow behavior.
- The first test attempts exposed an incorrect image working directory and missing
  development dependencies. The runner was corrected to use `/app` and an
  existing read-only toolchain. Behavioral stub RED was obtained after those
  setup fixes and after the initial implementation existed; this was not a clean
  chronological TDD run. The later stale-charge-classification case was observed
  failing before its implementation fix.
- Type checking found missing annotations; lint found an overly complex validator.
  Explicit API/contract types and a smaller validation helper resolved them without
  changing assertions or weakening limits.
- Review found that charge classification could be cached from before save-time
  workflows. A failing test reproduced it, and the readback now clears that cache.
- No dependency audit/license run was needed because the dependency set did not
  change. No load/latency benchmark was run; the HTTP round-trip reduction depends
  on the later application integration, which is intentionally not activated.
- Other isolated test projects briefly ran concurrently on the shared host.
  This task cleaned its own project after every run and did not interrupt them.
  The final teardown listings contained only production containers.
