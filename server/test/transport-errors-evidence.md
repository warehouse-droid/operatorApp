# Transport validation feedback

Specification: [transport-errors-spec.md](transport-errors-spec.md). The user
reported a generic Save route error and authorized a 60,000 lb rating for 14YD.

Read-only investigation found SOB123353 has 12,150 lb of Crusher Run and 5,200 lb
of HPB; the 14YD type's maximum payload was NULL. The backend correctly refused
the missing capacity, but its plain Error was not an MbtError and the router
replaced every transport validation failure with HTTP 500 / MBT_INTERNAL_ERROR.

The new HTTP regression observed six expected validation cases return that
generic response instead of HTTP 409. The real browser also reproduced
“An unexpected error occurred.” where the capacity explanation was required.
The browser fixture's first run failed before reaching the editor because a
catalog-only fixture was absent from the canonical NetSuite list. The fixture
entry point was corrected to open the real editor by reference; its authenticated
options and save requests still use the real server and database. No application
logic was mocked, and the later browser RED is the behavioral reproduction.

| Behavior | Verification |
| --- | --- |
| Six distinct validation failures, stable codes, atomic rejection and successful recovery | `bin-transport-errors.test.js` through the real MBT router |
| 17,350 lb mixed aggregate, fractional recalculation to 8,675 lb, preserved form fields, configured-capacity recovery and linked delivery | `bin-transport-errors-browser.test.js`, real Chromium and database |
| Unexpected failures still redact internals | Existing `pure-contracts.test.js` |
| Quantity, capacity, source ownership, concurrency, Driver completion and linked-route invariants | The entire 22-file transport/aggregate suite and existing properties in both orders |
| Test strength | Typed-error, missing-capacity, understated-weight and excess-weight mutants; weight mutants also run against properties alone |

Reproduce from the repository root:

```sh
DISPATCH_SOURCE_RUNTIME="$PWD/server/deployments/transport-errors-20261024/candidate" \
  bash docker/run-transport-errors-checks.sh
```

The runner records exact versions and source hashes, checks types/lint/secrets,
runs the affected suite with coverage and in reverse order, repeats the reported
browser scenario three times, runs deliberate mutants, and requires every changed
executable JavaScript line to be measured and executed. Tests use disposable
fixtures under the host resource limits. Teardown removes their databases,
containers, networks, temporary files, browser output and coverage logs.

No dependency changed. The release overlays only three runtime files on the live
baseline. The payload operation is separately revision-fenced, changes only the
active 14YD bin type, and records its before/after state. The 60,000 lb rating is
stored conservatively as 27,215 kg in the existing integer field. No customer
order or route is saved on the user's behalf.

Scope limits: these are the affected transport and error-envelope regressions,
not the full unrelated application corpus. Browser fixtures use local source
data and no physical journey or production evidence. Tests verify configured
limits; the payload rating itself comes from the user.

## Final fresh verification

Completed `2026-10-24T03:20:49.721Z` after the last application edit. Source drift: 0.

| Layer | Result |
| --- | --- |
| Full affected suite, 22 files | 62/62 passed, no skips |
| Same suite in reverse order | 62/62 passed, no skips |
| Reported browser scenario repeated | 3/3 passed |
| Static checks | 2 JavaScript files; 0 new lint/type errors; 0 secret findings |
| Deliberate HTTP faults | 4/4 killed |
| Weight faults against properties alone | 2/2 killed |
| Changed executable lines | 24/24 (100%); no unmeasured files |
| Branches on changed lines | 24/28 (85.71%) |

Branch coverage is measured, not exhaustive. Remaining branches include optional
weight-preview defaults; API validation and capacity bounds have direct and
property-based checks. Six existing properties each run 1,000 cases with seed
231026. Source tree SHA-256:
`40b5400e15bb839735d7988b2d4d5d208ff8b2b9db7d1c49acb460ab1692317b`.

Recorded tools: Node v20.20.2, TypeScript 7.0.2,
ESLint 10.8.0, c8 12.0.0, fast-check 4.9.0,
Playwright 1.62.1, pg 8.21.0. The audit is
`deployments/transport-errors-20261024/validation-audit.json`.

Registered teardown passed. Both Docker running/all-container listings contained
only the four application services, with health passing. Disposable test state,
logs, browser files, coverage and mutant copies were removed.

## Deployment and authorized configuration

Deployed `2026-10-24T03:22:03Z` as `mbbs-operator-app:transport-errors-20261024`
(`sha256:c7407ad38b5d4fe03d6b65ee2d85adee6ee6151abf4ca0a4a3790e3b158d582d`). All three runtime file hashes matched the validated candidate;
application configuration and the other services were preserved. No schema
migration was needed.

The authorized payload update changed active type 14YD from NULL to 27,215 kg,
revision 1 to 2. Its before/after record is `payload-configuration-audit.json`.
This rounds the supplied 60,000 lb rating down to the existing whole-kg field.

At `2026-10-24T03:22:43.865524+00:00`, public health and MBT Planning returned 200, public HTML
and JavaScript matched candidate hashes exactly, and the unauthenticated transport
API returned 401. Both Docker listings contained exactly the four application
containers. Disposable resources and test artifact runs were zero. These
read-only release checks and the configuration audit are retained in the release
directory; customer orders and routes were not changed.

Retention completed with production unchanged and healthy. The obsolete sixth
deployment copy was pruned; six operational records were first archived at
`/home/ubuntu/storage-cleanup/retention-audit/20261024T032316-sor-return-source-refresh-records-audit.json`.
The applied retention manifest is `20261024T032428821930Z-plan.json`.
