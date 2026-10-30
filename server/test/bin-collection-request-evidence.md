# Explicit BIN collection and price changes — 2026-10-23

Spec: `test/bin-order-workflow-spec.md`, criteria 33–41. Tier 3 (money,
concurrent commands, public APIs, and a guarded production correction).
Spec approval: not obtained (autonomous run); the user directly requested the
behavior and confirmed Soil/Concrete/Asphalt at CAD 300/bin.

The live rate correction uses audited, versioned commands. Soil's CAD 350
version is retained; its new active version and the new Asphalt version are
CAD 300/bin. Concrete stays CAD 300/bin and DumpGarbage stays CAD 120/tonne.
Accepted quote/charge evidence is not rewritten.

## Reproduce

Before release, the candidate was prepared using
`python3 server/tools/bin-collection-request-release.py prepare`. To rerun the
retained exact candidate from the repository root:

```sh
sudo -n env DISPATCH_SOURCE_SKIP_BUILD=1 \
  DISPATCH_SOURCE_RUNTIME="$PWD/server/deployments/bin-collection-request-20261023/candidate" \
  DISPATCH_SOURCE_MIGRATIONS="$PWD/server/deployments/bin-collection-request-20261023/candidate/migrations" \
  MBBS_BIN_SELECTION_EVIDENCE_PATH="$PWD/server/deployments/bin-collection-request-20261023/validation.json" \
  bash docker/run-bin-collection-request-checks.sh
```

The runner uses the existing toolchain and isolated Compose configuration,
`mbbs-tests.slice`, bounded containers, unique disposable artifacts, and registered
teardown. It removes owned containers, volumes, networks and generated logs,
then checks running/stopped containers and live health. No dependency or commit
was added. Source hashes, tool versions, baseline comparison, and concise results
are retained in the operational validation record.

## Acceptance mapping

| Criteria | Evidence |
| --- | --- |
| 33: new rentals/add-bin create D only | `bin-collection-request.test.js`, `frontdesk-workflow.test.js`, `frontdesk-multibin-workflow.test.js`, `customer-charge-request-workflow.test.js`, 25 conversion races |
| 34–35: explicit collection, replay, extensions, replacements and bin assignment | collection-request integration; Front Desk/Dispatch seam; existing workflow, planning, driver and legacy return tests |
| 36: overdue boundary and actual pickup | collection-request integration and browser; 400 overdue property cases |
| 37: guarded withdrawal and rollback | collection-request repair test: rollback/replay, retain due date and cancelled history, reuse C reference only on explicit request; operational before/after audit |
| 38: one logical timeline order | authenticated Front Desk browser with an actual prepared D child |
| 39: Front Desk and Dispatch windows | both browser flows; window integration: unplanned/draft/released, lease/revision/start fences, 8 competitors, rollback, invalid calendar input, same-day exchange rule |
| 40: signed price changes | cash/card garbage→soil→garbage, equal fixed materials, size change and incompatible selection clearing, two competing confirmations, immutable original evidence; 400 difference/deposit property cases |
| 41: fixed rates and completed garbage dumping | versioned-rate rollback/replay tests; real driver completion at 2.25 tonnes, no premature charge, replay/rollback, prepaid Soil, wrong-unit review; 400 exact-cent dump properties |
| Migration failure | `bin-collection-request-migration.test.js`: restores prior constraints, injects DDL transaction failure, compares constraints and existing accepted rows, then applies successfully |

## Development findings and limits

Four original collection regressions were observed RED before implementation.
Expanded tests were added later; this is not a claim that every assertion was
written first. Manual mutants separately exercise both integration and property
assertions. Old tests expecting automatically created C visits were explicitly
updated to criterion 33; legacy fixtures retain the original binding/extension
protections. A pending-exchange availability regression was caught by the
existing browser test and fixed without weakening that assertion.

The zero-difference property initially compared positive zero with JavaScript
negative zero. Reproduced with `[0,0,0,0,0]`, it now checks the independently
computed reversed amount and that both differences sum to zero. The example
remains in every run. Test-harness failures (comparison-copy permissions and a
missing migration mount in one diagnostic invocation) were corrected.

One unrelated baseline test, `the production MBT router is wired to the
server-owned pricing adapter`, expects the pricing option to be first in a
source-code regex. It fails identically on the captured live source, where
other router options precede it. The original test remains unchanged. The
validation gate reruns and verifies that baseline and accepts only the exact
same failure, while preserving the raw exit code and failure name.

Legacy orders without accepted fixed-price evidence require pricing review.
Dump pricing records a local billing trigger after collection completion; it
does not automatically post an external invoice or transfer a refund. Missing
or ambiguous tariffs and non-tonne evidence produce a visible billing-review
item rather than guessing a price.

## Final run

Final exact-candidate run: 2026-10-23T03:50:01.209Z.

- Affected suite: 442/443 passed across 98 files; the one unchanged baseline failure above was reproduced independently. Zero new failures.
- Reverse-order focused rerun: 110/110 passed across 18 files.
- Manual mutations: 8/8 detected, including four property-only runs and the missing legacy-return guard.
- Changed JavaScript lines: 768/768 executed (100%); no unmeasured files. Changed-line branches: 307/348; branch coverage is not claimed complete.
- Static: 15 JavaScript syntax checks; zero new lint/complexity findings, type errors or secret findings; zero baseline type errors in the checked roots.
- Toolchain: Node v20.20.2, TypeScript 7.0.2, ESLint 10.8.0, c8 12.0.0, fast-check 4.9.0, Playwright 1.62.1, pg 8.21.0.
- Source-manifest SHA-256: `fa0e7c5cced3c4d008cbdcbbcbb947198d0719f7ff29ff9a2883d10f904f7d77`. All 18 candidate hashes match the deployed files; no source drift during validation.
- No dependency audit was needed because dependencies did not change. No separate formatting tool or latency benchmark was added; existing lint rules and resource bounds were used.

Released at 2026-10-23T03:50:45Z as `mbbs-operator-app:bin-collection-request-20261023` over the
captured Driver upload release. Application configuration and the other three
production services were preserved. Migration 307 applied successfully; health,
page/asset responses, new endpoint authentication, and deployed source hashes passed.

BIN00003C's untouched automatic draft was withdrawn through the rehearsed command.
The raw cancelled visit and before/after audit remain. The active logical timeline
now contains only BIN00003D; the expected return remains 2026-11-07T02:14:00Z.
No customer payment/refund or external invoice was sent.

Owned disposable test containers, databases, networks and logs were removed.
Final `docker ps` and `docker ps -a` showed only the four production containers;
application health passed. Operational deployment/rate/repair/validation records
remain under `deployments/bin-collection-request-20261023/`.
