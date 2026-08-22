# MBBS PO/VRMA Vendor-Route Rate Evidence

Final verification date: 2026-08-16 UTC

## Scope

- Executable specification: `test/mbt/specs/mbbs-po-vrma-vendor-rate-matrix.md`
- Migration: `166_mbt_mbbs_po_vrma_vendor_route_rates.sql`
- Tier 3 evidence-first verification for money calculation, immutable Driver-load identity, configuration, preview, and conversion.
- Production rate version v3 is active. Its graph contains the reviewed exact vendor-yard rates; unmatched rows retain the distance-band fallback.
- Production verification was read-only: no billing cases, snapshots, or operational rows were created or changed.

## Final source state

- Git HEAD: `91115fd65a1ab3ba9a81296fbb362af09b273307`
- Target source SHA-256 aggregate: `462da2fd9927e4b5a819b9b7d435d291f9dc9e00ef94768d3e22c76c1b0ea2ed`

## Final uninterrupted isolated gauntlet

Command: `bash server/tools/mbbs-vendor-route-rate-gauntlet.sh`

- Exit status: 0
- Fresh isolated PostgreSQL migration: migrations 001 through 166 applied.
- Focused executable specification: 57/57 tests passed.
- Complete Node regression: 330/330 files, 1,717/1,717 tests passed.
- Deterministic shuffled regression, seed `2026081601`: 330/330 files, 1,717/1,717 tests passed.
- Changed-module coverage:
  - Statements: 100%
  - Branches: 95.09%
  - Functions: 100%
  - Lines: 100%
- Critical mutation score: 13/13 killed; all mutated source files restored to their original hashes. This includes two independent attempts to collapse distinct immutable Driver loads.
- Real browser execution: 12/12 passed across Chromium desktop, Chromium mobile, and WebKit mobile.
- Syntax, TypeScript, and ESLint: passed with zero lint warnings.
- Dependency tree: passed.
- License inventory: 383 packages passed, with the existing documented `buffers@0.1.1` metadata exception retained.
- Secret scan: 29 changed/new target paths checked; no high-confidence findings.

## Business-rule evidence

- Exact configured vendor-yard/MBBS-yard pairs use the immutable CAD flat amount for both inbound PO and reverse VRMA.
- Missing exact pairs use the normal distance-band calculation.
- An endpoint override defaults to the configured flat rate and exposes an explicit distance-rate alternative.
- Multi-stop work charges the selected base once plus the versioned additional-stop amount after the base pickup/drop pair.
- A PO/VRMA business leg is scoped by the immutable `driver_job_records.load_id`, not by its display label. Driver 1 `Load 1` and Driver 2 `Load 1` are therefore separate chargeable legs.
- Multiple PO/VRMA references physically carried on the same immutable load and origin share one leg and allocate exact cents without loss.
- The same PO reference completed on two different immutable loads remains two physical legs.
- An explicit SCM PO/VRMA group remains one order across its child references; the group rule is not weakened by load scoping.
- Legacy evidence with no immutable load ID stays conservatively separated instead of inventing a shared trip.
- `Canada Fasting` maps to local vendor `CFC`; supplied destination `BS` maps to MBBS yard `150`.
- The supplied table produces 54 exact mapped rows and 17 intentional distance fallbacks.
- Preview and conversion re-resolve server-owned rate evidence and reject a tampered retained price or hidden UI selection.

## Production-data proof

- The reviewed input contained 71 rows: 54 exact local vendor-yard mappings and 17 intentional distance fallbacks.
- The active v3 graph contains all 54 exact rows, including `Permacon - Cambridge to 150` at CAD 550 and `Unilock - Georgetown to 150` at CAD 400.
- `SN1397703`, `SN1397952`, `SN1397953`, and `SN1398117` resolve to four distinct immutable Driver load IDs even though their visible labels repeat as `Load 1`, `Load 1`, `Load 3`, and `Load 3`.
- A production-backed execution of the corrected planner produced four candidates and four `vendor_yard_flat` previews at CAD 550 each: total CAD 2,200.
- No converted PO/VRMA completed-load snapshot existed before this correction, so changing candidate identity cannot duplicate an already-converted PO/VRMA charge.

## Deployment proof

- Deployed production image: `sha256:3f01eb25003dc8a2cd23a2e671080f04ff1eb8e994ab5f8a0c3dfd9722335cbd`.
- App-only container cutover completed in 1.45 seconds; PostgreSQL and Ollama remained online.
- App, PostgreSQL, and Ollama were all healthy after cutover; `/health` returned `{"ok":true,"app":"MBBS Yard Server"}`.
- `DISPATCH_DRIVER_ORIENTED_PLANNING` remained `true` in the deployed container.
- The deployed container repeated the four-candidate proof at CAD 550 each and CAD 2,200 total.
- The production readiness scan found no missing migrations and no Dispatch snapshot collisions. Its generic closed-gate result remained false only because seven MBT production features are intentionally active.
- Rollback image retained as `mbbs-operator-app-app:rollback-pre-load-identity-20260816T042734Z`.
- Readable PostgreSQL custom backup retained at `docker/backups/mbbs-before-load-identity-20260816T042734Z.dump`.
- No isolated test containers remain; the three disposable MBT test images were removed after verification.

## Red-to-green record

- Canonical-label test first failed because two supplied `150` destinations were still represented by the legacy `BS` label.
- Reconciliation contract first failed because the seed tool could only create a new draft and could not safely reconcile an existing draft.
- The four-load production-shape regression first expected four candidates and received one, reproducing the reported billing error.
- The first mutation run exposed a missing boundary: the same PO reference on two immutable loads was not asserted. That regression was added before the final 13/13 mutation pass.

## Residual observation

Some existing integration fixtures emit the PostgreSQL client deprecation warning about invoking `client.query()` while another query is executing. It did not fail this gauntlet and is not introduced by the vendor-route calculation engine.
