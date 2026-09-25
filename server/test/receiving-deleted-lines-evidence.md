# Receiving removed-line display correction — 2026-09-22

SO11663 (NetSuite PO POB03864 / 990616) exposed seven retained `line_deleted`
history rows as open Receiving lines. The live source PO contains ten current
lines. The UI now excludes explicit inactive/deleted rows from its open-line
filter, shared by selection, pagination, page confirmation, and missing-line
warnings. The receipt summary uses the same filter. Transit CO lines without
NetSuite activity flags remain available. No backend or database changes.

Validation on the candidate copied from the current live image:

- JavaScript syntax passed for Operator and its service worker.
- Eight existing Receiving quantity/progress/return/PWA checks passed.
- Three selected page-confirmation contracts passed. The fourth contract was
  excluded because it hardcodes an already-obsolete September 17 asset version;
  the current asset references and served hashes were verified separately.
- Isolated Chromium replay used the captured SO11663 display data: ten current
  lines across four pages; all seven removed lines absent; page confirmation
  sent only the ten current IDs; no false partial-receipt warning; a genuine
  missing current line still triggered the warning; stale confirmations on
  deleted rows stayed out of the receipt summary; Transit CO remained visible.
  All requests were intercepted, with zero real API calls or receipt submissions.
- Deployment preflight: zero active postings, fulfillments, or Dispatch leases.
- Deployed 2026-09-22 19:38:29 UTC. Local/public health and asset hashes passed.
  The deployed filter applied to live SO11663 returned ten open lines and hid
  seven removed rows. App configuration and other service containers were unchanged.

Release: `mbbs-operator-app:receiving-active-lines-20260922-v1`

Image: `sha256:6bb3d3b1f189b6d1d209a2c4094428f7ac8eff32dc24293ce2320d0c60a66db2`

Release patch, logs, manifests, and verification:
`server/test-artifacts/receiving-deleted-lines-deployment-20260922/`.
The release overlays only `public/operator.js`, `public/operator.html`, and
`public/service-worker.js` over the previously deployed Sales map fix.
