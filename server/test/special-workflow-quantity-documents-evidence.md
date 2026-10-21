# Special Item quantity confirmation and cached PDFs

Deployed on 2026-09-26 to the app and webhook worker.

Image: `mbbs-operator-app:special-quantity-documents-20260926`

Image ID: `sha256:482ca65888ea236c510b10c327d6b5bfbf3d1e039f970ad57d0e7ce81816a07c`

## Delivered behavior

- SCM quantity confirmation accepts the exact original or confirmed target quantities while its durable NetSuite update plan is in progress. Unconfirmed, unrelated, altered and completed plans retain strict matching. Dispatch remains blocked during the review. This removes the temporary false mismatch raised by interleaved SO/PO webhooks.
- Sales can preview and download a local quote in the new-request form and on saved requests until a real SO exists. It uses the existing Field Sales MBBS PDF template, company settings, tax and expiry. It needs no NetSuite estimate or write. Saved quotes use current saved Sales pricing, discounts and ancillary lines; unsaved edits must be saved to appear in the saved quote.
- Sales and SCM can preview linked SO/PO PDFs within the application and download them. These are app-generated order previews of the locally linked order details, not NetSuite's native printed forms. Sales PO copies omit purchase prices; SCM copies include them.
- The first order preview is persisted in the new `sales_special_stock_document_cache` table. Identical subsequent previews return the saved bytes. Relevant local order or company-profile changes regenerate the next preview; unrelated audit revisions do not. Separate audience caches and authorization checks on every read protect purchase costs. Concurrent first requests generate once. Rendering failures retain the prior cache but do not serve it as current.

## Verification

- Reproduced the original quantity error in real PostgreSQL using the real quantity service and adapter, with NetSuite transport simulated. Both normal completion and lost-response recovery now pass without duplicate SO updates or false attention events.
- Authenticated HTTP tests cover quote availability, no request creation during preview, SO cutoff, workflow flag, yard scope, login and roles, concurrent cache generation, identical repeated bytes, local-change invalidation and Sales/SCM separation.
- 206 regression tests: **205 passed**, with the same existing isolated-database failure in `Dispatch save and restore require a route and Via Yard receipt without weakening snapshots`. The isolated database lacks `dispatch_direct_to_has_residual(bigint)` from unrelated migration 230. A read-only production check confirms that function exists there. No test was skipped or its assertion weakened to conceal that failure.
- All 30 changed-boundary tests also pass in reversed file order. **366/366 changed executable lines** covered by server and browser coverage. **9/9 deliberate mutations** detected. Pricing and transition properties use fixed seed 260926.
- Strict JS type checking passes for the quantity-transition boundary; runtime syntax checks and scoped ESLint pass. Document calculations and cache boundaries are checked through executable contracts. Secret scan passes.
- Full Chromium checks pass for Sales and SCM at 1440px and 390px: draft/saved quotes, SO/PO PDFs, downloads, preserved form values, close/Escape focus, cancellation, error messages and blob cleanup. Generated PDFs were also rendered with PDFium and visually inspected, including Chinese text, discounts and totals.
- The image was built over the previously deployed image with only the ten scoped runtime/migration files. App/worker configuration and dependency containers were preserved. The additive cache migration applied successfully. Local/public health is 200, public assets match the release and unauthenticated document requests return 401.

## Live case evidence

- **SPREQ-000007** / case 62: **SOB121380** (1017068) and **POB03934** (1017168) both read back from NetSuite with the reviewed material quantity **50 PC**. Sales rate **17** and purchase cost **5** are unchanged; the SO's **11 PALLET at 40** is unchanged. The review is approved with no case attention. There is exactly one PO marker. No order was resubmitted or created by this release; this existing pair retains its app linkage and has no native SpecOrd link.
- All four case 62 audience/order PDF variants were generated and saved in production. Every immediate repeat was a cache hit with identical bytes. The complete business case was unchanged by previewing.
- The actual production MBBS quote template rendered successfully inside a **read-only database transaction**, with no new records. A saved quote for the already-created SO correctly returned 409.
- **SPREQ-000006 was not retried or modified.** Its full case fingerprint remains `096eb965548b9bd078ec4bae5d1078efc97c52eba14e7cd2aa2089449efb58ef` before and after deployment and live verification.

Reproducible verification: `tools/special-workflow-documents-check.mjs` in the isolated runner, plus `tools/special-workflow-documents-browser.mjs`. Evidence and source hashes are in `test-artifacts/special-workflow-review/quantity-documents/`; private deployment and live receipts are in `test-artifacts/special-workflow-documents-release-20260926/`.
