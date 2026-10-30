# Driver upload wait investigation and verification — 2026-10-23

The upload transport now detects 30 seconds without new bytes and gives storage
15 seconds to acknowledge a fully sent photo. It uses native XHR timeouts,
JavaScript timers, and a deadline check when the page resumes. A best-effort
screen wake lock covers each upload. Existing reconnect and save code is unchanged.

Sety's October 19 photo reached 960,262/960,262 bytes. Its confirmation attempt
lasted 354.694 seconds; the browser was hidden and the 180-second timer ran
173.746 seconds late. That is consistent with suspension/throttling, but does
not establish whether the phone locked, the user switched apps, or another
interruption occurred. Dao's three failed attempts stopped at 55%, 77%, and 83%
with status 0 and a browser network error. The available evidence cannot identify
the physical connection failure. Both drivers' retries eventually succeeded.

The fix bounds stale waits while the browser can execute. It cannot repair a
mobile connection or execute while the OS has suspended the browser. Wake locks
are released when a document becomes hidden and may be denied by the browser.
See the [W3C Screen Wake Lock specification](https://www.w3.org/TR/screen-wake-lock/).
Native XHR timeout updates use elapsed time from the original request start,
as defined by the [XMLHttpRequest standard](https://xhr.spec.whatwg.org/#the-timeout-attribute).

Spec approval: not obtained (autonomous run). The [specification](driver-upload-wait-spec.json)
and [machine-readable evidence](driver-upload-wait-evidence.json) are retained for review.

| Contract | Evidence |
| --- | --- |
| W1: idle timeout, retained photo | Unit W1; property WP2; idle-too-long mutant |
| W2: bounded confirmation, no premature success | Unit W2 and W2/W3; property WP3; both browser confirmation cases |
| W3: advancing bytes renew the allowance | Unit W3; properties WP1/WP2; duplicate-progress mutant |
| W4: native timeout and resume checks | Unit W4 (three cases); property WP4; ignore-resume mutant |
| W5: bounded wake-lock lifecycle | Four unit W5 cases; property WP5; late-wake-lock-leak mutant |
| W6: existing recovery, same photos, no duplicate save | Existing upload/reconnect/lifecycle suites; browser socket failures compare SHA-256 of retried bytes |
| W7: valid storage acknowledgement and cleanup | Unit W2 and existing reliability/lifecycle tests |
| W8: cache update | Release checks verify module/HTML/shell asset agreement and shell v50 |

Final fresh run: 100/100 focused tests passed, then 100/100 in reverse file order.
All 16 new unit/property tests fail against the original module. All five deliberate
mutants are killed independently by unit tests and property tests. Changed executable
lines: 89/89 covered. Syntax, ESLint, existing diagnostic type contracts, and secret
scanning passed. Four real-browser transport cases passed:

| Browser | Missing confirmation → recovered | Dropped upload socket → recovered |
| --- | ---: | ---: |
| Chromium 151.0.7922.34 | 16.123 s | 1.023 s |
| WebKit 26.5 | 16.050 s | 1.044 s |

The network fixtures contain synthetic 2 MiB photos and run only on container
loopback. No production storage objects or database records were written by tests.
All test containers and temporary output were removed; both `docker ps` and
`docker ps -a` showed only the four production containers after teardown.

Reproduce with `sudo -n bash docker/run-driver-upload-wait-checks.sh` from the repository.
The runner uses the existing browser test image and records pinned tool versions
and source hashes in the JSON evidence. It wraps every run in the repository
retention tool, uses `mbbs-tests.slice`, and registers teardown before launch.

Resolved validation issues: the initial socket fixture reused a keepalive connection,
which the browser transparently replayed; a fresh upload socket now exposes the intended
failure. Browser-test nesting was simplified to meet the lint limit. The secret
scanner's two fixed synthetic-ticket findings were annotated using its existing
allow mechanism. Behavioral assertions were preserved.

Limits: no physical iPhone suspension test or historical worker-side request trace
was available. Full application/backend suites and dependency audits were not rerun
because this patch changes only browser upload behavior and adds no dependencies.
The existing type check covers diagnostic contracts, not the entire browser script.
Changed-line coverage was enforced; no separate branch-percentage gate was added.
Production deployment uses the verified three-file overlay, preserves every other
runtime file, and keeps an app-only rollback image.

Deployed at 2026-10-23 03:00:50 UTC. All 1,465 runtime files matched the expected
image; 1,462 unrelated files were preserved. Application configuration and the
database, webhook worker, and Ollama containers were unchanged. Local and public
health endpoints returned 200 and all three public assets matched the verified
hashes. See [deployment audit](../deployments/driver-upload-wait-20261023/deployment-result.json).
Drivers must reload the app to load asset `20261023-driver-upload-wait-v1` and
offline shell cache v50. The old JavaScript can remain in an already open page.
