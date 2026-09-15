# Operator UI enhancements — evidence

Approved specification: [operator-ui-enhancements-spec.md](operator-ui-enhancements-spec.md).
The user requested implementation, added Cycle Count's Menu layout, and initially
excluded deployment. After validation, the user explicitly authorized deployment
with a short cutover and post-checks. The production release is recorded below.
No new dependencies, schema migrations, commits or operational order changes were
needed for deployment verification.

Reproduce from the repository root:

```sh
bash server/tools/operator-ui-enhancements-gauntlet.sh
```

The `--focused` option is for development checks only. The final acceptance run
uses the default command, including the full existing Node suite. All database
and browser work runs in the separate `mbbs-operator-ui-test` Compose project.

## Specification to test mapping

| Requirement | Verification |
| --- | --- |
| Receiving and Cycle Count Menu placement | Browser tests check one header Menu, its bounds at 1280/820/390px, and navigation. |
| Search focus and cursor | Real input-node identity, selected text and focus survive number/product result refreshes. |
| Stale receiving responses | Delayed list, detail, suggestion and failed responses cannot replace newer results or restore focus. |
| Confirmed and remaining display | Unit/property checks and browsers assert confirmed 5, remaining 15, green styling, editor 5, English/Chinese and compact mode. |
| Absolute adjustment and zero clearing | Database tests, page confirmation, and real HTTP/browser flows check repeated 5, replacement 7, zero clearing and loaded 7 with 13 outstanding. |
| Delivery view independence | A saved `packed` Delivery view still exposes pickup confirmation and its green draft styling. |
| Compatibility and validation | Legacy requests add 5+2; absolute requests retain 7; invalid modes return 400; physical/sales units obey availability bounds. |
| Failure and overlap handling | A pending save disables confirmation/loading; duplicate confirmation is ignored; failed saves preserve the confirmed draft and show an error. |
| Existing workflow constraints | Full Node regression suite plus existing photo-gate, visible-page confirmation and long-load layout browser tests. |
| Installed asset freshness | Updated cache-version contracts and matching Operator HTML/service-worker asset references. |

## Baseline and RED evidence

- Before implementation, the existing Node suite passed **460 files / 2,291 tests**.
- Quantity regressions reproduced duplicate confirmation changing 5 to 10, page
  confirmation adding again, and zero clearing being rejected.
- Six browser regressions reproduced both Menu placement issues, both replaced
  search inputs, stale results replacing the current search, and pickup inheriting
  Delivery's under-packed state. Three display/property regressions also failed.
- Cache-version contracts failed before advancing the shipped asset versions.
- Further browser checks exposed missing failed-save feedback and clipped pickup
  controls in iPhone WebKit; these were corrected without weakening assertions.

## Final verification

The complete default gauntlet passed on **2026-09-11** using the existing isolated
test images and Node **20.20.2**. No source changes were made during the run.

| Check | Result |
| --- | --- |
| Full existing and new Node suite | **462 files / 2,300 tests passed**. |
| Focused database and display/property tests | **9/9 passed**. |
| Browser regressions | **72/72 passed**, with zero skips, failures or flaky results; desktop Chromium, Android Chromium and iPhone WebKit. |
| Changed executable-line coverage | **205/205**: Operator UI **187/187**, pickup repository **18/18**. |
| Targeted mutation checks | **5/5 killed**; the three arithmetic/display mutants also failed property tests alone; restored tests passed. |
| Syntax and scoped ESLint | Passed; ESLint covers the new test/tool files. |
| TypeScript baseline comparison | **0 new diagnostics**; the same **233 pre-existing diagnostics** remain. |
| Secret scan and diff whitespace | Passed. |
| Source integrity | All **27 files in the source report** retained their recorded SHA-256 hashes throughout validation. |

The generated report directory is `server/test-artifacts/operator-ui-enhancements`.
It contains `full-suite.log`, `focused.log`, `browser-report.json`,
`changed-coverage.json`, `mutations.log`, `source-state.json`, the image/toolchain
records, baseline/RED logs in `red/`, and confirmation screenshots:
[desktop](../test-artifacts/operator-ui-enhancements/pickup-chromium-desktop.png),
[Android](../test-artifacts/operator-ui-enhancements/pickup-chromium-mobile.png),
[iPhone](../test-artifacts/operator-ui-enhancements/pickup-webkit-mobile.png).

