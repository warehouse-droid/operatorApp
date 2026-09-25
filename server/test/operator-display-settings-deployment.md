# Operator settings and Chinese units deployment

Deployed successfully on 2026-09-18. Cutover began at 04:07:56 UTC; live verification completed at 04:08:05 UTC.

The [top-bar and Settings Back correction](operator-topbar-deployment.md) was subsequently deployed at 04:23 UTC.

- Application: <https://test.mbbsoperation.com/operator>
- Driver: <https://test.mbbsoperation.com/driver>
- Image: `mbbs-operator-app:operator-display-settings-20260918-v1`
- Image ID: `sha256:5b882cf2c4b3038bfb85b959859de68ee6b279c7c3179841a7bb74a9268e2fe0`

The release starts from the current stock-return correction image and changes only 16 runtime files for the requested display settings, input controls, UOM labels, and migration. The task patch was applied with zero fuzz; the Operator HTML and service-worker asset lists were adapted to preserve the live stylesheet ordering. All 922 runtime files in the resulting image matched the frozen candidate. The application environment, startup command, mounts, and ports were preserved. The webhook worker, database, and Ollama containers were unchanged.

Migration `206_operator_ui_preferences.sql` was applied transactionally after validated schema and migration-catalog backups. It creates the account-preferences table without rewriting existing data. Unrelated pending migration 203 was not applied.

Validation of the exact release passed:

- 12 focused unit/regression tests and 4 authenticated API tests.
- Chromium settings, preview, save/cancel/reset, account isolation, keypad/scanner, driver UOM, and responsive layout checks, including 48 px text.
- Full production-image startup against an isolated fresh database, with login and settings save/read through the complete application.
- Local and public health returned 200; all 11 changed public assets matched their expected hashes at both endpoints.
- Anonymous preferences access returned 401. A read-only production repository check passed; no production preferences were written for testing.
- The deployed container was healthy, with zero restarts and no detected startup exceptions.

Preparation, migration, image verification, public checks, backups, and rollback instructions are retained in:
`/home/ubuntu/operatorapp-deploy-backups/operator-display-settings-20260918-v1/`.
The release tool is `server/tools/operator-display-settings-deploy.py`. Its rollback override restores the previous app image while retaining the additive preferences table and saved settings.

The first cutover preflight stopped before changing production because its check misinterpreted Compose's null command as an override. The check was corrected to reflect Docker's inherited command; the subsequent cutover completed without rollback.

Reopen or refresh installed PWAs to load the new assets. Physical Android/Windows OS keyboard behaviour remains a device-level verification item, as documented in the implementation evidence.
