# Complete worktree deployment and commit — 30 October 2026

Authorization: user explicitly requested “deploy all and commit all”. Tier 3.
Detailed spec approval: not obtained (autonomous run under that authorization).

Acceptance criteria:

1. Preserve production-only HTML cache query parameters and Driver cache v56;
   deploy all current application source and assets, including the broader
   special-order packing normalization and native estimate PDF transport.
2. Compare the complete source manifest with both running app and webhook worker
   after release. Preserve environment, mounts, ports, service configuration,
   database/Ollama container identities, and existing business data.
3. Run the repository's full MBT selection and focused packing/PDF/worker checks
   in bounded disposable containers. Reproduce broad-suite failures against
   captured production source; permit no new regressions. Rehearse actual
   candidate app and worker startup and prior-image rollback on disposable data.
4. Verify all local migration filenames in the production migration ledger;
   apply no already-recorded migration. Capture prior images and private runtime
   configuration and automatically restore them if cutover verification fails.
5. Commit the complete main-worktree source, tests, tools, configuration and
   concise evidence after secret screening. Exclude generated test output,
   private configuration, production/rollback data, and historical source copies.
6. Inspect availability of a NetSuite script deployment mechanism. Publish
   supplied scripts only through an existing supported authenticated mechanism;
   report any external deployment that cannot be completed separately from the
   application deployment. Do not claim that copying scripts into an app image
   installs them in NetSuite.
7. Remove task test containers, disposable storage/networks and generated output
   on success, failure or interruption; verify docker ps and docker ps -a and
   production health. Retain only concise source evidence and operational records.

Failure model and checks: accidental live rollback (source manifest and cache
reconciliation), incorrect packing or PDF identity (existing focused unit,
property, mutation and contract checks), worker incompatibility (actual-image
startup and webhook tests), broken rollback (isolated rehearsal), source drift
(hash gates), accidental secret commit (staged-content screening), and leaked
test workloads (registered teardown, shared slice and resource limits).

Setup: existing Python, Node, Docker and repository tools/dependencies only.
Use docker/run-isolated-tests.sh or docker/run-dispatch-source-tests.sh with
docker/retention/retention.py and its unique MBBS_TEST_ARTIFACT_DIR. Add release
orchestration and evidence in the existing tools/test conventions. The main
branch commit is authorized; unrelated historical worktree branches are not
merged. No new dependency or live financial test transaction is required.

Run adjustment: the first broad run stalled in an existing Aggregate browser
test after five completed cases. Add an opt-in 180-second Node test deadline to
the isolated runner, enabled for both candidate and production-source replay.
Timeouts remain failed/cancelled tests and must be reported; no assertion or
acceptance tolerance is weakened. The interrupted disposable run is torn down
before the complete run is restarted with that deadline.

The Node deadline also stalled waiting for the browser. A watchdog now allows
30 seconds for cleanup, then terminates only that test file's child process
tree, preserving the Node reporter and its failure result. It monitors only the
unique disposable Compose project, applies identically to candidate and
baseline, and records each timeout in concise evidence.

The first complete comparison exposed two release-specific regressions: the
baseline runner rejected the newly bundled SCM Node command, and the internal
Sales Order builder added empty packing columns to PALLET ancillary rows. Keep
all existing assertions: support the safe bundled Node command without shell
evaluation; preserve ancillary builder rows while retaining packing
normalization at the outbound Sales Order transport boundary. Verify both with
the already-failing tests before the final release.

Repeat all 1,253 files after correction, partitioned across two independent test
containers (1.5 GiB and one CPU each) with separate artifact directories and
per-file disposable database clones. The database retains its 1 GiB limit and
the shared slice retains 4 GiB/two CPUs. Replay failures in the same arrangement;
no assertion, timeout, or failure acceptance rule changes.

The user clarified that NetSuite uploads are manual. Check installed scripts,
deployment activation, and available health/version capabilities read-only;
report missing or outdated scripts without uploading anything to NetSuite.

The complete initial replay also reported one additional browser-file process
failure in stock-request-view-browser.test.js. All sixteen assertion failures
in that file reproduced on production source; the extra file-level failure
will remain a regression gate in the fresh run, rather than being excluded.

The fresh full run left two intermittent browser failures for paired replay:
the Backorder retry button can detach during its click, and the stock-check
fixture can reject response.json after closing its browser. Repeat candidate
and production source together under the same limits and frozen assertions, at
most three rounds. A passing retry alone does not clear the gate: require the
same failure on production source and preserve the original full-run counts
and unresolved names in the evidence. Unexpected failures remain blockers.

All three paired repeats passed the retry case on both sources. The third
production-source repeat reproduced the stock-check response.json teardown
error, which is retained with the unchanged test and application hashes as
baseline evidence. The retry fixture's endpoint previously recovered before
the user click, allowing unrelated async renders to remove its retry button.
Keep the mock outage until a captured real click triggers recovery; retain
every assertion. Verify the revised fixture and kill a no-op retry-handler
mutant, then rerun the complete selection. No product source changes are made
for this fixture correction.

Cutover verification identified one benign image-default difference: the newer
app image supplies PLAYWRIGHT_BROWSERS_PATH=/ms-playwright to the older worker.
The first cutover automatically restored the original images and environment.
Preserve all original environment entries exactly, allow only that specific
worker image default, and explicitly verify it in an actual-image startup and
rollback rehearsal before retrying. Application source hashes remain unchanged;
this deployment-verification correction requires the image rehearsal, not a
repeat of the unchanged full source comparison.
