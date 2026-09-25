# SCM Aggregate alerts and submission timestamps — 2026-09-25

Deployed at 13:41:21 UTC on 2026-09-25 together with editable SCM confirmation dates. See the [combined release evidence](aggregate-confirmation-date-evidence.md).

SCM and Admin users now see a bell and pending Aggregate request count in the top bar across the shared staff pages. The separate Operator, requester and Field Sales shells also load the component for accounts with SCM authority. Clicking the alert opens Stock Requests → Aggregate → Pending. Opening a request does not clear its alert; confirming or rejecting it does. Requests awaiting actuals are excluded.

The component loads the authorized pending queue on entry, refreshes on live Aggregate events and reconnection, and polls every 30 seconds while visible. It refreshes on focus, preserves the last count through temporary failures, and clears it on logout or revoked access. Delayed responses from a previous session cannot restore an alert. No browser notification permission is required.

Request cards, details, SCM action forms and the requester form show the original server `createdAt` as the submission time. The display includes weekday, year, date, time through seconds, and Toronto's EST/EDT offset, with English and Chinese labels. Editing or confirming a request leaves this time unchanged. History timestamps use the same complete date/time format.

Initial alert validation, before the confirmation-date addition:

- `npm run test:aggregate-requests`: **61 passed**, including the existing 51 checks, eight new browser scenarios and two timestamp tests.
- Neighboring Operator cache and Stock Requests UI contracts: **16 passed**.
- Existing sidebar authority regression: **1 passed**.
- `node tools/aggregate-checks.mjs static`: syntax, lint and domain type checks passed.
- Chromium verified live arrival, navigation, reloads, pending links, resolution, polling without SSE, temporary failures, access revocation, delayed responses after logout, translations, unchanged submission times and keyboard-accessible alerts.
- Layout checked at 320, 390, 768, 1280 and 1920 pixels; the alert remains visible beside the sidebar and while scrolling Aggregate details. Screenshots reviewed and alert accessibility checks passed.
- Timestamp checks include Toronto's midnight date rollover and the repeated daylight-saving hour, with browser tests using a different client timezone.

All implementation database and browser checks used the dedicated Aggregate test containers with external writes disabled. Live deployment and read-only verification are recorded in the combined release evidence; no live test requests or schema migration were needed.

Evidence is in `server/test-artifacts/scm-aggregate-alert/`: `final-tests.log`, `neighbor-tests.log`, `sidebar-tests.log`, `static.log`, `scm-desktop.png`, `scm-mobile.png`, and `manifest.json`. `change.patch` captures only this task's edits against the existing workspace contents; unrelated changes were preserved.
