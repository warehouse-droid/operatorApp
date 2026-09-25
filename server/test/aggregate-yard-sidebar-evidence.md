# Aggregate yard sidebar — 2026-09-23

Deployed to https://test.mbbsoperation.com/aggregate-requests at 2026-09-23T02:35:52.315232+00:00.

The Assigned yard panel, dates, remarks, and request actions now sit beside the material grid within the same form. Material rows share equal heights independently of the yard panel. The panel stacks below the cards at widths of 900px or less. Existing translations and Operator viewport sizing remain in place.

Validation:
- All 16 existing browser and cache checks passed; the final release candidate passed the same checks and syntax/lint validation.
- Inspected 24 request/report layouts in English and Chinese across six desktop, tablet, and phone sizes. All seven material cards share equal heights; the panel sits to the right on wide screens and below on narrow screens; no horizontal overflow.
- Both forms fit the checked 1280×800 viewport without scrolling. Reviewed final English and Chinese screenshots.
- Four frontend assets deployed and verified through local and public HTTP; live health, pages, and protected API checks passed.
- No database migration or operational-data updates; application configuration and other services preserved. Rollback image retained.

Image: `mbbs-operator-app:aggregate-yard-sidebar-20260923-v1`
Image ID: `sha256:81de18dcfc4ce0691551408cff2883527b9e5316648a31f76f1456a0a5a98672`
Artifacts: `server/test-artifacts/aggregate-yard-sidebar/` and `server/test-artifacts/aggregate-yard-sidebar-deployment-20260923/`.
