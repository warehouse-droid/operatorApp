The existing gear button's Personal preferences dialog now includes independent
Sales, Dispatch and SCM mute controls for the account's available roles. Admin
accounts see all three. A muted role produces no automatic popup, desktop notice,
or sound; updates and queue counts remain available without being acknowledged.
Preferences update across tabs and persist per account in that browser.

All staff accounts can choose, preview, replace and reset their notification
sound in the same dialog. Browser storage retains one sound per account, up to
1 MiB and 10 seconds. Audio is decoded before saving, and invalid files, storage
failure and a late upload after account switching preserve the prior account's
sound. Operator delivery sounds also use the shared sound preference.

Desktop and sound receipts remain local to each browser profile. Concurrent tabs
share the event lock and receipts, while separate profiles/computers using the
same account receive their own alerts. The system-provided sound is recorded too,
preventing a later unlocked tab from sounding that event again. Uploaded sounds
silence the system ding so an unlocked tab can play the selected sound once.
In-app popups retain their separate presentation and acknowledgement behavior.

Validation: all 32 focused notification browser checks passed, along with syntax
and ESLint checks. The exact release candidate ran 107 checks: 106 passed, none
skipped, and one existing failure remained: “Wait for Transfer requires ETA,
sends the date, and keeps the selection after saving.” A separate run with every
changed notification file restored to its original production hash reproduced
the same hidden availableDate input failure. Its test-source hash and original
runtime hashes are recorded in app-notification-roles-sounds-baseline.json.

The candidate image is mbbs-operator-app:notification-roles-sounds-20261021,
sha256:16e7a0b3523f63137e9613ca1e2ce7b9fe29e4543f67c49f08d9c2488294b40f.
Only 11 notification-related runtime files change; 1,415 other runtime files,
dependencies, configuration and schema are preserved. The rollback image is
prepared. Following the user's explicit deployment approval, production was
published and verified at 2026-10-21 04:57:58 UTC. All 1,426 live runtime files
match the tested candidate. Local and public health checks returned 200, all
11 changed public assets matched their expected hashes, and both protected API
checks rejected anonymous access. Editing leases were preserved and the database,
webhook worker and Ollama containers were unchanged.

All test workloads used the standard isolated Compose configuration and
mbbs-tests.slice with memory, CPU, PID and tmpfs bounds. Teardown removed the
test containers, disposable databases and unused test networks; running and
stopped container listings show only the four production containers. Production
health passed. Temporary run directories were removed by the retention wrapper;
the requested test logs and evidence remain in
test-artifacts/app-notification-roles-sounds-20261021. The candidate, rollback and
release manifest are in deployments/app-notification-roles-sounds-20261021.
