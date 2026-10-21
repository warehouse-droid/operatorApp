The sidebar now opens Personal preferences for OS notifications and the Operator alert sound. The top-bar Notifications on button appears only while OS notifications are enabled. Users can re-enable notifications from the sidebar after hiding the button.

Preferences keep the existing account-specific browser storage. The panel works with the collapsed sidebar, supports keyboard opening and Escape/Close, remains open through sidebar rerenders, and closes when the staff account changes. The existing permission prompt, popup alerts, cross-tab deduplication, Operator sound, and taskbar badge behavior are retained.

Only `public/app-notifications.js` and `public/app-sidebar.js` were deployed. The notification script has a new preferences asset version. The release preserved 1,383 other runtime files, dependencies, configuration, schema, and editing leases.

Validation: 21 focused notification browser checks passed. The exact release candidate ran 107 checks: 105 passed, no skipped tests, and the same two established stock baseline failures:

- Wait for Transfer requires ETA, sends the date, and keeps the selection after saving.
- Changing queues discards an unfinished Resolve reply without submitting or closing the case.

Syntax and ESLint checks passed. The first static attempt found an unused global declaration in the new test; removing that declaration did not alter any assertions or runtime code. Its logs were retained.

Deployment waited for active business operations to finish before restarting the app. Local and public health endpoints returned 200, both public asset hashes matched the tested image, and anonymous delivery APIs still returned 401. The rollback image was retained. Every test container, disposable database, and test network was removed; both Docker running and stopped container listings contained only the four production containers after teardown.

Evidence is in `test-artifacts/app-notification-preferences-20261014/EVIDENCE.json`, the same directory's `green` and `release-final` logs, and `deployments/app-notification-preferences-20261014`. The candidate browser screenshot is `test-artifacts/app-notification-preferences-20261014/release-final/results/preferences-mobile.png`.
