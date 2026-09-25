# Aggregate yard selector in form header — 2026-09-23

Deployed to https://test.mbbsoperation.com/aggregate-requests at 2026-09-23T02:56:35.747158+00:00.

Only the Assigned yard label and dropdown move to the top-right of the form, outside the cards. The remaining request details, remarks, and action buttons are restored to the eighth card, at the end of the second row on desktop. The sentence “Aggregate request access is assigned separately by Admin.” and its Chinese rendering are removed from the form.

The desktop grid retains four columns and equally sized rows. Compact actions keep both rows and the yard selector visible in the checked 1280×800 viewport. On narrow screens the selector remains right-aligned above the responsive card grid. Existing Chinese material terminology and Operator viewport sizing remain unchanged.

Validation:
- All 16 existing browser and cache checks passed in the workspace and exact release candidate, including yard selection, request submission, editing, actual reporting, language switching, and accessibility.
- Syntax and lint checks passed.
- Reviewed screenshots and 24 English/Chinese request/report layouts at six desktop, tablet, and phone sizes. Confirmed eight cards, details card last, selector outside the card and above the grid, right alignment, removal of the sentence, equal desktop row heights, and no horizontal overflow.
- Local/public health, pages, protected APIs, and all four changed asset hashes verified after deployment. No database migration or operational-data updates; application configuration and other services preserved; rollback image retained.

Image: `mbbs-operator-app:aggregate-yard-header-20260923-v1`
Image ID: `sha256:e89cc0d79611537014d6cd12dddfce15d0ec85eb1a72ef7ff08f0890a6caeb09`
Artifacts: `server/test-artifacts/aggregate-yard-header/` and `server/test-artifacts/aggregate-yard-header-deployment-20260923/`.
