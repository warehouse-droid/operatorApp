# Special-item two-stage handoff evidence — 2026-08-21

## Authorized behavior

- Sales initial form uses Case inquiry date, an optional NetSuite Quote ID,
  canonical/free-text Customer and Vendor autocomplete, and canonical customer
  phone hydration.
- Initial item UOM is restricted to Plt, lyr, Sec, Pcs, or Each.
- Each line requires at least three Toronto working days of lead time.
- SCM first response records availability without exact item resolution.
- Sales follow-up owns the exact Sales item, description, quantity, and UOM.
- SCM second response owns purchase UOM, purchase quantity, pallet quantity,
  vendor data, and purchase cost after the SO is linked.
- PO create and manual PO link are fenced until every accepted line has durable
  second-response evidence.

## Executable evidence

| Check | Result |
|---|---|
| Pre-implementation RED | Failed on missing `assertSpecialPurchaseRelease` export, as expected |
| Focused final suite | 51 passed, 0 failed |
| Real transaction races | SCM response race, close/create race, and second-response/PO-claim race passed |
| Schema-101 upgrade | Upgraded through migration 177; legacy state preserved; second run no-op |
| Coverage | 99.74% statements/lines, 100% functions, 93.04% branches |
| Mutation | 15/15 mutants killed; sources restored |
| Lint | Zero warnings |
| Browser JavaScript syntax | Sales/SCM special pages and all legacy assets passed |
| Secret scan | No high-confidence finding |

The workflow feature gate remains fail-closed by default. Tests do not perform
live NetSuite writes.

## Production deployment evidence

| Check | Result |
|---|---|
| Backup | `mbbs-before-special-stock-sequence-20260821T052204Z.dump`; 224,410,256 bytes; restore catalog readable |
| Backup SHA-256 | `c22015a42f79a5b34ebad86ce1574cd2a82a7a5fa4c752c2ee17b4587e856b54` |
| Migration | `177_special_stock_request_two_stage_handoff.sql` applied once; four columns present; zero invalid ready rows |
| App image | `sha256:5655eb1671bdd47a9782c784d3b31e896ee7a7ffd943542026c484df1da6d837` |
| App-only cutover | 1.55 seconds; database and Ollama were not recreated |
| Production smoke | Health, database-backed bootstrap check, Sales page, and SCM page passed |
| Live gate | Existing `special_stock_request_workflow=true` state preserved |
| Runtime | App, database, and Ollama healthy; post-start CPU samples settled |
