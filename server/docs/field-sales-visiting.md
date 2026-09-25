# Visiting stop actions

Each stop has four direct actions: **Record Visit**, **Edit Stop**, **Navigate** and **Quote**. The jobsite name opens its details. The user confirmed that routes remain open without Start/Pause/Finish controls.

Record Visit opens the visit form without marking arrival or changing the stop. Cancelling leaves the saved route untouched; saving retains the existing notes/photos/outcome/follow-up workflow. Previously recorded stops preserve their history; Navigate and Quote remain available, and another stop can be added for a revisit.

Edit Stop adjusts its visit address, planned duration and note. Visit Next, Skip/Restore and Remove are inside that dialog. Changing the visit address clears the old coordinates and updates the Navigate destination, while preserving the underlying jobsite address. Quote opens the existing quote editor directly with the stop's jobsite selected. Returning to Visiting restores the same route, including after a reload or offline use. The selected route is stored in the current user's existing device workspace.

The phone layout has two rows of two actions with 44-pixel touch targets; desktop uses one row. The service-worker shell cache advances to v5.

## Verification

Reproduce with `bash server/tools/field-sales-visiting-test.sh`. It uses the retained `field-sales-check-2941306` Node/Playwright image, an isolated PostgreSQL 18 database and an internal Docker network. No production credentials or NetSuite writes are used.

Four new Chromium scenarios verify:

1. All four stop actions, usability for every existing route status, future-date route selection surviving reload, and no route mutation when a visit is cancelled.
2. Address/duration/note persistence, Visit Next, Skip/Restore, and navigation to the edited stop address.
3. A single saved visit without starting/finishing the route; a direct quote saved against the correct jobsite after visiting it.
4. Phone layout, direct quoting for a second jobsite, offline edit/quote/reload, successful reconnection, and removal of an unvisited stop while retaining recorded history and an open route.

The existing browser runner now uses Record Visit directly in place of Start/Arrived; its visit/photo/follow-up, offline recovery, quote/PDF, money and conflict assertions remain unchanged. The full Field Sales test suite and JavaScript lint are also run. This is a frontend interaction change: no backend, authorization, money calculations, dependencies or database schema were changed. Paid Google navigation and live NetSuite publication are outside the browser checks.

Results, screenshots and exact runtime hashes are retained in `server/test-artifacts/field-sales/visiting/`. The release tool `server/tools/field-sales-visiting-deploy.py` overlays only `visiting.js`, `styles.css` and `service-worker.js` onto the active application image, verifies the tested source and unchanged configuration, retains rollback, and recreates only the app after idle-queue checks. It verifies all three served asset hashes, health, anonymous API denial and module entrypoint at both local and public origins.

## Release result

Deployed at **2026-09-19 00:55 UTC**. **80 Field Sales tests, nine browser scenarios and lint passed**, with no failed/skipped tests or uncaught browser errors. Python compilation and shell syntax checks passed. All three packaged/runtime file hashes matched, and all **12 local/public checks passed**. Service configuration and the other service containers remained unchanged; rollback was not needed.

Image: `mbbs-operator-app:field-sales-visiting-20260919-v4`, ID `sha256:2505ea23eeadf402062174b44fb1658e3841fdf943caca308f02a7ed6cd74bab`. The prior recent-leads image `sha256:7866a9ebfabe1b00e38e0a02ac2274cee2752f549c2a43af1523c343e742fc4e` remains retained for rollback. Private manifests and cutover logs are in `server/test-artifacts/field-sales/visiting-deployment-20260919/`.
