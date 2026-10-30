# Requester PWA, equipment search and alert evidence — 2026-10-28

Tier 3: authority, equipment classification, receipt evidence and retry safety.
Specification: `test/repair/spec.md`, criteria 56–61.
Spec approval: not obtained (autonomous run). No dependencies, commits or schema changes.

Deployed at **21:47:24 UTC** to the existing application host.
Operator: `/operator/repair`; Driver: `/driver/repair`.
Legacy requester URLs remain supported. The original generic requester JS/CSS
remain separate from the new PWA modules for later staff use.

## Acceptance mapping

| Behavior / failure mode | Evidence |
| --- | --- |
| PWA styling, tablet workbench, phone navigation, inline equipment input/button, fixed role meter | `requester-pwa.test.js`: Operator/Driver workbench cases; actual tablet/phone previews inspected before automatic removal |
| Operator can report forklifts/loaders in hours; known truck/unit/type spoofing rejected; Office retains broader intake | Operator enforcement API case; existing equipment and mixed-authority tests |
| Android native Camera and Windows live preview, capture, switch, close and late permission cleanup | Android and Windows camera cases; close/reopen race; camera cleanup mutants |
| A lost response and reload cannot create another request | Replay/reload case waits for submission completion and asserts one request |
| One photographed equipment receipt after completion | Requester receipt case and existing own/delegated/multiple-job receipt suites |
| Office uses a search-results picker instead of an equipment dropdown; registration/corrections retained | Office picker case; revised browser workflows; master-registration and equipment correction regressions |
| Opening the board does not wait for optional catalogs or NetSuite | Deliberately blocked catalog browser case; blocked-remote cached search/coalescing case |
| Failed remote refresh retains local records; explicit sync reports failures | Cached-master failure/backoff case; master sync/import/merge regressions |
| Only approved repair updates count toward `/repair` attention; other events stay in history; unrelated alert modules do not load | Approval attention browser case, real quote approval notices for Office/Team, three office header viewport regressions |
| Navigation stays in each installed PWA scope and requester ownership remains | Parent PWA navigation/browser tests, requester privacy property and mixed-authority tests |

## Final fresh validation

From `server`, the complete captured-candidate entry point is:

```sh
sudo -n python3 tools/repair-requester-pwa-release.py validate
```

It runs the bounded disposable runner, all existing Repair checks and the new
PWA mutation checks. Candidate snapshots, the scoped patch and file hashes are
retained as operational release records under the host's latest-five-copy policy.
No Git checkpoint was created; concurrent workspace changes are identified by
captured source hashes instead.

Repair tree hash:
`8ed52d6427d77f1aa021278fb0ad36660b10ec4ee418a04b6846ecd1a91b4445`.
Integration hash:
`9e3fe24e10cb7db2620d4a02783d051015cd2423169b6d902639a9e71d983762`.

- Normal, instrumented and reversed-order Repair runs: **140/140 passed each**.
- Affected regression files: **40/40 passed** across nine isolated files.
- Shared login/menu/notification browser checks: passed.
- Changed instrumented backend lines: **8/8 covered** (repository 5, directory 2, quotes 1). Browser assets and static server route bindings are checked by browser, syntax and live HTTP execution.
- Overall instrumented statements/lines: **93.25%**; branches: **83.68%**. Complete branch coverage is not claimed.
- Manual mutation checks: **38/38 caught**, including all eight new camera, retry, approval, unit/type and master-delay faults. Four selected existing mutants were also caught by property tests alone.
- ESLint, TypeScript, server syntax and scoped secret scan: passed.
- Existing unchanged baseline: `S11: the guarded client ships in a new atomic Driver shell generation`; the other three contract checks passed. No new failures.

Tools: Node 20.20.2; ESLint 10.8.0; TypeScript 7.0.2; c8 12.0.0;
fast-check 4.9.0; Playwright 1.62.1. No dependency audit was needed because the
dependency set was unchanged. Existing seeded properties cover authority,
rounding, hostile quote payloads and stock conservation.

## Corrections, release and limits

The initial seven behavior tests failed before implementation. Later checks
caught and fixed a stale camera-close event, lost retry identity after reload,
and a phone-width office grid overflow. Legacy positive Operator fixtures now use
forklifts/hours; UI steps use the requested picker/camera controls. Assertions for
privacy, receipt, stock and approvals remain. Explicit master-sync arrangements
replace the earlier assumption that every search waits for remote import.

The initial layered release hit Docker's overlay mount limit at 390 layers before
cutover; the old app stayed healthy. `tools/repair-requester-pwa-flatten.py`
repackaged a clean, unstarted container, excluded live runtime/volume data,
preserved image configuration and verified **1,596 captured files**. The resulting
two-layer image contains the same tested application bytes. The initial packaging
check's single-layer assumption was corrected for Docker's additional directory
layer; configuration and complete captured-file equality were still required.
All temporary export archives and packaging containers were removed.

Image: `mbbs-operator-app:repair-requester-pwa-20261028`.
Image ID: `sha256:caee2f0cb1232af6a395bfc3e50ed5662b934333bcfc9b310442f0f1db0229c7`.
Live verification: **36 scoped file hashes**, **28 local/public HTTP checks**,
healthy app, preserved configuration and other production services. A rollback
image remains. NetSuite posting settings were preserved, remaining disabled.

Camera execution used Chromium's fake media device/native-file boundary, not
physical Android/Windows hardware. Real device permission prompts and vendor
camera drivers were not tested. Delayed-boundary checks prove the loading path
does not wait for remote refresh; no percentage production speedup is claimed.
Tests performed no live NetSuite financial writes.

Final cleanup verified both `docker ps` and `docker ps -a`: only the four
production containers remained. No disposable test/packaging containers, database
volumes, test networks, media, previews, coverage, mutation copies or raw test logs
remain. Source evidence and operational deployment/rollback records are retained.

Operational records: `deployments/repair-requester-pwa-20261028/`:
`prepared.json`, `validation.json`, `flatten-audit.json`, `deployment.json`,
`live-verification.json`, `post-deploy-audit.json`, and `deployment-layer-limit.log`.
