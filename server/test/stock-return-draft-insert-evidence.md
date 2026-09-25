# Stock return draft insert fix — 2026-09-18

Deployed `mbbs-operator-app:stock-return-insert-20260918`. Application health
returned HTTP 200 with `ok: true`. The one active stock/combined draft retained
the same ID and payload fingerprint across deployment. No real return was
submitted during verification.

The running application attempted to insert 36 expressions into 35 stock-line
columns. Its parameter array already contained the correct 34 values; the
remaining value is an intentional SQL NULL. Removing the extra placeholder
aligns the final rate, estimate and two JSON snapshots with their columns.

The working tree already contained this correction within other unreleased
Return Authorization changes. The release was built from the captured running
image with only this SQL line changed. It includes no schema or gate changes.

Specification: [stock-return-draft-insert-spec.md](stock-return-draft-insert-spec.md).
Spec approval: not obtained (autonomous run under the bug report).

| Check | Observed result |
| --- | --- |
| Original running source | Four regression scenarios reproduce the SQL error; invalid-input protection passes |
| Release database tests | 5/5 pass, including 24 generated fractional quantity/rate cases |
| Built image with its own production dependencies | Same 5/5 pass |
| Existing return repository harness | Pass |
| Changed SQL line | 1/1 executed against PostgreSQL |
| Deliberate faults | 5/5 killed; extra expression, swapped rate/estimate and swapped JSON snapshots also killed by the generated property alone |
| New test/check tooling lint | Pass, zero warnings |
| Runtime lint | 95 baseline diagnostics before and after; zero new |
| Runtime type comparison | 1,475 baseline diagnostics before and after; zero new |
| Syntax | JavaScript, Python release helper and shell runners pass |
| Secret scan | No findings in the release patch; no dependency changes |
| Full current workspace | 512/526 files pass; 14 unrelated baseline failing files |
| Workspace return suites | All 37 existing RA tests plus the 5 draft regression tests pass |
| Release boundary | Captured base image layers plus one file layer; source hash matches verified candidate |
| Deployment | App restarted successfully; 1/1 saved drafts unchanged |

The full workspace run is a baseline for other existing workspace changes:
this task made no workspace runtime edits. Its failures cover old cache-version
expectations, browser-fixture infrastructure, migration inventories and unrelated
local-load/background/display test files. Exact failing files and test names are
preserved in [the baseline record](stock-return-draft-workspace-baseline.json).
The rerun script rejects any additional failing file or test name. None of those
workspace changes were incorporated into this release.

Acceptance mapping:

- Field alignment, normal draft consumption, stored photos and replay identity:
  `normal stock draft preserves every line field...`.
- Distinct quality reasons and combined PALLET records/photos:
  `quality stock draft keeps separate reasons...`.
- Transaction rollback and recovery after a second-line database failure:
  `failure on the second stock line rolls back...`.
- Invalid/negative/zero/excess and injection-shaped input retains the draft:
  `invalid and excess stock quantities...`.
- Fractional quantity/rate persistence and exact rounded estimates:
  `generated fractional quantities and rates...` (seed 91826, 24 cases).

Verification setup issues were corrected without weakening assertions: repeated
test runs initially retained synthetic reservations, so fixtures now clean up
their own records; lint comparisons ignore shifted autofix byte offsets;
TypeScript's diagnostic exit code is accepted only with identical before/after
output. Docker's build parser did not accept a raw image ID as a FROM reference;
the final build uses the existing local tag after verifying its image ID and
checks the resulting layer ancestry.

Limits: NetSuite and photo-storage network boundaries use fixtures. No live
financial transaction, mobile camera test or browser UI test was performed;
there are no UI changes. The regression file was repeated on fresh databases
and after deliberate faults, but test order was not randomized. Dependency
auditing and migration rollback are inapplicable because neither changed.
The seeded property samples are finite, not exhaustive.

Reproduce from the repository root:

```sh
bash server/tools/stock-return-draft-gauntlet.sh
```

The runner uses captured runtime sources under
`server/test-artifacts/stock-return-insert/baseline`, existing Docker images,
Node v20.20.2 and disposable PostgreSQL 18 databases on internal networks.
If no capture exists, the release helper can capture an affected running app;
reproducing the historical failure requires the original image or saved capture.
The gauntlet prepares and builds the candidate without deploying it.

Base image ID:
`sha256:7c090775306ec5c6af811fa136cab9dd743e5a3335c1e3a833e6e6c783a0715d`.

Verified/deployed `src/return-repository.js` SHA-256:
`b1c0ac2fd56f7627efbffdf641aeea10bf8a9d5531966591fa0b0f8a66394071`.

Logs, coverage, exact one-line patch, release manifest, before-deployment draft
fingerprints, release/rollback Compose overrides and deployment result are in
`server/test-artifacts/stock-return-insert/`. The prior image is retained for
rollback. The webhook worker was not recreated.
