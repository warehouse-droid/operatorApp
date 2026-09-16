# Consolidation Load pagination and date controls

Status: deployed successfully on 2026-09-16 at 02:20:30 UTC. See [deployment results](consolidation-pagination-deployment.md).

The [compact date-row follow-up](consolidation-date-row-deployment.md) was deployed at 02:27:55 UTC; the planned and specific date controls now sit side by side.

## Behavior

- Five order rows per page, with Previous/Next, current/total pages and matching order count.
- Selection survives pagination, refresh and preview/back. Existing same-date/truck/load restrictions remain in effect.
- Date and truck changes return to page 1. Background updates clamp the current page if the number of orders shrinks.
- Today, Tmr and Today and tmr quick filters; Today and tmr is the default. Calendar dates use America/Toronto, as elsewhere in Operator.
- Year/month/day fields open a dropdown on the first tap and become editable numeric inputs on the second. Enter or leaving the field applies valid dates; Escape restores the applied date. Changing month/year clamps the day where necessary.
- Partial typed values survive background refresh. Invalid dates retain the last applied filter and display an inline error.
- Mobile uses one scrolling list of at most five rows. Pagination and the selection tray follow that list without hiding its rows. Desktop keeps these controls in a sticky footer.
- New controls have Chinese translations. Operator JS, CSS and i18n assets use version `20260916-consolidation-pagination-v1`; the service worker cache is `mbbs-yard-operator-v151-consolidation-pagination-v1`.

## Verification

- Browser suite: **7 passed**, Chromium desktop/mobile and WebKit mobile, using the real UI with mocked HTTP endpoints. Includes cross-page selection, refresh, preview, all three quick filters, dropdown and numeric entry, leap years, invalid dates, Toronto calendar boundaries, filter changes, shrinking/empty results and translations. Existing camera, durable photo, retry and stale response scenarios also passed.
- Focused Operator unit/contract regressions: **21 passed**, including service worker assets, confirmation/photo controls, native posting photo submission and receiving return behavior.
- Syntax: **8 files passed**.
- Lint: **0 new diagnostics** against the saved pre-change files; the existing configuration reports the same 36 pre-existing diagnostics.
- `git diff --check` passed for changed tracked files. Desktop and mobile screenshots inspected.

Physical mobile keyboard appearance requires a device check. Automated touch tests verify the first/second tap behavior, editable focus and `inputmode="numeric"`; a headless browser does not display the operating system keyboard.

Logs, screenshots and the scoped source diff/hash manifest are in `test-artifacts/consolidation-pagination/`. Tests ran in isolated containers with network disabled. Deployment recreated only the app service; no live orders or NetSuite records were changed as verification.
