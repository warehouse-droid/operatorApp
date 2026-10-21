# Delivery request enhancement evidence

Deployed on October 13, 2026 after the user explicitly authorized "deploy" and
"deploy the driver PWA as well". The combined release is
`mbbs-operator-app:delivery-driver-20261013`; the live image includes the tested
estimate lookup/unit correction in
`mbbs-operator-app:delivery-driver-est-mainline-20261013`. Both local and public
health checks pass. Deployment details are in the
[combined deployment record](delivery-driver-deployment-20261013-evidence.md).

The subsequent [conversation-only correction](delivery-conversation-only-20261013-evidence.md)
is deployed as `mbbs-operator-app:delivery-conversation-only-20261013`. It keeps
automatic updates in Request history and shows only written Sales/Dispatch text.
Its final fresh run passed 169 tests, 355/355 changed lines, and detected 16 mutants.
The earlier estimate/combined-release results below are retained as historical
evidence for those releases.

Spec: [acceptance criteria](delivery-request-enhancements-20261013-spec.md).
Spec approval: not obtained separately (autonomous run). The user explicitly
confirmed that Loose POS means a whole-number count of loose pallets. This report
establishes the specified behavior; it does not prove that the spec covers every
possible business rule.

| Behavior | Executed acceptance tests |
| --- | --- |
| Conversation after Remarks; Sales/Dispatch authors and Toronto timestamps; separate reply and alert | `integration/delivery-request-enhancements-browser.test.js`: conversation; `integration/delivery-request-enhancements.test.js`: reply/legacy proposal; `unit/delivery-request-enhancements.test.js`: all workflow states |
| Preserve approvals, pricing, times and SO links; reject invalid/stale/cross-yard replies; replay, race and rollback | `integration/delivery-request-enhancements.test.js`: secured reply, rollback/competing replies; `unit/delivery-request-enhancements.test.js`: invalid replies; browser failed-reply retry |
| Full/Loose POS storage and summed trips | Unit/generated quantity tests, integration persistence test and browser POS/BIN form test |
| Aggregate choices; fractional Yard quantities; trusted BIN capacity; quote binding; exact boundaries; BIN-to-POS edit | Unit/generated quantities and paired-yard boundary; integration forged capacity, changed capacity, aggregate mismatch and load-type edit; browser fields |
| Optional EST attachment, persistence, unsaved/saved previews, actual item values and totals, identity and yard checks | `unit/delivery-request-documents.test.js`: default adapters, expanded GET, identity/yard checks; integration EST attachment/edit/role checks; browser preview and escaped content |
| Both teams preview saved linked SOs; current linkage and yard access; original PDF and accessible errors | Unit native-PDF boundary; integration linked/relinked SO preview; browser both-team PDF/error/focus tests |
| Existing approval/expiry, consolidation/pricing, timing, SO linkage, instructions, alerts and filters | Full delivery request regression suite, property suite and delivery instruction HTTP/repository suites |

The final fresh run used the exact estimate-correction candidate image source
over the deployed combined release. The combined overlay was rebased on the
current live application, preserving intervening production changes. All
unrelated source files, configuration, and services are preserved; 1364
source/asset/migration files are verified. The original production dependency
tree imports the application successfully. Only the application was restarted.

Reproduce the complete checks with the already prepared source capture:

```sh
DELIVERY_ENHANCEMENTS_SOURCE="$PWD/server/deployments/delivery-est-mainline-20261013/candidate-source" \
DELIVERY_ENHANCEMENTS_ARTIFACT="$PWD/server/test-artifacts/delivery-driver-release-20261013/repeat" \
bash server/tools/delivery-request-enhancements-test.sh \
  node tools/delivery-request-enhancements-gauntlet.mjs
```

| Layer | Actual final result |
| --- | --- |
| Full scoped regression/acceptance suite, shuffled file order seed 6132026 | 164 passed, 0 failed, 0 skipped; 16 files. Baseline: 139 passed, 0 failed |
| Static types | Scoped domain/expiry TypeScript check passed |
| Lint/complexity | Scoped ESLint passed with zero warnings; maximum function complexity 12 |
| Changed executable line coverage | 331 / 331 executed; Node c8 plus browser V8 coverage, no missed lines |
| Manual mutation | 9 / 9 killed; all temporary copies restored and removed |
| Independent generated quantity properties | 3 / 3 relevant mutants killed by the generated test alone; POS and BIN each exercise 150 generated cases |
| Real execution | Real application HTTP tests with isolated PostgreSQL, plus desktop/mobile Chromium interactions; exact production-image import passed |
| Adversarial pass | Malformed/oversized replies, unauthorized roles/yards, stale races/replays, forged BIN capacity, contradictory quantities, hostile HTML, changed document identities and unlinked SOs rejected |
| Host teardown | Isolated Compose down with volumes/orphans, manual containers removed; docker ps and docker ps -a show only four production containers; no task networks/volumes remain; production health 200/ok |

Manual mutants: omit loose pallets, price Yard quantities as BIN counts, admit
blank replies, skip estimate yard authorization, accept the wrong estimate ID,
confirm instead of replying, reject valid BIN quantities, POST instead of GET
when reading an estimate, and display internal unit IDs rather than labels.
Mutation operates on `/tmp` container copies, leaving
the workspace and release image unchanged.

Tool versions: Node 20.20.2, Playwright 1.62.1, c8 12.0.0, fast-check 4.9.0,
ESLint 10.8.0, TypeScript 7.0.2, pg 8.21.0 and Express 4.22.2. Existing locked
dependencies were installed into a task-specific toolchain with scripts disabled;
the delivery enhancement adds no dependencies and changes no schema or credentials.
The separately requested Driver PWA includes migration 282's diagnostic index.
Dependency/license auditing was omitted because the dependency set did not change.
Formatting/complexity is enforced by the existing scoped linter. No performance
benchmark or version matrix was added because neither is claimed by this feature.
The broader application suite is outside this scoped verification. Source hashes,
suite order, versions, coverage, mutation logs, screenshots and cleanup logs are
saved under `server/test-artifacts/delivery-driver-release-20261013/est-final`.
Earlier implementation, baseline, and candidate evidence is retained under
`server/test-artifacts/delivery-enhancements-20261013/`.

The initial acceptance runs demonstrated the missing behaviors. Additional
regressions caught fractional paired-yard rounding and stale BIN fields when
editing to POS; implementation fixes retained the assertions. Two existing browser
selectors were updated from Quantity to Full POS qty to match the requested label.
The initial cached image lacked development dependencies; the locked toolchain
installation resolved that setup issue, with teardown performed on the failed run.

Live read-only NetSuite verification succeeded for an existing EST with two item
lines and a linked SO's original 1095519-byte PDF. The live account stores estimate
yards on the main transaction line, so lookup prefers the transaction header and
falls back to the mainline yard. Numeric estimate units are resolved to original
NetSuite labels through a read-only query. Both findings were reproduced by
failing regressions before correction; requesting-yard and identity guards remain
enforced. Public/local assets and access protections passed. No production request
or NetSuite transaction was created or modified during verification.