The final browser run also checks failed searches, vendor/source and language
navigation, the loading summary, repeated page confirmation, and refusal to leave
a pickup while its confirmation is pending. Deployment was deferred at this
implementation checkpoint and subsequently authorized by the user.

## Production deployment — 2026-09-11

Deployed to `https://test.mbbsoperation.com` as
`mbbs-operator-app:operator-ui-20260911-v1`, image
`sha256:baef87495b4e673d382b27551e31bf2c4969a05f3a9173f37d5d13b754125979`.
Both app and webhook worker started on this image at **20:47:32 UTC**.

The image extends the previously running removed-travel-recovery release. Its
867 runtime files were compared before and after deployment: exactly the five
Operator public assets, pickup repository and two Operator test harnesses changed.
All other runtime files and the effective service configuration stayed identical.
Database and Ollama container IDs and startup times were unchanged. No migrations
were pending; the webhook queue had zero queued, running or failed jobs before
cutover and during the post-check.

The six application files match the full 2,300-test / 72-browser validation above.
An additional check of the exact production image found that the two older
Operator harnesses still expected the previous i18n cache URL. Those test-only
expectations were corrected; both image harnesses then passed **2/2**. Application
logic was unchanged by that correction. The original validation manifest remains
as historical evidence, and the release manifest records the final harness hashes.

Only app and webhook worker were recreated, using the prepared image with
`--no-deps --no-build --force-recreate`. An observer sampled local health every
200ms through cutover and the stability window:

- 1,297 samples from 20:47:08 to 20:51:28 UTC; 24 failed samples.
- First unavailable sample: **20:47:32.144 UTC**.
- Recovery: **20:47:36.952 UTC**.
- Observed interruption: **4.808 seconds**; sampling-bounded gap: **5.008 seconds**.
- Both services remained running with zero restarts after cutover.

Post-checks passed:

- **22 local/public HTTP checks**: health, Operator pages, exact JS/CSS/service-worker
  hashes, preserved Driver/Dispatch assets, and unauthenticated API rejection.
- Public HTML matches the release after removing only Cloudflare's injected
  analytics script and normalizing surrounding whitespace. Direct-app HTML and
  all checked JS/CSS assets match byte-for-byte.
- **Chromium and WebKit** loaded the public release and verified Receiving/Cycle
  Count Menu placement, both receiving input identities/focus/selections, and the
  green pickup card with confirmed 5, remaining 15 and editor 5. API data was
  intercepted with synthetic fixtures; no production order writes were performed.
- All 867 deployed runtime hashes match the frozen image. No browser page errors
  or fatal application/worker errors occurred in the captured window.

The app log retained **41 existing invalid printer-agent credential rejections**;
all error-related lines in that window were this known message. No other application
error messages were found. This is not a claim that production logs are empty.

Release definitions, hashes, HTTP/browser results, screenshots, availability samples
and private logs are retained in `docker/backups/operator-ui-20260911/`. Rollback is
prepared as `compose.rollback.yml`, using the retained image
`mbbs-operator-app:pre-operator-ui-20260911-v1`
(`sha256:e6890adf56d09539d1417593ad6297964d0847e8b8533ec3162a21a0458df815`).

## Limits

- The repository already has **233 TypeScript diagnostics**, reproduced verbatim
  in the untouched baseline snapshot. The check rejects any additional diagnostic;
  the existing diagnostics are recorded in `test/support/operator-ui-types-baseline.json`.
- Legacy browser/repository JavaScript is outside the project's strict type-check
  configuration; syntax checks and runtime/database/browser tests cover this change.
- No dependency or license audit is needed because dependencies did not change.
- Tests verify quantity repeatability and the existing loading boundary. This
  change does not introduce a new lock protocol for different operators editing
  or loading an order concurrently.
