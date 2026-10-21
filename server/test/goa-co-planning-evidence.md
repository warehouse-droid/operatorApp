# GOA CO route and planning evidence

1 October 2026. Implemented and deployed the first two reported issues.
Spec approval was not obtained; this was an autonomous run under the user's
request. Acceptance criteria are in [the spec](goa-co-planning-spec.md).

The shared Dispatch formatter passed COs to the SOR projector. Its grouped
branch ran before its SOR delivery check and replaced a CO's route with its
source SO children's pickup yard. Dependency identity collection also treated
those informational SO children as deliveries assigned by the CO's stops.

COs now retain their own route and cargo. Server and browser dependency
collection distinguish CO identities from source delivery identities. Browser
normalization clears inherited delivery prerequisites and ignores them when
placing COs. Actual SO delivery checks remain in place.

| Acceptance | Evidence | Result |
| --- | --- | --- |
| 1. Stored CO route survives formatting and hydration | Pure projector, PostgreSQL feed/catalog, Chromium | 2967 to 3445 |
| 2. CO planning identities exclude source deliveries | Unit/property tests and aggregate CO tests | CO identities retained; SO aliases excluded |
| 3. CO can precede unplanned TO | Real snapshot save, Chromium placement and read-only production validator | Allowed; actual SO delivery still blocked |
| 4. Cargo and source dependency state survive | PostgreSQL source-record comparison and dependency synchronization | No retargeting or source delivery assignment |
| 5. Assignment ordering is consistent | Mixed CO/SO arrays in both orders; explicit forward/reverse test-file spawning | Identical outcomes |
| 6. Existing behavior remains | Adjacent CO/SOR tests, dependency structure harness and full MBT comparison | No added failures |

## Verification

- RED: 10 behavior failures before implementation, including route projection,
  browser placement and PostgreSQL dependency validation.
- All 14 new tests pass. Focused run: 98 passing of 99, with one identical
  pre-existing fixture failure in both execution orders. That failure is
  `loadPreviewOpen is not defined` in the saved-plan CO cargo browser fixture.
- Full default MBT suite: 761 files, 4,178 tests, 4,035 passing, 142 failing and
  one skipped in both baseline and final. The 49 failing files and failure names
  are identical; the full suite is not entirely green.
- TypeScript: the same 274 existing diagnostics; no added diagnostics.
- Changed runtime lint: no added findings; `public/dispatch.js` retains 64
  existing findings. All new JavaScript tests/tools pass the repository's ESLint
  rules with no warnings or errors.
- Changed executable lines: 29/29 covered by c8. This is coverage of the scoped
  changes, not a claim of full-module coverage.
- Five manual mutants were killed: restored route overwrite, restored SO alias
  inheritance, restored CO placement blocking, disabled actual delivery
  validation and disabled canonical catalog route recovery. The first three
  also fail the property test alone, using seed 96119612 and 100 generated cases.
- Real Chromium 151.0.7922.34 executed the production normalization and placement
  functions. Boundary state lookups were supplied by the harness. This was not
  an authenticated interactive session against the live Dispatch UI.
- Dependency structure harness: 17 assertions pass. The unrelated driver-order
  harness has the identical existing `isMbtPlanningLoad is not defined` fixture
  failure on the unchanged app and on the candidate.

The initial full-suite attempts used the wrong browser path and stalled at
browser startup; those logs are preserved. Both final comparisons used
`/ms-playwright` and the same 90-second per-file bound. No final run timed out.
Node sorts test-file CLI arguments, so the final ordering checks explicitly
spawn each file in forward and reverse order.

## Deployment and live verification

Image: `mbbs-operator-app:goa-co-planning-20261001`, built over
`mbbs-operator-app:regular-stock-kit-20261001`. An unrelated release occurred
during verification; the patch was rebased and the four candidate file hashes
remained identical. Only `src/sor-rental-policy.js`,
`src/yard-dependency-structure.js`, `public/dispatch.js` and `public/dispatch.html`
were overlaid. Other workspace edits, app configuration and dependent services
were preserved. The asset version was updated for browser refresh.

The live app is healthy. PostgreSQL-enforced read-only verification of
`CO-GOA-9611-9612` returned pickup `2967`, destination `3445`, zero inherited
dependencies and zero CO-only planning conflicts while `TOB01180` remained
unplanned. The CO row and cargo were unchanged. No operational plan was saved
in production. Dependency deletion was outside the requested implementation.

## Reproduction

Use the existing pinned Docker images `mbbs-regular-v2:e2e` and
`postgres:18-alpine`. Tool versions: Node 20.20.2, ESLint 10.8.0, TypeScript
7.0.2, c8 12.0.0, fast-check 4.9.0 and Playwright 1.62.1. No dependencies were
installed. From the server directory:

```sh
sudo -n python3 tools/goa-co-planning-run.py
```

`--focused` omits the full MBT comparison. The command reconstructs the scoped
baseline from the checked-in inverse patch and uses disposable PostgreSQL and
an internal Docker network, without accessing production data. It rewrites the
task's test-artifact logs. Deployment is a separate operation.

Detailed artifacts are under `test-artifacts/goa-co-planning-20261001`:
`red.log`, `checks.json`, `focused-final.log`, `focused-reverse.log`,
`regression-comparison.json`, `changed-lines.json`, `browser.json`, mutant logs
and `live.json`. Release hashes, rollback configuration and deployment evidence
are under `deployments/goa-co-planning-20261001`.
