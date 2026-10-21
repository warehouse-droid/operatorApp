# Special Order email, Note, and failed-request recovery

The application is deployed and healthy. New Special Item SOs and POs explicitly
disable transaction email and copy the public request Note to `custbody7`.
SO delivery instructions and the PO's `for <SO number>` prefix are preserved.
Private Sales remarks are excluded. Confirmed NetSuite creation rejections and
failures before submission release the request for editing and retry. Uncertain
submissions, duplicate identities, and known remote orders retain duplicate protection.

SPREQ-000068 was unlocked after verifying its original HTTP 400 email rejection,
an empty live marker search, and a missing external ID. Sales subsequently created
**SOB122474** (NetSuite ID 1051944). A read from NetSuite confirmed `toBeEmailed=false`,
external ID `MBBS-SPECIAL-SO:174`, populated `custbody7`, and Pending Fulfillment.
SPREQ-000021 remains manually linked to **SOB122473** (1052059), with its error
cleared. This task did not update that manually created order's NetSuite Note.
The exact Poly Priime customer (13963) is synced and available in the SO picker.

Spec approval: not obtained (autonomous run). Tier 3, because order creation is
financial work. The append-only specification is `test/special-so-email-note-spec.md`.

## Verification

Final run completed at 2026-10-09T21:04:46.786Z:

- Special Item workflow suite: **123 tests, 121 passed,
  2 unchanged pre-existing failures, zero new failures**. Reversing the file order
  produced the same result.
- All **44 tracked changed lines** executed under coverage.
- **650 seeded property examples**, including multiline Unicode
  notes and confirmed-versus-uncertain rejection classification.
- **9/9 manual mutants killed**. Four applicable payload/classifier
  mutants were also killed by property tests alone. Service-forwarding and database
  state mutants were checked by the corresponding focused service/integration tests.
- Repository-configured lint, JavaScript syntax checks, and the secret scan passed.
- Transitive strict JavaScript types: baseline 8085 diagnostics;
  candidate 8080; zero new diagnostics and
  5 resolved by the failure-handler annotation.
  This is a baseline comparison, not a clean-type claim. The only text normalization
  removes the newly printed `toBeEmailed` member from pre-existing inferred-type errors.
- No new dependencies or migrations. Production capability scope is unchanged.

The two baseline failures are:

1. `multi-line case transitions atomically from Sales to SCM and back to an exact SO draft`
   (existing customer fixture assertion: null versus 8880001).
2. `Sales and SCM Special tabs are real feature-gated interfaces`
   (existing UI source assertion expects `/\["PLT"/u`).

Behavior-to-evidence mapping:

| Requirement | Evidence |
| --- | --- |
| SO creation paths disable email and preserve public Note | `special-stock-request-service.red.test.js`, `special-stock-request-netsuite.red.test.js`, actual SOB122474 read |
| PO Note retains SO reference; private remarks excluded | Same unit tests and `special-so-email-note.property.test.js` |
| Delivery instructions and multiline text survive | Note property suite and instruction-removal mutant |
| Confirmed rejection reaches automatic unlock | Service regression tests and real database tests in `special-order-rejection-unlock.test.js` |
| Editing and a fresh claim work after rejection | Real draft-save and operation-claim calls in the unlock integration tests |
| Unknown outcomes, stale owners, and linked orders stay protected | Classifier properties, existing recovery tests, unlock integration tests and state mutants |
| Existing delivery-date rejection remains editable | Real claim/submit/release/save integration regression |
| Unrelated attention and manual SO linkage are preserved | Integration attention assertion and live request checks |

## Reproduction and deployment

From `/home/ubuntu/apps/operatorApp`:

```sh
bash server/tools/special-so-email-note-test.sh final
```

The launcher uses the repository's isolated Compose configuration, bounded
`mbbs-tests.slice` resources, an internal disposable database, captured production
source plus the three changed files, and the existing dependency cache mounted
read-only. Its EXIT trap runs `down --volumes --remove-orphans` and records both
`docker ps` and `docker ps -a`. Test databases are removed; logs remain in
`server/test-artifacts/special-so-email-note-20261009/`.

Toolchain: `{"c8": "12.0.0", "eslint": "10.8.0", "fast-check": "4.9.0", "node": "v20.20.2", "typescript": "7.0.2"}`.

Deployed at 2026-10-09T21:05:25.214718+00:00; image `sha256:fe13e49613b2ae56ceacbe15d58c284086e5a4a3f0ecf68940f6fb8650d9c3c2`.
Only the app service changed. Worker, database, and Ollama container IDs were
preserved. The release layered only three files onto the live app image and
preserved the complete existing Compose configuration. Source hashes were checked
against the final test result before and after deployment. Rollback commands and
image evidence are retained in this deployment directory.

Source hashes:

```json
{
  "src/special-stock-request-netsuite.js": "ee11de4d756bf8611cc094f24168552ca8890440548397d1a83fe910a320195e",
  "src/special-stock-request-service.js": "fa7e6e92cb35c5b5eced00dd4239092754c4c7cfd0fedd0f2611369df144936d",
  "src/special-stock-request-repository.js": "06564526fc4cdce854d2e38bd2ba2e87a49308d9309b3b81ad7a22d9718a74d6"
}
```

Operational audit files are retained in the production `/app/data` volume:

- `customer-sync-poly-priime-0f85ed7d-f6fd-42ff-9d57-003ef26e61f8.json`
- `spreq-000021-manual-so-link-943e75b7-68aa-40b0-858d-f7720840d37c.json`
- `spreq-000068-email-rejection-unlock-92f19b22-116f-4ab2-b349-7c3aedfc1591.json`
- `spreq-000068-created-so-verification-20261009.json`

## Limits and corrections during verification

The full repository suite was not run; verification covered the complete existing
Special Item suite plus the affected payload, service, database, and property
regressions. No intentional failing SO/PO was submitted to live NetSuite. The
successful live SO was created by Sales after the release. No PO was created for
testing. Dependency auditing was unnecessary because dependencies did not change.
Production source syntax and transitive types were checked; the repository's
lint rule set primarily enforces the test and support files in this scope.

Initial test setup used an image without the required modules; the existing
complete dependency cache resolved that without installing packages. New fixtures
were corrected to use the valid `PCS` enquiry unit and paired order ID/reference
fields. Their behavioral assertions were preserved. A coverage check also exposed
the need to run the existing delivery-date rejection behavior through the modified
failure handler. New type diagnostics were fixed with explicit annotations; the
gate permits resolved baseline errors while still rejecting every new diagnostic.
Failed runs and their cleanup evidence were retained. The first email/Note release
and its verification are archived under `release-1/`.
