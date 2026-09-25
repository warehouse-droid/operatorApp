# Aggregate terminology and screen sizing — 2026-09-23

Deployed to https://test.mbbsoperation.com/aggregate-requests at 2026-09-23T02:19:04.154336+00:00.

Chinese terminology now uses 砂石料 for Aggregate, 石子 for Gravel, and 混合石粉 for Crusher Run. Related menu, SCM, loading, and validation translations use the same terms.

The requester shell matches Operator: full viewport width, 100dvh height, 64px minimum header, and 15px bottom clearance plus the device safe area. The content scrolls within the shell, with no 1500px width limit. Versioned assets and the Operator cache were refreshed.

Validation:
- 16 existing browser and cache checks passed in the workspace and the prepared release candidate; syntax, lint, and domain checks passed.
- Inspected 24 browser cases: request and actual-report forms in English and Chinese at 320×568, 390×844, 768×1024, 1024×768, 1280×800, and 1920×1080. Shell dimensions matched Operator; no horizontal overflow; header stayed visible and submit controls remained reachable.
- Reviewed desktop and mobile Chinese screenshots.
- Live local/public health, pages, protected APIs, and hashes for all seven changed frontend assets passed. No database migration or operational-data changes.
- Preserved unrelated live Operator asset versions and application/service configuration. The previous image is retained for rollback.

Image: `mbbs-operator-app:aggregate-terminology-layout-20260923-v1`
Image ID: `sha256:830558a1b3f7c0d2170ec966562b05548304366226e6a75e2ce59d916c85b074`
Artifacts: `server/test-artifacts/aggregate-terminology-layout/` and `server/test-artifacts/aggregate-terminology-layout-deployment-20260923/`.
