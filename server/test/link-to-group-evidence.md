# Link TO fix evidence

spec approval: not obtained (autonomous run)

The user requested the three fixes and then completion of deployment within one
hour. The [executable specification](link-to-group-spec.md) records the accepted
scope and the later deployment request. There was no independent human review
of the specification; these checks provide evidence within that specification.

Only eight production files changed for this task. The workspace already had
many unrelated edits. [The scoped patch](support/link-to-group-changes.patch)
and [line/hash manifest](support/link-to-group-changes.json) identify this change
independently of the dirty Git tree. The final checked source manifest is
[source.json](../test-artifacts/link-to-group/source.json), with SHA-256
`5a65444f46367954efe0ec808cdcf9abb773ae907b95884fb7c502167be938ab` over its sorted,
compact `files` object. Starting Git HEAD was
`8640191ca7709a882c00bb684dfe24db10b03b2d`.

| Behavior or invariant | Executable evidence |
| --- | --- |
| Uppercase input, cursor preservation, search, and submission | `mbt/unit/link-to-group.test.js`: typing, matching request, and actual submit-handler tests |
| Case-insensitive lookup retains canonical stored TO identity | `mbt/integration/link-to-group.test.js`: lowercase and mixed-case references; closed/missing references rejected |
| Group first, link second retains the remote TO pickup | Unit tests exercise both group aggregation paths and route reconciliation; integration tests validate dependency routing; HTTP tests reload and save through both classic and V2 endpoints |
| Link first, group second moves dependency ownership | Integration tests check header and line-key updates, unchanged sales-line identities/quantities, idempotence and rollback; HTTP tests cover both saved SOs and previously unplanned pool SOs |
| Multiple linked members retain their cargo once | Actual frontend grouping action tested in both selection orders; 80 generated manifest cases test quantity conservation and uniqueness |
| Explicit pickup references move to the group | Unit test preserves unrelated cargo while replacing member references |
| Started execution and unsupported structure changes remain blocked | UI/repository negative tests and an HTTP test assert the exact recovery response, unchanged active revision and unchanged dependency target |
| Existing sequencing, splitting and stale-command guards | The neighboring Link TO/grouping/quantity-replay suites remain in the focused test packet; stale target signatures and unsupported split/group changes are exercised there |
| No production data migration, dependency update, or unrelated release | Package/lockfile hashes match the starting snapshot; release manifests limit changes to eight files per service; live verification uses `SET TRANSACTION READ ONLY` |

All final results below use source frozen after the last production-code edit.
The full-suite comparison and deployment result are recorded separately below.

| Verification layer | Final result and evidence |
| --- | --- |
| Focused regressions and neighbors | **83/83 tests**, 16 files, including 22 new regression tests. [Final log](../test-artifacts/link-to-group/final-checks.log) |
| Suite ordering | **83/83** again with deterministic shuffled file order (seed 6635). This covers the relevant packet; the entire broad suite was not shuffled. |
| Exact release candidates | **83/83** on each independently prepared app and worker candidate. [App log](../test-artifacts/link-to-group/deployment-20260923/app/candidate-focused.log), [worker log](../test-artifacts/link-to-group/deployment-20260923/worker/candidate-focused.log) |
| Changed-line coverage | **84/84 changed JavaScript lines**, using V8 execution ranges. The remaining changed line is the HTML asset version. Branch percentage is not separately calculated. [Coverage](../test-artifacts/link-to-group/changed-coverage.json) |
| Manual mutation testing | **7/7 faults caught**: lowercase request, lost remote pickup, unchanged dependency target, allowed started grouping, lost member manifests, stale pickup membership, bypassed pool guard. [Results](../test-artifacts/link-to-group/mutations.json) |
| Property tests | 80 generated quantity/manifest cases, seed 66356636. Properties alone kill **1/7** mutants (lost member manifests); the other six are covered by scenario tests, not these properties. Neighboring property suites also pass. |
| Static checks | Syntax checks pass. Scoped ESLint has **0 new diagnostics** (2 existing). MBT TypeScript project has **254 diagnostics versus 257 baseline**, with **0 new diagnostics**. [Static results](../test-artifacts/link-to-group/static.json) |
| Formatting and script checks | `git diff --check` on all eight production files, Python compilation, and shell syntax checks pass. |
| Real execution | Authenticated isolated HTTP link/reload/save flows pass. Read-only execution against the actual GOM-6635-6636 / TOB01135 data preserves pickup yards **150 and 2967**, accepts either TO case and generates a route accepted by pickup validation. [Preflight](../test-artifacts/link-to-group/deployment-20260923/live-preflight.json) |
| Supply chain and secrets | No dependency changes relative to task start; scoped diff secret scan passes. No dependency audit/license scan was added because no packages changed. Production changes add no external-service, filesystem or subprocess capability. |
| Complexity | No new production functions; additions remain inside the existing input, grouping, reconciliation and dependency guards. Reviewed the task-scoped patch. |

The frontend tests evaluate production function bodies and the actual input and
submit listeners. Browser rendering, authorization prompts and transport are
stubbed boundaries. There was no manual browser interaction with live orders;
live checks are read-only, while actual writes are exercised in isolated test
databases.

