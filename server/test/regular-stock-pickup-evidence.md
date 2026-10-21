# Pickup conversion evidence

Spec approval: not obtained (autonomous run). The user explicitly confirmed direct SCM TO creation and deployment after tests pass. Tier 3: order creation, concurrency and role boundaries. Spec: [regular-stock-pickup-spec.md](regular-stock-pickup-spec.md).

Reproduce: `python3 tools/regular-stock-pickup-check.py` from `server/` (uses the existing pinned Docker toolchain, sudo Docker, disposable PostgreSQL on an internal network; live NetSuite access disabled in fixtures). Deployment: `python3 tools/regular-stock-pickup-deploy.py prepare`, then `apply`.

Final source manifest: [checks.json](../test-artifacts/regular-stock-pickup/checks.json). Canonical sorted JSON SHA-256: `a662fb138a8a39bf8711817468b3eeaa65c78af1185037a1a981a7d281336e16`. No dependencies, migrations or git commits added. Release overlays only the 14 listed runtime files on the verified live image; the entire resulting source tree is compared. Other workspace edits are excluded.

| Constraint | Final result / evidence |
|---|---|
| Full regular stock + neighboring suites | 195 passed, zero new failures; one unchanged baseline `src/smart-scm-harness.js`: `Expected active item_master input.` |
| Reverse-order focused suites | 69/69 passed |
| Browser / real app | 19 checks, zero page errors; desktop and mobile screenshots retained |
| Changed executable lines | 378/378; changed branches 357/378 (not complete branch coverage) |
| Types / lint / syntax | Strict core types passed; 22 existing runtime JS files checked, 85 unchanged legacy diagnostics and zero new diagnostics; new pickup module, UI and harness lint passed |
| Mutation | 5/5 plausible bugs killed by regression tests and separately by property tests; restored source rerun passed |
| Generated properties | 600 cases, seeds 296715, 15005, 15006; pickup gate plus delivery safety/gate/lead and expiry boundaries |
| Supply chain / secrets | Package hash unchanged, no new packages; added-line capability/secret scan passed. Existing NetSuite TO adapters reused |
| Complexity / format | Small helpers split normalization, preview, transactional claim, external execution, state recovery and rendering; existing JS style and ESLint used, no separate formatter configured |

Behavior mapping:

- Spec 1: `unit/regular-stock-pickup.test.js`, request integration, generated pickup gate property; prior autoapproval/SO/expiry fixtures now submit Delivery, with their original assertions preserved.
- Spec 2–3: pickup integration validates stale revisions, quantity changes, unknown/replaced/duplicate/omitted items, source equal to destination, 100-line limit, PALLET item exclusion and manual counts. Browser adjusts quantities and source, adds/removes autocomplete items, validates route counts, inspects final safety and cancels without persistence.
- Spec 4: pickup SQL integration verifies before/after saved lines, separate transfers, manual decision event and no SO handoff. `regular-stock-external-workflow.test.js` runs authenticated HTTP, real TO adapter/approval/hydration and real SQL; only outbound HTTP transport is stubbed. It asserts external ID, quantities, correct route, zero SO writes and zero SO dependencies, durable Sales alert and immutable evidence.
- Spec 5: concurrent conversion has one execution; second request is refused. A second route failure resumes the existing transfers, with no repeat of the successful route. A printer failure after a committed TO is recovered by durable state. Missing confirmation, changed confirmation, execution disabled, stock refresh failure and a concurrent revision change leave the draft unchanged. Started pickup quantities, including PALLET, are locked.
- Spec 6–7: old unused pickup approvals appear in the SCM review queue and can be rejected. New pickup Sales SO preview is refused. Browser verifies no pickup SO field, saved quantities/references after reload, readable errors, retry, all-button locking and custom dialogs. Prior delivery SO, non-stock companions, expiry/re-raise, uniqueness, PO proposal carry and completed snapshot checks remain in the suite.

RED / issues resolved: the new pickup gate, Sales state and preview/conversion tests failed against the original behavior/stub (unit RED retained). The additional pallet-lock test failed before the guard (`pallet-lock-red.tap`). A UI contract expected an explicit returned-line status check; the equivalent implementation was retained without relaxing the test. A shared disposable test-network name caused one discarded browser run; each run now has unique resources. Browser coverage needed a checkpoint before leaving SCM settings; the checkpoint preserves executed script coverage. The final fresh run passed every release gate.

Adversarial review: checked invalid/replayed confirmations, non-SCM access, caller-controlled item IDs/conversions, revision races, partial remote success and alternate transfer-edit endpoints. No real user requests or orders were used for write tests. Runtime concurrency relies on the existing NetSuite marker/external-ID recovery and PostgreSQL advisory locks; outage behavior is tested at the transport boundary, not by writing live orders. Browser TO replies use real pickup service/SQL with the NetSuite confirmation boundary supplied by the test; real adapter transport is tested separately. Full app type coverage and complete changed-branch coverage are not claimed. Baseline failure remains disclosed above.

Release verification and any rollback result are stored under `deployments/regular-stock-pickup-20260929/`. Configuration and worker must stay unchanged; live checks are read-only and retain STREQ-000059's saved stock snapshot.

Deployment verified at 2026-09-29T07:11:45.899896+00:00: `mbbs-operator-app:regular-stock-pickup-20260929` / `sha256:58392d694d51de6b139d6ab1239bc60d5a5a9ea3d7cdf179ba7bdd78ca5a5998`. Public asset hashes and health passed; configuration, worker, schema and historical snapshot preserved. NetSuite calls/order writes during live verification: 0.
