# Compact Aggregate cards — 2026-09-23

Deployed to https://test.mbbsoperation.com/aggregate-requests at 2026-09-23T13:48:42.031802+00:00.

Reduced material-card padding from 22px to 14px, details-card padding from 16px to 12px, grid and element gaps, label margins, textarea padding, and control spacing. Mobile cards use 10px by 8px padding. Minimum card heights and quantity-control heights are reduced; buttons remain at least 44×44px. Existing font sizes, the top-right yard selector, the eighth details card, Chinese terms, and equal desktop row heights are preserved.

Validation:
- All 16 existing browser/cache checks passed in the workspace and exact release candidate, along with syntax/lint checks.
- Compared 24 English/Chinese request and actual-report layouts across six desktop, tablet, and phone sizes: all material cards are shorter, buttons meet the minimum size, there is no horizontal overflow, and the approved form layout remains in place.
- At 1280×800, request-card heights decreased from 237px to 207px in English and 249px to 219px in Chinese. Actual-report cards are 48px shorter in both languages.
- Reviewed desktop and mobile screenshots.
- Live local/public health, pages, protected APIs, and hashes of the three changed assets passed. Application configuration and other services preserved; rollback image retained.

Image: `mbbs-operator-app:aggregate-compact-cards-20260923-v1`
Image ID: `sha256:3d3f10dc080b2757ca74713acc52927d6ee3fb73225de8643afd963c86a98d6b`
Artifacts: `server/test-artifacts/aggregate-compact-cards/` and `server/test-artifacts/aggregate-compact-cards-deployment-20260923/`.
