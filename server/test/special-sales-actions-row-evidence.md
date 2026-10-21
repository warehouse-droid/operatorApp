Special Sales case-line actions were deployed on 1 October 2026 at 06:03 UTC.

Save customer decisions appears on the left and the purple Add item button appears on the right of one shared row after all case lines. The Add item button retains its centered warning and remains available only before order creation. The item editor stays below the case lines.

Verification passed: 5 existing unit/property checks and 10 browser checks, with no failures or skips. Browser measurements confirm the shared row, left/right alignment, at least 16 pixels between buttons, and no horizontal overflow at widths 1440, 1280, 1024, 390 and 360. Existing decision saves, adding items, cancellation, copying closed requests, explicit copy submission, revision conflicts, and post-SO quantity/PALLET review passed. Client syntax passed and the change introduced no lint findings.

Only three public files changed in the release: sales-special-stock-requests.js, special-stock-request-actions.css and sales-stock-requests.html. The image was built over the captured live image and its complete runtime source hashes were verified. The backend, migrations, PO/TO schedule and SCM mini-panel remain unchanged. No NetSuite write or customer-data change was performed by validation. App health and exact public asset hashes passed after publication; worker, database and Ollama containers and app configuration were preserved.

Image: `mbbs-operator-app:special-sales-actions-row-20261001`.

Image ID: `sha256:e3f5e2241a5999d97ac78a0bbca68d78fea836f98036e6415777a306ac025866`.

Evidence: [checks](../test-artifacts/special-sales-actions-row-20261001/checks.json), [layout measurements](../test-artifacts/special-sales-actions-row-20261001/browser/action-layout.json), [phone screenshot](../test-artifacts/special-sales-actions-row-20261001/browser/actions-390.png), [scoped patch](../deployments/special-sales-actions-row-20261001/changes.patch), and [deployment result](../deployments/special-sales-actions-row-20261001/result.json).
