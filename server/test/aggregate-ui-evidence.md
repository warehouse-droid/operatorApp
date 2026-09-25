# Aggregate cards and Operator Inventory follow-up

Validated on 2026-09-22. This follow-up implements the user's eight-card request interface and final Operator menu clarification. The user explicitly chose to leave Damage and Count Sheet unavailable for now.

## Delivered behavior

- Operator's main menu replaces Cycle Count with Inventory and has no separate Aggregate Requests tile.
- Inventory contains Aggregate Requests, Damage, Cycle Count, and Count Sheet. Damage and Count Sheet are disabled and labelled “Not available yet.”
- Inventory survives reloads. Cycle Count's header and Back navigation return to Inventory; an Operator returning from Aggregate Requests also returns to Inventory.
- The standalone Aggregate form has seven material cards plus the assigned-yard/submit card, with no application sidebar or request sidebar. Each material has a label, load quantity, and minus/plus controls; quantities cannot step below zero.
- English and Simplified Chinese cover the Aggregate form, request history, reporting, validation, SCM Aggregate controls, and the new Inventory menu. Switching language preserves quantities, yard, and remarks.
- Yard choices use the existing Admin-assigned permissions. The server continues to reject an out-of-scope yard even when the request body is modified.
- The existing Aggregate approval, quantity adjustment, next-day reporting, and overdue-request rules are unchanged. No backend, migration, dependency, or package-lock changes are part of this release.

## Verification

- **39/39 Aggregate tests pass**, including nine Chromium tests, authenticated HTTP checks, PostgreSQL integration tests, and domain/property tests.
- **55 related checks pass** for Regular/Special requests, Operator refresh/cache and UI behavior, Cycle Count pagination, and sidebar permissions.
- Syntax, ESLint, domain type checking, and scoped whitespace checks pass.
- Desktop English and mobile English/Chinese screenshots were reviewed. The 390px form has no horizontal overflow. Accessibility checks report no critical or serious violations in the request form.
- Tests caught and verified fixes for accessible yard/remarks names after form rerendering. The Operator navigation fixture follows the existing automatic selection of the account's single assigned yard.
- Operator HTML and its service-worker cache reference the updated client and translations using `20260922-aggregate-ui-v2`.

Workspace evidence and pre-edit snapshots are in `server/test-artifacts/aggregate-ui`. The sealed source digest is recorded in `source.json`. The complete application test suite was not repeated for this UI follow-up; the original module's full-suite baseline comparison remains in [aggregate-requests-evidence.md](aggregate-requests-evidence.md).

## Deployment

[aggregate-ui-deploy.py](../tools/aggregate-ui-deploy.py) prepares a ten-file overlay on the running application image, applies only this follow-up's diff with zero fuzz, verifies the exact candidate, preserves app configuration and other services, and rolls back the application image if runtime verification fails. Migration 215 must already be applied; this follow-up makes no database changes.

The deployment uses the user's prior “deploy” authorization for this continuing task. Candidate checks, live verification, exact hashes, release patch, and rollback metadata are retained in `server/test-artifacts/aggregate-ui-deployment-20260922`.

Deployment completed at **2026-09-22 13:40:05 UTC**:

- Image: `mbbs-operator-app:aggregate-ui-20260922-v2`
- Image ID: `sha256:fee32ba849f8dc1f2f74b5b23524ea5f4401edbc4ec0eaa68d725758e65c07cb`
- Sealed follow-up source digest: `8b9a47195b53c6ef2f735964d4b3adca391d3daa8f95a46c85e6a1dcb36d1794`
- Prepared candidate: 39 Aggregate tests and 51 related checks passed; static checks passed. All ten image files matched their prepared hashes.
- Live verification: local and public health returned 200; both Aggregate pages returned 200; anonymous Aggregate APIs returned 401; all ten assets matched through local and public HTTP.
- A database-enforced read-only check confirmed the seven materials and four yards. Migration 215 was already present and no migration was run.
- Application configuration and the database, webhook-worker, and Ollama services were unchanged. Startup checks passed and no rollback was needed.
- Rollback image: `mbbs-operator-app:rollback-aggregate-ui-20260922-v2`, retaining the previous Aggregate release.

Existing live differences in Operator HTML, JavaScript, and the service worker were preserved. Candidate screenshots include [Inventory](../test-artifacts/aggregate-ui-deployment-20260922/aggregate-inventory-menu.png), [desktop request cards](../test-artifacts/aggregate-ui-deployment-20260922/aggregate-request-desktop.png), and [mobile Chinese](../test-artifacts/aggregate-ui-deployment-20260922/aggregate-request-chinese.png).
