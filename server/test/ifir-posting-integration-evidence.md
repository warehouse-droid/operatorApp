# IR/IF application integration evidence — 2026-10-21

The app integration is deployed and enabled. The original native posting functions
are retained behind `NETSUITE_IFIR_POSTING_ENABLED`; gate-off restores native
routing for new attempts. Kits and unsupported payloads continue using native
posting. Successful RESTlet responses supply the saved number, record and source
evidence to the existing verifier without an additional transaction GET.

Spec: [ifir-posting-integration-spec.md](ifir-posting-integration-spec.md).
Tier 3; **spec approval: not obtained (autonomous run)**. The user authorized
activation, historical replay and retention of the old flow. No schema change,
dependency addition or commit was made. Agent-authored tests provide evidence
within their stated boundaries, not independent proof of all NetSuite behavior.

## Historical replay and its limits

Before each POST, the operational tool read the recorded transaction and checked
its internal ID, external ID, source, original number, items, quantities and units.
It then submitted the original payload with the same external ID. The RESTlet
finds that transaction before transform/save and returns `outcome: "existing"`.

The final run used the **deployed application's actual client**, OAuth handling
and request scheduler:

| Case | Original number | Result |
| --- | --- | --- |
| SO fulfillment with packages and a source Discount line | IF158849 | Existing, same ID/number |
| SO fulfillment | IF158844 | Existing, same ID/number |
| PO receipt with package fields in the request | IR15204 | Existing, same ID/number |
| MBBS-Special Order receipt | IR15202 | Existing, same ID/number |
| PO receipt | IR15201 | Existing, same ID/number |
| Kit fulfillment | IF158771 | Native reader verification passed; no RESTlet POST in final run |
| TO receipt | IR15191 | Existing, same ID/number |
| TO fulfillment | IF158632 | Existing, same ID/number |

Result: **8/8 cases passed; 7 existing RESTlet transactions; 1 native kit;
0 newly created transactions**. A separate process with gate-off returned the
native-routing sentinel without forming a posting request or changing the running
application configuration. Authenticated health checks confirmed deployment 507/1,
contract version 1, PRODUCTION, and both NetSuite write parameters enabled.

These checks validate lookup, saved-data readback, response compatibility and app
integration. **They do not validate fresh production saves, write permissions on
every transaction type, custom-field editing, or save-time workflows.** Local
tests execute the real script with simulated N/record, N/search and N/runtime
boundaries. No fresh production transaction was created as a test.

The native API also omits the four package columns on receipts IR15201/IR15204.
The response leaves them null; existing material verification remains in place.
Requested IF package quantities must match. A preceding kit replay returned
`IFIR_INCOMPLETE_READBACK`; this is retained in the audit and kits route native.

Operational records: `server/artifacts/ifir-posting-integration-20261021/`,
especially `deployed-client-history.jsonl`, `deployed-gate-off.json`,
`history-final-replay.jsonl` and `history-package-native.jsonl`.

## Final candidate checks

All numbers below come from the final candidate run after the last runtime edit.
The subsequent refresh preserved concurrent public-asset changes and verified
that every server source file, dependency manifest, migration and contract stayed
identical to the tested candidate. The refreshed image was then checked again for
exact file hashes and server importability.

| Layer | Actual result |
| --- | --- |
| Scoped baseline | 274 tests: 273 passed, 1 pre-existing failure |
| Scoped final suite | 300 tests: 299 passed, the same 1 failure, 0 new failures |
| Reverse file order | Same 299 passes and 1 baseline failure |
| Changed-line coverage | 199/199 instrumented changed lines covered |
| New client coverage | 158/158 lines; 14/14 functions; 106/111 branches (95.49%) |
| Types | 8,545 existing diagnostics before and after; 0 new |
| Lint / complexity | 153 existing findings before and after; 0 new; new functions within complexity 12 |
| Syntax / secret scan | Seven runtime modules checked; 0 syntax errors or secret findings |
| Property checks | Two properties, 100 generated examples each; seeds 20261021 and 20261022 |
| Manual mutation | 6/6 detected by the combined suite; 4/6 by property tests alone |
| Runtime image | Server imported; all 1,429 runtime file hashes matched |

The unchanged baseline failure is:
`property: a real unapproved PO remains Confirmed until approval, except terminal stages`
in `special-approval-fulfillment.test.js`, counterexample
`[false, true, "mbt_delivery"]`. The complete application/browser/database suite
was not run; the scoped suite covers posting, kits, packages, special/noninventory
fulfillment, split locations, transfer posting, recovery, and the RESTlet.
Dependency audit/license checks were not repeated because dependencies did not
change. Existing type/lint findings are not represented as a clean whole-repo pass.

