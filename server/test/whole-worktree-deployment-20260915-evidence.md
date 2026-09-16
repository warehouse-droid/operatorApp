# Whole-worktree deployment — 2026-09-15

## Result

Deployed the complete application worktree snapshot captured at **17:13:48 UTC**.
The application and webhook worker reached readiness at **17:28:20 UTC**.
Final verification at **17:30:36 UTC** found the app healthy, worker running,
zero container restart counts, and no detected startup/runtime exceptions.

- Image: `mbbs-operator-app:whole-worktree-20260915-v1`
- Image ID: `sha256:33751bfcd646a81190d3f7e380f5e0528f7752574e990e4e0f6cf052b13aa0d9`
- Git base: `c82c71d6632ffef21ff0a77c3dabbce542f805e2`
- Runtime manifest: `8e69903b4c2148f0961586add590c3102d2ccd0c10541489f73645360a1484f5`
- **893/893 deployed files matched in each running service.**
- The release contains 19 runtime file differences from the previously running
  split-address release, including all pending receiving and Smart SCM changes.
- Production environment values, environment files, and mounts were preserved.
  PostgreSQL and Ollama container identities/start times were unchanged.
- All **201 migration files** were already applied, through migration 200. No
  production migration was run.

Deployment was explicitly authorized by the user. The detailed release spec was
not separately reviewed: autonomous execution under the user's deployment
authorization. No dependencies or commits were added.

## Acceptance evidence

| Check | Result |
| --- | --- |
| Complete frozen MBT suite | 475 files; **2,413 tests: 2,410 passed, 2 existing failures, 1 skipped, 0 cancelled** |
| New MBT failures | **0** |
| Dispatch split-address regression selection | **14 passed**, plus sales-split materialization and physical-visit harnesses |
| Production image with development dependencies omitted | Built with the standard Dockerfile; app health and worker startup passed on a fresh isolated PostgreSQL database |
| Browser checks using frozen assets | Receiving before/after and allocated-partial scenarios, Smart SCM current lines/refresh/editor/versioned save, and Dispatch split-address save/reload all passed |
| Browser errors | **0** in those checks |
| Served files | **12/12 hashes matched** at both localhost and `https://test.mbbsoperation.com` |
| Anonymous HTTP access | Dispatch configuration and receiving API returned **401** |
| Live split-PO search, detail and quantities | **163/163 eligible records** searchable with visible lines; typed and untyped lookup passed |
| Live yard boundaries | **163/163** foreign-yard requests denied |
| Dispatch read models | Catalog and assignments ready |
| Webhook queue at final verification | 5,651 succeeded, 29 superseded; no queued, running or failed records |

The two unchanged MBT failures are:

1. `P3.12: browser specs share one worker-owned database-pool lifecycle`
2. `quality non-regression: the gauntlet builds and validates the omit-dev runtime`

The latter is an existing infrastructure contract failure. This release separately
built and started the actual production image with development dependencies omitted.

The receiving and Smart SCM runtime hashes match their final feature evidence:
all six receiving runtime files and all six Smart SCM backend files were checked.
The existing feature reports retain their coverage, mutation, property, lint,
type-checking and adversarial evidence; these implementation layers were not
repeated for deployment because their tested runtime code did not change.

- [Receiving implementation evidence](operator-receiving-identity-evidence.md)
- [Smart SCM implementation evidence](smart-scm-created-po-sync-evidence.md)
- [Dispatch split-address evidence](dispatch-split-address-evidence.md)

## Live receiving results

The repeatable-read, read-only production audit at **17:28:54 UTC** found 180 split
records, 164 active, and 163 receiving eligible. This includes one more eligible
record than the earlier pre-deployment audit. Every eligible record passed.

**SN1400409 / POB03658 / yard 3445** opens with both lines:

- `UNI-TV80S-RDM-STORM`: **2,284.8 SQFT / 28 PLT** remaining.
- `PALLET`: **28 EACH** remaining.

All seven previously empty fully allocated POs now show two receiving lines:

| Split reference | Source PO | Material quantity | PALLET quantity |
| --- | --- | ---: | ---: |
| LOINC-022229 | POB03536 | 1,088 PC | 34 EACH |
| PO# B03429 (L1) | POB03429 | 1,771.2 SQFT | 18 EACH |
| SN1398647 | POB03747 | 144 PC | 16 EACH |
| 3022152102 | POB03768 | 1,440 PC | 24 EACH |
| 3022152112 | POB03768 | 1,440 PC | 24 EACH |
| 3022152120 | POB03768 | 1,140 PC | 19 EACH |
| SN1400513 | POB03872 | 22 PC | 4 EACH |

