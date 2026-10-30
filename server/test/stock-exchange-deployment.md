# Stock exchange deployment

Deployed on **2026-10-29 at 17:41:03 UTC** after the user's deployment request.
Image: `mbbs-operator-app:stock-exchange-20261029`.
Image ID: `sha256:07a37cacd96568a2d8039b300a7047e38a8a9b219f4fdc6633e189478f842fe0`.

The release overlays 18 reviewed files on the captured live image, preserving
unrelated runtime changes. It adds the exchange service/UI, applies migration
`323_stock_exchange.sql`, and updates Operator, Control, Admin and Sales script
URLs. The previous image is retained as
`mbbs-operator-app:stock-exchange-rollback-20261029`. Database changes are additive;
image rollback leaves the compatible migration and any exchange data intact.

The exact candidate passed 25 exchange tests, 19 policy/admin tests, browser
checks at 390px and 1024px, lint/complexity, syntax, domain types, secret scan,
reversed acceptance order, and all 5 mutation checks (4 applicable mutations
also killed by properties alone). New-module coverage: 298/298 lines,
31/31 functions, 168/183 branches. Candidate verification manifest SHA-256:
`701739853afc5903896051800e5628953806b857b4bf53e7b6df1d886c62b257`.

Return regression comparison: **266 passed; two unchanged baseline failures;
zero new failures** across 268 tests. The two new pallet-search expectations
(`P1 linked credits start while the fresh report is pending...` and
`O2 successful SO searches record reference, mode and elapsed time only`) were
reproduced against the captured live source before this feature. They belong to
the separate, pending pallet performance release. No tests were removed or
weakened; the release runner compares the exact failure names and test-file hash
with the recorded baseline. The normal workspace check remains strict.

An initial lint-only invocation lacked the migration mount; the standard wrapper
supplied it. The added baseline comparison exceeded the harness complexity limit;
it was extracted into a helper without changing assertions or relaxing limits.
The final complete run passed with the documented baseline comparison.

Production verification matched all 18 deployed file hashes, confirmed the
exchange tables, and returned HTTP 200 for health and the relevant pages/assets.
The unauthenticated history API still returns 401. App configuration and the
database, webhook worker and Ollama service identities were preserved.

The exchange posting gates for **3445, 2967 and 150 remain disabled**, revision 1.
Deploying the feature did not create or change a live NetSuite Inventory Transfer.
The SO number is mapped to Position (`custcol_position`).

Release implementation and reproducible steps are in
`server/tools/stock-exchange-release.py`: `capture`, `prepare`, `baseline`,
`validate`, `build`, `deploy`, `verify`. Operational records and exact source
hashes are in `server/deployments/stock-exchange-20261029`. These deployment
copies follow the host's latest-five retention policy. Validation used bounded,
disposable test services and automatic teardown; generated test output was removed.

## Admin switches correction — 2026-10-29

The initial release registered the three exchange gates but omitted their column
from the hardcoded Admin Feature Gates matrix. A browser test reproduced the
missing header. The correction adds Stock exchange → IT with audited switches
for 3445, 2967 and 150, shows Not available for 12441, explains when to enable
posting, and refreshes the script cache key.

Deployed at **17:58:38 UTC**, image
`mbbs-operator-app:stock-exchange-gates-20261029`, ID
`sha256:d69d6f26b9952ec575ed760d58ed8c0d29dd7e25d11a46f57d38571b7611b0be`.
Only `public/mbt-gates.js` and `public/mbt-gates.html` changed over the then-live
`pallet-return-search-20261029` image. Exact candidate browser checks passed at
390px and 1280px: three switches, no exchange control at 12441, required audit
reason, expected revision/idempotency, correct gate writes and state readback.
All 41 existing gate/Credit Memo regressions and the return-control browser
checks passed. Candidate files matched the tested workspace files.

Production file hashes, admin page/asset responses, and health passed. All three
exchange gates remain off at revision 1; no live gate setting or Inventory
Transfer was changed. No migration was required. Service configuration and the
other production services were preserved. Reproducible release steps and audit
records are in `tools/stock-exchange-gates-release.py` and
`deployments/stock-exchange-gates-20261029`. Each test wrapper removed its own
containers, disposable database, network and generated artifacts.