Mutants: ignored feature gate, mismatched transaction identity accepted, saved
quantity verification removed, package mismatch ignored, forced extra record GET,
and a non-Error transport rejection incorrectly returning native fallback. The
last two survive the property-only suite and are caught by dedicated service and
transport tests. Mutation sources were restored and hashes rechecked.

## Acceptance mapping

| Requirement / failure mode | Executable evidence |
| --- | --- |
| Four transforms return actual saved identity and evidence | Four `IFIR client … returns real saved evidence from the script` cases |
| Old flow and gate preserved | Gate-off/unsupported test; config enable/disable test; native→RESTlet→native adapter test |
| No extra GET on successful completion | `IFIR response finalizes…`, automatic SO and split-parts response tests |
| Quantity, item, unit, source and identity mismatch | Envelope adversarial test; corrupted-evidence property; finalization recovery test |
| No native repost after uncertain response | Timeout, malformed JSON, HTTP failure, saved-ID readback, non-Error rejection tests |
| Only proven pre-save unsupported errors may fall back | Unsupported-kit/inventory response test and retained native adapter tests |
| Packages, discount, special-order and purchase charges | Package mismatch/null receipt tests, discount/special test, source-charge adapter test, live replay |
| Source drift, leases, split parts and retry behavior | Existing operator/adversarial/property/split/transfer suites included unchanged |
| Credential destination protection | Wrong-account/URL/redirect test before token acquisition |
| Deployment isolation and rollback | Image/config hash checks, active-operation preflight, retained previous image and automatic rollback path |

Rollback was prepared and checked; the failure-triggered production rollback
branch was not deliberately exercised against the live app.

## Reproduction and release

Tool versions: Node v20.20.2, fast-check 4.9.0, TypeScript 7.0.2,
ESLint 10.8.0, c8 12.0.0. The persisted harness includes baseline comparisons,
mutation execution/restoration, coverage and cleanup:

```sh
bash server/tools/ifir-integration-checks.sh
```

Exact release-source run, using the prepared release and recorded tooling:

```sh
IFIR_INTEGRATION_IMAGE=mbbs-operator-app:ifir-posting-integration-20261021 \
IFIR_INTEGRATION_SOURCE_ROOT=/home/ubuntu/apps/operatorApp/server/deployments/ifir-posting-integration-20261021/candidate/src \
IFIR_INTEGRATION_BASELINE_ROOT=/home/ubuntu/apps/operatorApp/server/deployments/ifir-posting-integration-20261021/before \
bash server/tools/ifir-integration-checks.sh
```

Deployment tooling: `server/tools/ifir-integration-release.py` implements capture,
public-only refresh, bounded image build/check, validation, apply and verify.
It checks for active business operations before the app-only restart and rolls
back if deployment verification fails. Historical replay and gate checks are
persisted in `server/tools/ifir-history-replay.mjs` and
`server/tools/ifir-posting-gate-read.mjs` for execution in the existing app.

Deployed at **2026-10-21 05:19:30 UTC**. Image ID:
`sha256:6e8f6ec7df25c5ac915edb354f9cea78c5c7378f2616b80d07c4da53db1f4b67`.
Full candidate-tree hash:
`27ff1821b95dcf1f1507a886d2b4d08154c29b2f7e1f46312539b9578aa7335b`.
Per-file hashes, final test report, health responses, configuration comparison,
preflight and deployment result are in
`server/deployments/ifir-posting-integration-20261021/`.

Only seven runtime files and two routing settings changed. Database, worker,
Ollama and production mounts/configuration were preserved. The previous app image
is retained as `mbbs-operator-app:ifir-posting-integration-20261021-rollback`.
See [deployment instructions](../docs/netsuite-ifir-posting-restlet.md) for the
active feature-gate file and switching back to the retained native path.

All test containers and the isolated test network were removed; no disposable
database or volume was created. Both `docker ps` and `docker ps -a` showed only
the four production containers at completion, with the app healthy. Temporary
run directories were removed. Test logs/evidence were retained as the user asked;
production audit and rollback records are separate from disposable test resources.

Earlier failures are preserved: initial tests failed against unwired/stub code;
the receipt package expectation was visibly corrected after native API evidence;
two new type errors and complexity findings were fixed; a temporary output
ownership issue was repaired and cleanup completed; the first release patch was
rejected because live and workspace source differed, so the release was rebuilt
from the live image without including unrelated workspace features.