The known allocation discrepancy for `3022152120` remains: 1,320 PC / 22 pallets
allocated against 1,140 PC / 19 pallets ordered. Receiving correctly displays
the actual remaining PO quantity. No allocation repair or live test receipt was
performed by this deployment.

## POB03875 live refresh

Refreshed history 55 through the deployed history service and checked workflow
8072 against a second fresh NetSuite snapshot. Vendor Replies now matches all
four current lines, including native quantity, item, price, amount and destination.

| Item | Quantity | Pallets | Rate |
| --- | ---: | ---: | ---: |
| PER-MEL80S-RDM-NG | 932.8 SQFT | 10 | 4.56 |
| PER-MEL80S-RDM-AB | 466.4 SQFT | 5 | 4.96 |
| PER-MEL60S-RDM-AB | 932.8 SQFT | 8 | 3.67 |
| PALLET | 23 EACH | 23 | 35.00 |

- Refresh timestamp: `2026-09-15T17:29:44.695Z`.
- Current content version: `23cc479e4126f2e291c8071e2b678f4a607c1ee8c7a9760f76d360349c2d3df7`.
- Original creation snapshot was unchanged; SHA256:
  `dca43c83b82afdfcd36cefacd032aaaaf752a47d1e259335ff0b2dc64d6c3871`.
- The existing refresh service reconciles a bounded group of up to 25 local PO
  histories. NetSuite was read; no NetSuite PO edit or Item Receipt was submitted.

## Concurrent work and deployment retry

The first pre-cutover gate stopped before restarting anything because separate
Dispatch fulfilled-TO work appeared after **17:24 UTC**. The user was informed
that the deployment would use the complete immutable **17:13 UTC** snapshot.
The newer work was preserved in the shared workspace and was not folded into
this release. At final cutover it affected:

- `public/dispatch.js`
- `src/dispatch-fulfilled-so-repository.js`
- `src/dispatch-fulfilled-to-policy.js` (new)
- `src/dispatch-fulfilled-to-repository.js` (new)
- `src/server.js`

The first actual restart reached application health, then the verification script
automatically restored the previous image. The script incorrectly compared
Docker mount arrays in their returned order. Inspection confirmed identical
mount records and environment values, with only array ordering changed. The
check was corrected to compare complete records sorted by destination, and the
same tested image was successfully deployed. This caused an extra restart;
the final cutover's observed unavailable interval was **5.082 seconds**, which
does not include the earlier attempt/rollback. Both attempts are retained.

## Backup, rollback and reproducibility

Private release directory:
`/home/ubuntu/operatorapp-deploy-backups/whole-worktree-20260915-v1/`.

- PostgreSQL custom-format backup: **291,118,428 bytes**; validated with
  `pg_restore --list` (**3,134 TOC lines**).
- Backup SHA256: `8ecaf6f94ca91d9f1d376471f78cf7e0199586340e9f2235a0f23e41c7820fff`.
- Retained rollback tag: `mbbs-operator-app:rollback-whole-worktree-20260915-v1`,
  image `sha256:632468ca1d07aa212bde7f6d0727ff4f60c0815ec9f66f45691751746ca9bd20`.
- `compose.rollback.yml` and `compose-commands.json` preserve the exact rollback
  invocation. Rollback recreates app and worker only; it does not restore the DB.
- `source/`, `source-manifest.json`, `worktree.diff`, effective Compose snapshots,
  `prepare.py`, `verify-release.py`, `cutover.py`, `verify-live.mjs`, and
  `refresh-smart-scm.mjs` retain the build and verification inputs.
- Raw results: `full-mbt.log`, `test-summary.json`, `dispatch-focused.log`,
  `browser-*.log`, `browser-artifacts/`, `live-verification.log`,
  `smart-scm-live-verification.log`, `final-verification.json`, and `attempt-1/`.

Re-run the exact frozen MBT suite from `server/`:

```sh
sudo -n env RECEIVING_IDENTITY_SOURCE_ROOT=/home/ubuntu/operatorapp-deploy-backups/whole-worktree-20260915-v1/source bash tools/operator-receiving-identity-test.sh npm test
```

Build the same complete application source:

```sh
sudo -n docker build -t mbbs-operator-app:whole-worktree-20260915-v1 /home/ubuntu/operatorapp-deploy-backups/whole-worktree-20260915-v1/source
```

The retained image ID identifies the actual deployed build; rebuilding later
can pick up a changed upstream `node:20-bookworm-slim` tag. Test tools used the
existing pinned local Node 20.20.2 and Playwright test images. Production startup
and asset/hash verification supplement the feature tests; no live accounting
write was used as a deployment smoke test.
