# SPREQ-000032 unit lookup and stale validation lock

The SQFT lookup fix is deployed. SPREQ-000032 is at revision 24 with its PO
operation idle, attention false, and the old identity error cleared. The user
will manually link existing POB03988. No PO was created, modified, or linked by
the assistant, and all business fields and order lines were preserved.

Spec approval: not obtained for the initial autonomous implementation. The user
confirmed that they will manually link POB03988, then explicitly reported the
remaining operation lock; the guarded lock repair follows that instruction.
This is constrained evidence, not proof that every possible behavior is correct.

Deployed adapter SHA-256:
`bded6b4da927fb92ba034a9138d59349f7c7f3e1fb5eb242272335a5724339e7`.
Live image:
`sha256:60e3513d9b4c710420e2653017c502422a9fc18efc435c88d2973be04eea7d96`.
Only `src/special-stock-netsuite-adapter.js` was included in the app overlay.
Service configuration fingerprints matched after sorting environment entries and
excluding Docker's generated hostname. The database, worker, and Ollama services
were not redeployed by this task.

## Acceptance evidence

| Scenario from the spec | Verification | Result |
| --- | --- | --- |
| SPREQ-000032 SQFT self-link resolves to 866 with complete values preserved | `special-unit-identity.test.js` observed-response test; live adapter lookup | Pass |
| All four native UOM label fields and both record-type capitalizations | Generated positive property, 100 examples, seed 5102026 | Pass |
| Explicit ID precedence and configured-unit fast path | Generated precedence property, 100 examples, seed 5102028; existing deploy-readiness tests | Pass |
| Reject invalid/foreign/ambiguous native identities | 14 explicit hostile cases; negative property, 100 examples, seed 5102027 | Pass |
| Preserve synchronization, prices, quantities, and retry protections | Entire Special Request unit suite, compared with captured original adapter | Zero new failures |
| User can manually link after failed validation | Rollback rehearsal and guarded commit; final app repository read | Pass: idle, no attention/error |
| Preserve request business data and leave PO linking to the user | Full unaffected-field and order-line comparison within the transaction | Pass: identical business-data fingerprint; PO remains unlinked in app |

## Final adapter validation

Entry point from the server directory:
`python3 tools/special-unit-identity-20261005/run.py`.
The original adapter is included under `baseline/src/`, so the baseline is
reproducible from the repository. The runner uses cached test image
`sha256:087db416dc024ccf13e0b7ea732853e2e93ce3561937f1e301a540a9aab098c7`,
network disabled, source mounts read-only, 2 GB memory, and one CPU.

| Layer | Actual result |
| --- | --- |
| Original adapter regression baseline | 451 tests: 447 passed, 4 failed |
| Patched adapter complete Special Request unit suite | 470 tests: 466 passed, same 4 failures, 0 new failures |
| Focused regression/generated/adversarial tests | 19 passed, 0 failed |
| RED on the captured original adapter | 17 failing cases; 2 pre-existing compatibility cases passed |
| Strict module TypeScript check | 0 errors |
| ESLint and syntax | 0 errors/warnings |
| Changed executable line coverage | 11/11 covered |
| Full adapter line coverage | 100% |
| Manual mutation | 5/5 killed |
| Property-only mutation run | 5/5 killed |
| Generated properties | 3 properties, 100 examples each |
| Reversed unit suite order | Same 466 passes and 4 baseline failures |
| Secret scan | Passed; no dependencies added |
| Real execution | SQFT=866, PC=865, EACH=246; exact input quantities and prices retained; app healthy |

Recorded toolchain: Node 20.20.2, TypeScript 7.0.2, ESLint 10.8.0, c8 12.0.0,
fast-check 4.9.0. The saved `summary.json` records source hashes for that adapter
validation run. Support scripts were subsequently extended for the user's manual
link choice and verified separately with ESLint, a real rollback rehearsal,
the guarded commit, and the final read-only live check. `final.json` identifies
those final support-script hashes; the deployed adapter did not change.

## One-time request repair

`clear-validation.mjs` refuses changes unless request 109 is revision 23,
operation `103a0b2b-5883-41b1-b7cf-0a5ca9bdd859` has the exact identity error,
no PO submission has started, no PO is linked, and no other quantity or
fulfillment operation is active. It locks the request/case in the same order as
the repository, clears only four obsolete validation fields, increments the
revision, and adds one internal audit event. Every unaffected case/request field
and every order line is compared before commit; assertion failures roll back.
The rehearsal rolled back successfully. The committed repair preserved business
fingerprint `ebf0438a01f4e77b98aadc342c3d6505d9a60ac977c7503c4125dc7c0a13489a`.
This script is intentionally restricted to the original failed state and is not
a reusable way to clear unrelated operation locks.

Final production verification is reproducible while the recorded orders remain
in their current state with
`python3 tools/special-unit-identity-20261005/deploy.py verify`.
It reads the app/NetSuite boundaries and checks the manual link block is clear;
it performs no order write or link.

## Baseline failures and limits

The four existing failures were identical before/after and in reversed order:

- Sales and SCM Special tabs are real feature-gated interfaces.
- The filter exposes seven labelled choices, retains multiple selections and allows clearing.
- Native PO recovery before a durable submission updates the existing PO without creating.
- Native PO recovery after a durable submission updates the existing PO without creating.

The repository-wide database/browser suite was not rerun: this release changes
one unit-ID boundary, and the subsequent request reset is a guarded one-time
support action. UI layout, migrations, dependency auditing, and performance
benchmarks were not applicable. Existing app baseline failures remain unresolved.
The user's pending manual link is outside the assistant's requested action.

During setup, the existing shared test runner was removed and an unnamed test
container was externally killed. Validation was rerun successfully in a named,
bounded disposable container. Baseline fixture setup and mutation targeting were
corrected without weakening any test assertion. The first deployment rolled back
on a configuration fingerprint mismatch; all environment values were checked
against the reviewed Compose/image inputs, then ordering was normalized and the
release passed. One readiness probe incorrectly expected SQL null in the API's
error field; the repository serializes it as an empty string, and the final
probe checks that actual contract.

Automatic approval review rejected persisting a full Docker configuration
because it could contain credentials. The safer release stores only source
backups, nonsecret Compose paths, and configuration hashes. No credential values
were persisted by this task.

Oracle's [Unit of Measure REST documentation](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_63210224348.html)
documents the native `/unitsType/<type>/uom/<unit-id>` route. The actual
SPREQ-000032 lookup response supplied SQFT's identity only in that self link.
