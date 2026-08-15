# Operator Customer Pickup Photo Gate — Evidence

Date: 2026-08-15 UTC

Specification status: autonomous Tier 3. Advance human approval of the executable
specification was not obtained, so confidence is based on the persisted tests and
the evidence below rather than a claim of approved requirements.

## Outcome

- The audited Admin gate is `operator_customer_pickup_photo_required`.
- Migration 165 creates it enabled, preserving the existing one-photo rule.
- Enabled requires one valid photo at the server transaction boundary.
- Disabled permits zero photos, but preserves optional supplied photos.
- Missing, malformed, or unreadable policy fails safe; it never silently disables
  evidence.
- Ordinary Delivery and re-load remain at two photos.
- Operator reads a no-store policy at screen entry and confirmation. After the
  release containing this client is installed, later on/off changes need no PWA
  version update.
- No production data, external service, deployment, or dependency was changed.

## RED evidence

- The initial non-database contract packet failed 11/11 checks because the gate,
  migration, endpoint, live UI policy, and cache generation did not exist.
- The initial PostgreSQL packet failed 6/6 scenarios because Customer Pickup still
  required two photos and migration 165 did not exist.

## GREEN evidence

- Focused executable contract: 27/27 tests passed.
- Real PostgreSQL scenarios: enabled zero-photo rollback; enabled one-photo
  completion; disabled zero-photo completion/audit; disabled optional evidence;
  missing-row fail-safe; and ordinary Delivery two-photo isolation all passed.
- Complete Node regression suite: 311/311 files and 1,656 tests passed.
- Previously affected frozen inventories: 68/68 checks passed after making the
  independent default-on Operator gate explicit and keeping deployment readiness
  scoped to `mbt_*` safety gates.
- Browser matrix: 9/9 passed across desktop Chromium, mobile Chromium, and
  iPhone/WebKit. Each browser covered off/zero-photo completion, off-to-on blocking,
  and on-to-off completion without a new PWA version.
- Policy coverage: 100% statements, 100% lines, 100% functions, 95.23% branches.
- Persisted mutation packet: 8/8 critical mutants killed; all mutated sources were
  hash-restored and the post-mutation focused suite passed.
- Operator camera compatibility and Operator return UI harnesses passed; Delivery
  and re-load remain at two photos.
- Legacy public-script syntax, strict TypeScript, and zero-warning ESLint gates
  passed.
- Focused and repository secret scans passed with no findings.
- Dependency tree inspection passed; the image build reported 0 vulnerabilities.
- License scan passed for 383 packages with the pre-existing documented
  `buffers@0.1.1` missing-license exception unchanged.
- `git diff --check` passed.

## Residual risk

The browser tests use controlled camera/upload routes rather than physical device
camera hardware. Server enforcement and persistence use a real isolated PostgreSQL
database. Production behavior begins only after a separately authorized deploy and
migration.
