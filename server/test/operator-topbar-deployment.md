# Operator top bar and Settings Back correction

Deployed on 2026-09-18. Cutover began at 04:23:47 UTC; public verification completed at 04:23:56 UTC.

The operator header now uses one grid row at all tested widths, with equal space reserved on either side of the absolutely centered language toggle. Header titles truncate when necessary and actions can scroll horizontally instead of wrapping. Button and notification-status text remain on one line. The settings page has a top-bar Back button that returns to the main menu and discards unsaved edits, consistently with Cancel. Reset behaviour is unchanged.

Only five public files changed: `operator.js`, `operator-display-settings.js`, `operator-display-settings.css`, `operator.html`, and `service-worker.js`. Changed assets and the Operator cache use version `20260918-operator-topbar-v2`. There are no backend changes or new migrations.

- Image: `mbbs-operator-app:operator-topbar-20260918-v2`
- Image ID: `sha256:0959f622f83452fe31a9e861c251d67d3c85eb57c5e519c7eccdc9613bdf24f7`
- All 922 runtime files matched the frozen candidate; 12 focused tests passed.
- Chromium verified one header row, absolute horizontal/vertical centering, clear space around the toggle, and working Back navigation at 1280×800, 1024×768, 768×1024, and 390×844. Both English and Simplified Chinese, default styles, custom styles, and 48 px fonts were exercised.
- Existing settings, reset, keypad/scanner, and driver unit browser checks passed.
- Local and public health returned 200; all five changed public asset hashes matched. Anonymous preferences access remained 401.
- App environment, startup command, mounts, and ports were preserved. Worker, database, and Ollama containers were unchanged. Migration 206 was already present and was not reapplied.

The release manifest, validation record, schema backup, and rollback override are retained under `/home/ubuntu/operatorapp-deploy-backups/operator-topbar-20260918-v2/`. The release script is `server/tools/operator-topbar-deploy.py`. Screenshots are under `server/test-artifacts/operator-topbar/`.
