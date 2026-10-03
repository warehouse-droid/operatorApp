# Deployed source snapshot — 3 October 2026

Captured after deploying the pickup-address fix at 07:20 UTC. The source under
server/src, public, migrations, package manifests and root NetSuite scripts
matches all 1,249 captured app files. The independently deployed webhook worker
has 1,122 captured files; webhook-worker.patch and worker-deletions.json
reconstruct it exactly. The reconstruction was executed and all hashes checked.

This snapshot includes the previously deployed BOSS approval/close/history,
shared staff login and emailed password reset work, plus the pickup-address fix.
The pickup release is documented in ../dispatch-pickup-address-20261003/README.md.
Other captured production code was already running before this release; recording
it in Git does not imply a fresh full-application test run. The focused pickup,
BOSS and login regression suites were run on the exact candidate.

manifest.json records image identities, source hashes and applied migration
names. images.compose.yml pins the running images. It does not include private
environment, credentials, data, uploads, volumes or node_modules. Development
support uses an explicit file list; generated deployment copies and unrelated
workspace changes are excluded. Runtime files are staged directly from the
capture, preserving local edits. workspace-differences.json lists those edits;
there are no workspace-only application files besides the excluded server.js.orig
backup. NetSuite SuiteScript is captured as shipped in the image; independent
installation in the NetSuite account was not audited. Migration history retains
the historical 055_dual_yard_printer_routing.sql name absent from the app image.

Capture/staging tool: tools/production-snapshot-20261003.py. Raw capture and local
preservation fingerprints remain in ignored test-artifacts/production-commit-20261003/.
To reconstruct the worker from a clean checkout, from the repository root:

    python3 server/deployments/production-20261003/restore-worker.py /tmp/production-worker-source

The command requires a new destination and verifies every reconstructed file;
it does not deploy anything. Existing private runtime configuration remains
necessary to start production services.

The staged diff secret scan found 21 reviewed false positives: fixture passwords,
mock tokens, localStorage key names and HTML interpolation. Exact line hashes
and reasons are pinned in tools/production-snapshot-secret-review-20261003.json;
there were zero unresolved findings. Recheck a zero-context staged diff with
node tools/production-snapshot-secrets-20261003.mjs <diff-file>.
Whitespace checks pass outside patch artifacts (whose context markers are
intentional) and the already-deployed migration 213's final blank line, which is
preserved so the snapshot remains byte-for-byte accurate.
