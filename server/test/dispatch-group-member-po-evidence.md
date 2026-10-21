# Group member PO route correction — 2026-10-01

Completed and deployed. The route for GOM-6255S2-6256S2-6662-6663 now picks up
at TECHO BLOC Vaughan, delivers to its existing customer address, then retains
the existing separate PO drop at 3445. The empty 150 pickup was removed.

The active PO allocations belonged to four individual SO targets. The group
projection queried and applied allocations only for its top-level reference.
Authoritative plan saves stripped cached allocation fields, then missed the
member links when rebuilding them. The correction collects distinct actual SO
member references, recursively, for both querying and applying the links.
It does not include split parents, siblings, or informational CO source children.

Spec: [dispatch-group-member-po-spec.md](dispatch-group-member-po-spec.md).
Spec approval: not obtained (autonomous run). The user explicitly saved and
exited Edit Mode before the live route change. This is tested evidence within
the stated scenarios, not independent review of the specification.

## Acceptance evidence

The eight tests in `test/dispatch/unit/dispatch-group-member-po.test.js` cover:
fully linked groups, partial residual cargo, mixed group/member links and
duplicate aliases, nested groups, S1/parent/CO isolation, cancelled links,
route reload, and 150 generated allocation examples with quantity conservation
and idempotence. Seven tests failed against the previous implementation with
assertion failures. The existing cancellation behavior is also checked by the
active-allocation SQL predicate mutation.

Final runtime source SHA-256:
`062590644ece6e34a6257e24e10b67252301f6ef68d14a8781a22c16d4856ca3`.
Node v20.20.2; test tools are pinned in the existing package lock and the
`mbbs-return-batch-browser-test:20260918` image. No dependencies were added.

| Layer | Actual result |
| --- | --- |
| Focused regression suite | 38 passed, 0 failed |
| Reverse file order / concurrency repeat | 38 passed, 0 failed |
| Broad offline Dispatch suite | 139 files, 770 tests: 724 passed, 46 failed on both baseline and candidate; identical failure names, zero new failures |
| Static checks | Syntax and ESLint passed; 274 existing TypeScript diagnostics unchanged from baseline |
| Changed executable lines | 9/9 covered |
| Manual mutations | 6/6 killed: omit child query, omit child projection, duplicate targets, inherit split parent, include CO sources, include cancelled allocations |
| Exact release-image tests | 38 passed, 0 failed |
| Real execution | Normal plan save rehearsed in a rolled-back transaction; committed with revision, edit-lease, and driver-activity guards |
| Supply chain / capabilities | No dependency, network, filesystem, or environment capability additions to runtime; added source diff checked for embedded secrets |

The broad suite includes existing frontend contract mismatches and tests that
expect a test database. They were recorded rather than edited. A clean full
database integration/concurrency suite was not run for this small read-projection
change. Existing production save guards and a real rollback rehearsal covered
the actual data correction. No new concurrency mechanism or SQL write path was
introduced. No independent manual browser session was used; the compact
Dispatch bootstrap response and physical visit projection were checked live.

Validation entry point: `python3 tools/dispatch-group-member-po-check.py`.
It reruns suite comparison, static checks, focused tests, generated examples,
coverage, and disposable mutations. Detailed reports are under
`test-artifacts/dispatch-group-member-po-20261001/`.

## Release and operational verification

The release overlays only `src/dispatch-repository.js` on the captured running
image. Release preparation and checks used
`python3 tools/dispatch-group-member-po-deploy.py prepare` and `check`; the
`apply` mode deploys with rollback on verification failure. Public/local health
returned 200 and anonymous Dispatch bootstrap remained 401. Runtime
configuration and worker/database containers were preserved.

Image: `mbbs-operator-app:dispatch-group-member-po-20261001`.
Image ID: `sha256:c2be36651db26974601e94cd9f3652cd1acec137265cc6a3d786a0baca7366f5`.
Release metadata: `deployments/dispatch-group-member-po-20261001/`.

`python3 tools/dispatch-group-member-po-live.py preview --candidate` exercised
the normal save path and rolled back. The committed correction used `apply`
with the preview's complete saved-plan/allocation hash, after confirming that
the user's editor had released its lease. Plan 343 advanced from revision 51
to 52. Audit entry: 25483. The private before-image is
`/app/data/support-fixes/dispatch-group-member-po-20261001-1790864702788.json`.
All allocation rows, other load stops, existing delivery stop IDs and addresses
were preserved. Only the obsolete pickup and the existing vendor visit's order
references changed; affected route estimates were invalidated normally.

Read-only postcheck: `python3 tools/dispatch-group-member-po-live.py verify`.
It checks persisted and compact group projections, the shared vendor visit,
absence of a 150 pickup, and the three physical visits. The SO drop's legacy
`location` field remains its source-yard label; its actual physical destination
is still the customer's address, as checked by the shared route calculation.

During setup, the first candidate rehearsal lacked the mounted app configuration;
the runner was corrected to use read-only configuration mounts. An active editor
then correctly blocked commit. The first coverage invocation inherited unrelated
whole-module thresholds; it was corrected to enforce the specified changed-line
coverage. A mutation selector was made unique before rerunning all six mutants.
A duplicate variable in the final support-only physical-visit check was corrected
before the read-only postcheck passed; it caused no database write.
No assertion or production guard was weakened to achieve a passing result.