Initial regressions were observed failing before the fixes. Further checks
found a mixed-case stored-reference regression and an unplanned-pool grouping
bypass, both corrected and covered by the final runs. An initial HTTP assertion
expected 409, but the existing save contract archives blocked drafts with 202;
the specification records this correction and tests now require `applied:
false`, the exact validation code, and no active-plan/dependency mutation.
An earlier test image lacked `pdfkit`; its full-suite result is excluded. The
valid baseline and final suite use the same complete image. Coverage reporting
was corrected to account for ESM `export` declaration offsets; passing tests
alone were not treated as evidence of coverage.

Reproduce the complete verification from the repository root:

```bash
sudo -n bash server/tools/link-to-group-gauntlet.sh
```

The script reconstructs the starting production files by reversing the scoped
patch, runs the baseline and final suites in separate temporary PostgreSQL
databases, then runs static checks, focused tests, coverage, mutations, shuffled
tests and source/secret checks. It uses the pinned local test-image digest
`sha256:a213a201d54066121bc474fd418fe25417cc595bfc4be21abd3cefcd0cd6e6a2`
(override with `LINK_TO_GROUP_TEST_IMAGE` if rebuilding the environment).
[Recorded tool versions](../test-artifacts/link-to-group/tool-versions.json):
Node 20.20.2, ESLint 10.8.0, TypeScript 7.0.2, Espree 11.2.0,
fast-check 4.9.0 and pg 8.21.0; test database PostgreSQL 18.

Deployment is reproducible through `tools/link-to-group-deploy.py` stages
`prepare`, `build`, `check`, `preflight`, `apply`, and `verify`. It captures each
running service separately, applies the scoped patch with zero fuzz, preserves
other deployed changes, checks image hashes and configuration, and keeps both
previous images for automatic rollback if post-cutover verification fails.

Full suite: `npm test` completed against the frozen starting state and final
source. Baseline: **3041 tests, 3020 passed, 20 failed, 1 skipped** across
573 files. Final: **3063 tests, 3042 passed, 20 failed, 1 skipped** across
576 files. **Zero new failures**; the same 20 failures occur in 18 files.
[Comparison](../test-artifacts/link-to-group/full-comparison.json),
[baseline log](../test-artifacts/link-to-group/baseline-current-full.log),
[final log](../test-artifacts/link-to-group/full-final.log).

The retained pre-existing failure names, verbatim:

- `/app/test/mbt/integration/local-load-performance.test.js`
- `/app/test/mbt/integration/operator-background-photos.test.js`
- `/app/test/mbt/integration/operator-display-settings.test.js`
- `Control and Admin request the cache-busted thumbnail hydration client`
- `F06/F16: schema-101 upgrade preserves representative legacy records and is migration-runner idempotent`
- `F15: all MBT routes render one accessible controlled shell with an explicit controller`
- `P2 the installed operator shell precaches the versioned refresh guard and client together`
- `P3.11: the deployment inventory exactly covers every on-disk MBT-era migration`
- `P3.12: browser specs share one worker-owned database-pool lifecycle`
- `S11: the guarded client ships in a new atomic Driver shell generation`
- `S7: Operator cache revision ships the live-policy client once; later toggles are server-only`
- `a failed staging download leaves the active and non-Driver caches byte-for-byte unchanged`
- `a fresh Driver shell version evicts older copy-enabled cached assets`
- `a fresh Driver worker reloads every v41 shell asset and initializes only its scoped sentinel`
- `a successful repair replaces only the complete Driver shell and preserves offline data sentinels`
- `normal stock draft preserves every line field and consumes the draft only on success`
- `operator cache assets advance with the cycle-count pagination release`
- `page confirmation has a duplicate-click guard and ships in a fresh Operator cache`
- `the reset ships as a new atomic shell generation without forcing a protocol-version cutover`
- `the updated override policy is atomically included in the Driver PWA shell`

Deployment completed at **2026-09-23T14:56:44.564019+00:00** on
[Dispatch](https://test.mbbsoperation.com/dispatch.html), within the requested
hour. Both services use their verified candidate images:

- App: `sha256:4cabf942427281b1abcb52344f8ccb5500c0b2a9439dc43e64c4f266f6b23339`.
- Worker: `sha256:a608065777228b96c4f34539915fabcc162a83eee5cc8bffdf090757e4173a72`.

Local and public health returned **200**; anonymous delivery access remained
**401**; public Dispatch asset hashes match the candidate. Both runtime source
hash sets and service configurations match the prepared release. Database and
Ollama containers were unchanged; no migration ran. The post-deployment
read-only check again confirmed case-insensitive TO matching and a valid route
with yards **150 and 2967** for GOM-6635-6636 / TOB01135.
[Initial cutover result](../test-artifacts/link-to-group/deployment-20260923/cutover-result.json).
Verification repeated successfully at **14:57:47 UTC**, with both services
running and zero restarts after cutover.
[Deployment result](../test-artifacts/link-to-group/deployment-20260923/deployment-result.json).
The original images remain available for rollback; no rollback was needed.
