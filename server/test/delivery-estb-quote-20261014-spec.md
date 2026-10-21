# ESTB packing quantities and native quotation PDFs

Spec approval: not obtained (autonomous run). The user requested PLT, LYR,
SEC and PCS from quotations and a new Suitelet including quotation support.
Use Tier 3 checks for the external PDF interfaces and their access boundaries.

1. Copy each estimate item's `custcol_plt`, `custcol_lyr`, `custcol_sec` and
   `custcol_pcs` into preview fields `pallets`, `layers`, `sections`, `pieces`.
   Preserve saved decimals and zero exactly; absent/null values remain absent
   quantities, never invented zeroes or values calculated from item conversions.
   Preserve source line order, descriptive rows, sales quantities, units and money.
2. The unsaved Sales preview and attached Sales/Dispatch previews show columns
   PLT, LYR, SEC and PCS in that order. Display missing values as an em dash,
   explicit zero as 0, and escape all text. Preserve draft/focus/dialog behavior
   and keep the table inside the mobile viewport with horizontal scrolling.
3. Extend the existing RESTlet with `estimatePdf`, advertise it in health,
   and version the script as 3.4.0. Require a positive safe transaction ID and
   an estimate-specific, role-visible mainline search before native rendering.
   Metadata mode, native configured forms, sandbox checks, size limits and all
   existing picking ticket, SO, PO and mutation actions remain compatible.
4. Add estimate support to the existing validated PDF client and an exported
   `fetchEstimatePdfFromNetSuite` transport. Check response action/ID, PDF type,
   canonical base64, signature and bounds; return the original bytes. Missing
   remote support propagates an error. Do not switch the HTML preview to an
   unsupported native endpoint before the user's NetSuite script upload.
5. Prepare a self-contained SuiteScript 2.1 Suitelet for signed-in NetSuite users.
   GET supports health, estimatePdf, salesOrderPdf and purchaseOrderPdf. It
   returns native PDF files inline, or metadata when includeContent=false.
   Check sign-in, sandbox guard, action, ID, requested record type and role
   visibility before rendering. Invalid/anonymous/unsupported inputs never
   render; exceptions produce bounded JSON errors without raw internal details.
   Apply private/no-store and nosniff response headers.
6. Supply upload instructions distinguishing the browser Suitelet from the
   app's OAuth RESTlet connection. Keep Suitelet login required, audience
   restricted and execution under Current Role. Explain that quote PDF contents,
   including packing columns, follow the quote's configured NetSuite PDF template.
   Prepare scripts only; do not publish or modify NetSuite-hosted scripts.
7. Run the full delivery-request regression suite and existing RESTlet native
   PDF, PO creation and adjustment tests in standard bounded disposable Compose.
   Reuse Node, Playwright, fast-check, c8, ESLint and TypeScript; add no packages
   and create no commits. Preserve existing workspace edits and source baselines.

Failure model: field swaps/lost zeroes (mapping property tests and browser cells),
HTML injection/overflow (hostile values and mobile browser), wrong transaction
or role disclosure (type/ID/visibility/adversarial endpoint contracts), corrupt or
oversized PDFs (client and SuiteScript boundary tests), breaking existing actions
(RESTlet regressions), external release mismatch (record live version separately
and provide upload files without claiming they are installed).

Register teardown before tests; remove all project containers, volumes and
networks on success/failure/interruption, verify docker ps/ps -a and production
health. Preserve logs, source hashes, changed-line coverage and mutation evidence.
Known limit: the offline SuiteScript harness cannot validate account deployment
roles or actual NetSuite rendering; a live health/PDF check follows user upload.

Compatibility harness correction: the saved baseline RESTlet is 3.3.0 while
`netsuite-restlet-harness.js` still expects 3.2.2. Reproduce and record that
pre-existing mismatch, then update its exact expectation to the requested 3.4.0
and add the quotation capability assertion. Preserve its other assertions.
