# Quotation PDF scripts

The delivery request HTML preview reads the original estimate line fields
`custcol_plt`, `custcol_lyr`, `custcol_sec` and `custcol_pcs` through the existing
NetSuite REST connection. The preview change adds PLT, LYR, SEC and PCS columns;
saved zeroes stay zero and fields NetSuite leaves empty display as “—”.

Two self-contained SuiteScript 2.1 upload files are supplied:

| File | Purpose | Version |
| --- | --- | --- |
| `netsuite-smart-scm-picking-ticket-restlet.js` | Existing application OAuth connection; adds `estimatePdf` while preserving all current actions | 3.4.0 |
| `netsuite-transaction-pdf-suitelet.js` | New browser PDF endpoint for signed-in NetSuite users: quotations, Sales Orders and Purchase Orders | 1.0.0 |

These files are prepared for upload; they have not been installed in NetSuite.
The HTML preview continues working independently of either upload. Native PDF
rendering uses the transaction's saved form and its associated NetSuite template.
To show PLT/LYR/SEC/PCS in the PDF itself, those fields must be included in that
quotation PDF template. The scripts preserve the native PDF contents.

## Update the application's RESTlet

1. Upload `netsuite-smart-scm-picking-ticket-restlet.js` to the existing SuiteScripts
   folder, then select the uploaded file on the existing RESTlet Script record.
   Keep the existing Script ID, deployment, audience and integration permissions;
   the application's configured RESTlet URL stays the same.
2. Call the existing endpoint with `{"action":"health"}`. Confirm `version` is
   `3.4.0` and `capabilities.estimatePdf` is `true` alongside the previous capabilities.
3. Verify a visible quotation using its numeric internal transaction ID, rather
   than its ESTB document number. For example:

   ```json
   {"action":"estimatePdf","entityId":12345,"includeContent":true}
   ```

   The authenticated GET/POST response includes `ok`, `action:"estimatePdf"`, the
   matching `entityId`, `contentType:"application/pdf"`, `contentEncoding:"base64"`,
   `filename` and `contentBase64`. Use `includeContent:false` for metadata only.
   Use `requireSandbox:true` while verifying a sandbox deployment; this rejects
   requests to production.
4. The application transport `fetchEstimatePdfFromNetSuite(id)` is prepared to
   consume this action. The delivery request's HTML preview remains the default;
   this upload alone does not change it into a native PDF preview.

## Install the new browser Suitelet

1. Upload `netsuite-transaction-pdf-suitelet.js` to SuiteScripts and create a new
   Suitelet Script record from it. Suggested Script ID:
   `customscript_mbbs_transaction_pdf_sl`.
2. Create a deployment, initially with status **Testing**. Suggested Deployment ID:
   `customdeploy_mbbs_transaction_pdf_sl`. Select **Current Role** for execution,
   leave **Available Without Login** unchecked, and limit the audience to the
   staff roles who should see these transaction types and their prices. Each
   role must already have view access to its permitted estimates, SOs or POs.
3. Open the deployment's internal URL while signed in. Append one of these sets
   of query parameters to that URL, using `&` after its existing script/deploy
   parameters:

   ```text
   action=health
   action=estimatePdf&entityId=12345
   action=salesOrderPdf&entityId=12346
   action=purchaseOrderPdf&entityId=12347
   action=estimatePdf&entityId=12345&includeContent=false
   ```

   The first returns capabilities. Document actions open the original PDF inline;
   `includeContent=false` returns metadata JSON without PDF content. Optional
   `requireSandbox=true` rejects production. Only GET is accepted. Failures return
   `{"ok":false,"code":"...","message":"..."}`; check `ok` when reading JSON.
4. Verify the intended staff roles and an existing quotation, then change the
   deployment to **Released** for the chosen audience. The browser Suitelet uses
   a NetSuite login session; the application continues using its OAuth RESTlet.

Reference: Oracle documents [native transaction PDF rendering](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_452452331542.html),
[inline file responses](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4567633001.html),
and [Suitelet login settings](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/chapter_N2997713.html).
