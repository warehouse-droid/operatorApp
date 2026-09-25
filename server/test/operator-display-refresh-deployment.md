# Operator display refresh deployment — 2026-09-18

Authorization: the user explicitly requested “deploy” after reviewing the
implementation result. Deployment completed successfully at **16:05:34 UTC**.

Release: `mbbs-operator-app:operator-display-refresh-20260918-v1`

Image: `sha256:870700335553a273f36f1a2a4c655ac1d4af4cc3cf8620e14e8a22a41121db19`

The package overlays only these six files onto the captured live
`child-location-20260918-v1` image:

- `public/operator.js`
- `public/operator-delivery-refresh.js`
- `public/operator.html`
- `public/service-worker.js`
- `src/operator-linked-quantity-domain.js`
- `src/delivery-repository.js`

The task patch applied with zero fuzz. Unrelated live code and asset versions
were retained. No dependency installation or database migration was needed.
The app configuration, mounts and environment were verified unchanged; the
webhook worker, database and Ollama containers were not replaced.

## Validation of the exact release

- Candidate focused suite: **45/45 passed**.
- Candidate Chromium regression scenarios: **20/20 passed**; screenshot reviewed.
- All six image file hashes matched the prepared candidate before deployment
  and the running container after deployment.
- Local and public health endpoints returned **200**, with `ok: true`.
- All four changed public assets matched their expected SHA-256 hashes through
  both local HTTP and `https://test.mbbsoperation.com`.
- Anonymous access to Delivery Prep remained **401**.
- Startup logs contained no syntax, missing-module, reference or uncaught errors.
- The read-only order check passed before and after cutover. PostgreSQL enforced
  read-only, repeatable-read transactions; no order or PO allocation was changed.

At the time of verification, `GOB-120607-120608` remained in Planned and was not
in Packed. MBBS-Special Order had original quantity **2,332 SQFT**, PO allocation
**2,332 SQFT** and yard residual **0**. PALLET had original and PO-allocated
quantity **20 EACH**, also with zero yard residual. The active PO reference was
**3022225167**. Yard 3445 returned 35 active SO groups/orders, one TO and three
VRMA entries; Packed contained one VRMA and no SO or TO entries.

The PWA shell and worker cache use `20260918-display-refresh-v1`. Reopening the
PWA allows its existing update flow to load the new shell. A physical installed
device was not used for verification.

## Reproducibility and rollback

The persisted deployment tool is `tools/operator-display-deploy.py`. Its
`prepare`, `build`, `check`, `preflight`, `apply` and `verify` stages record
source hashes and enforce the candidate and runtime checks. `apply` requires
the successful candidate tests and read-only preflight and checks that no
fulfillment is actively posting before cutover. Verification failure triggers
automatic rollback.

The completed release record, exact patch, image/build logs, test logs,
`live-after.json`, `deployment-result.json` and Compose rollback override are
retained at:

`/home/ubuntu/operatorapp-deploy-backups/operator-display-refresh-20260918-v1`

The previous image is retained as
`mbbs-operator-app:rollback-operator-display-refresh-20260918-v1`.
No rollback was required. See the [implementation evidence](operator-display-refresh-evidence.md)
for the earlier full-suite baseline comparison and mutation/coverage checks.
