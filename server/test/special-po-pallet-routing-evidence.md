# Special PO PALLET and SCM routing evidence

The fix is deployed. SPREQ-000017 now recognizes POB03976's existing PALLET
(1 EACH, purchase cost 35), and its unreviewed-item attention flag is false.
PO creation has separate PALLET quantity and purchase-cost inputs. After PO
creation, the request includes the PO Split routing and notes controls, with
a link to the existing quantity-splitting page.

Spec approval: not obtained (autonomous run under the user's requested fix).
This Tier 3 report provides evidence within the
[recorded specification](special-po-pallet-routing-spec.md); it does not
provide independent human review of that specification.

| Spec behavior | Verification |
| --- | --- |
| 1. Separate purchase review; one persisted PALLET; replacement/removal; unchanged SO | Unit `PALLET uses reviewed purchase cost independently of the SO rate and zero omits it`; database `PO preparation stores one reviewed PALLET, replaces it on retry and removes it at zero` |
| 2. Reject missing/hostile review; atomic rollback; revision/submission guards | Unit input-boundary test; database missing/invalid review and stale-revision tests; browser required-field and failed-draft test |
| 3. Include PALLET once; material-only vendor discount; retain submission recovery | Unit payload test and 200-run fast-check property; existing standalone PO boundary/lost-response tests. One existing real-service recovery fixture remains blocked by missing NetSuite REST configuration, as recorded below. |
| 4. Show routing and notes after creation; preserve split link and locks | Routing unit gating/escaping tests; browser `created PO routing edits every field using the existing schedule API and exact revision, preserving failed drafts`; mobile overflow assertion |
| 5. Use authoritative PO identity/revision; ignore stale loads; preserve failed drafts | Browser schedule request assertions, late-response case switching, mismatched-catalog retry; routing derived-status and missing-map tests |
| 6. Reconcile SPREQ-000017 without remote order changes | Guarded live repair transaction and audit; exact PO identity/description/count/cost checks; unchanged canonical order rows and SO/material expected lines; read-only live payload/render check |

The final isolated gauntlet ran after the last runtime edit. Results and
source hashes are in
[checks.json](../test-artifacts/special-po-pallet-routing/checks.json).

| Layer | Command or persisted runner | Actual result |
| --- | --- | --- |
| Affected tests | `node tools/special-po-pallet-routing-check.mjs` | 43 tests: 41 passed, 2 failed; zero new failures. All 15 new tests passed. |
| Syntax | Same runner, `node --check` on each runtime JS file | 5/5 passed |
| Types | Same runner, baseline/current TypeScript comparison | Zero new diagnostics; new routing and purchasing helper modules pass independently |
| Lint | Same runner, existing ESLint config | Existing runtime diagnostics unchanged; new routing module, tests and check runner pass with zero warnings |
| Changed JS coverage | `node tools/special-po-pallet-routing-coverage.mjs` | 170/170 changed executable lines covered; 159/182 measured branches covered |
| Manual mutation | Check runner, six isolated mutations | 6/6 killed by assertion failures; the three arithmetic/payload mutants were each killed by the property suite alone |
| Properties/adversarial inputs | New PALLET unit suite | 200 deterministic generated cases, seed 2026093017; explicit missing, boolean, fractional, negative, infinite, excessive and overflow inputs |
| Suite health | Check runner, new suites in reverse order | 15/15 passed again |
| Secrets | Check runner plus `extra-secrets` command in verification script | Runtime/tests/check runner passed; six release/repair/verification helpers passed with no high-confidence findings |
| Final helper syntax | Verification script | Read-only live helper and shell entry point passed syntax checks |
| Actual release candidate | Deployment `prepare` action | Captured live-source candidate: 43 tests, 41 passed, the same 2 baseline failures, zero new failures; production-dependency server import passed |
| Production execution | Deployment `apply`, `verify`, `live-check` actions | Health and public assets passed; all 1,167 runtime source hashes verified; live PALLET payload and routing render passed |

The two failures existed before this change and remain unchanged:

- `SCM requires a percentage per material, retains distinct failed inputs, and sends gross costs`: its existing currency-text expectation differs from the rendered localized currency.
- `real order service persists submission and recovers after SO patch success before PO creation`: `Missing required config: netsuite.restBaseUrl` in the existing isolated fixture.

The six mutations simulated dropping PALLET, using the SO sale rate, discounting
PALLET as material, skipping PALLET persistence, sending zero from the browser,
and bypassing the stale request revision guard. Each was restored, and the
runner asserts that source hashes remain unchanged afterward.

The first database run revealed that ancillary PO rows were forbidden by the
existing check constraint. The specification records that finding and the
narrow migration: only item 1784 may be an ancillary PO row, with one such row
per request. Database tests apply the migration inside rollback transactions
and verify both constraint rejection and uniqueness. Type/lint findings were
resolved with DOM/JSDoc declarations. Coverage initially omitted one browser
fixture's differently named coverage files; merging both actual browser
coverage sources corrected the measurement. Existing regression assertions
were retained.

Reproduce the isolated checks from the server directory:

```sh
sh tools/special-po-pallet-routing-verify.sh
```

The entry point uses the existing `mbbs-special-review-runner` and isolated
PostgreSQL database. It refuses production database access and disables direct
NetSuite access. It syncs sources, runs all gauntlet layers, checks final
helpers, and collects artifacts. The recorded tool versions are Node v20.20.2,
TypeScript 7.0.2, ESLint 10.8.0, c8 12.0.0, fast-check 4.9.0 and Playwright
1.62.1. No dependencies were added or changed.

Deployment was limited to the eight runtime files recorded in
[release.patch](../deployments/special-po-pallet-routing-20260930/release.patch)
and the PALLET migration. The patch was applied over captured running sources,
preserving existing unrelated HTML asset versions. App configuration, worker
and dependency services were preserved. An image rollback compose file is
available in the release directory.

- Image: `mbbs-operator-app:special-po-pallet-routing-20260930`
- Image ID: `sha256:8ba7cb26f851d7262f4b11e3dd3021adbf266612760d0434ef268231b87491b6`
- Runtime tree hash: `87e0076cdd74dd4c253fc99fa783df1d293fe7d63207bc7c7120ee1b5d5398a5` (SHA-256 of Python's sorted-key JSON serialization of `source-tree.json`).
- [Deployment result](../deployments/special-po-pallet-routing-20260930/result.json), [repair result](../deployments/special-po-pallet-routing-20260930/repair-after.json), and [read-only live check](../deployments/special-po-pallet-routing-20260930/live-request-check.json).

The local repair linked the already-synced PALLET and reconciled the request;
it submitted no PO and changed no NetSuite order. The live check resolved real
NetSuite units, built the PO payload without submitting it, and confirmed one
PALLET with quantity 1, cost 35 and unit ID 246.

Limits: the full repository suite was not run; testing covered the affected
purchasing and special-request suites. Branch coverage is partial. Browser
tests use the real UI with mocked API boundaries, so a live routing save and a
new NetSuite order were not performed as verification. Dependency audit and
license checks were skipped because dependencies were unchanged. No benchmark
was added because no performance contract or substantial new computation was
introduced. Complexity was checked by separating PALLET normalization and
routing rendering/patch construction from the existing request controller.
No commits or installs were made; source identity is recorded by hashes.
