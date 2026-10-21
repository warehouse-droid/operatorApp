# ESTB quotation quantities and PDF upload scripts

Prepared and verified on October 14, 2026. The delivery request preview now
includes PLT, LYR, SEC and PCS from the saved NetSuite quotation line fields.
The upload package includes the existing RESTlet updated to 3.4.0 with
`estimatePdf`, and a new signed-in browser Suitelet 1.0.0 for quotation, SO
and PO PDFs. Application and NetSuite deployment were not performed by this task.

Spec: [acceptance criteria](delivery-estb-quote-20261014-spec.md).
Skill: old-coder, Tier 3 for the external document endpoints. Spec approval:
not obtained (autonomous run). These results establish the acceptance criteria
under the described boundaries; account deployment and native NetSuite rendering
still require verification after upload.

| Acceptance behavior | Verification |
| --- | --- |
| Original PLT/LYR/SEC/PCS fields; independent values, decimals, zeroes, missing fields and source preservation | `delivery-request-documents.test.js`, including 80 generated packing tuples |
| Unsaved and attached previews; Sales/Dispatch; visible columns, escaping, zero/blank distinction and mobile scrolling | Existing EST preview browser test and new packing browser test at 1440px and 390px for both teams |
| Request identity, requesting yard and access guards; unchanged price, approval, linkage and instruction workflows | Full delivery-request unit/property/database/HTTP/browser regression suite |
| RESTlet estimate action, health/version, native form, metadata, type/ID/visibility, sandbox, empty/oversized/error bounds | `delivery-estb-pdf.test.js` plus the existing RESTlet harness |
| Original PDF bytes and exact identity through client and exported transport | 60 generated PDF payloads, wrong-action/ID/content tests and configured transport test |
| Suitelet sign-in, GET-only interface, role-visible transaction types, headers, metadata, size and safe error output | Suitelet cases in `delivery-estb-pdf.test.js`; only NetSuite platform modules are boundary substitutes |
| Existing SO/PO PDF, picking ticket, PO creation, edits and adjustment behavior | Native PDF properties, `special-native-po-restlet.test.js`, `special-workflow-adjustment-restlet.test.js`, existing RESTlet harness |

The final fresh run passed **222 tests across 22 files**, with no failures or
skips. Strict types passed for the PDF client and existing delivery domain;
scoped ESLint passed with zero warnings, including the existing RESTlet rules.
The new Suitelet, preview and client use the 12-complexity rule. All six runtime
JavaScript files passed syntax checking. Changed executable line coverage is
**131/131**. The changed-line report combines Node c8 and real Chromium V8 data.
The PDF client covers 27/27 measured branches; the Suitelet covers 37/38. Its
omitted-action health default is the unvisited branch; explicit health is covered.
SuiteScript platform types are unavailable locally, so its platform behavior is
checked through the executable boundary harness and documented API contracts.

All **8/8** manually introduced faults were detected: lost zero PLT, swapped
LYR/SEC, wrong quotation PDF action, accepting another PDF identity, bypassed
RESTlet visibility, anonymous Suitelet access, bypassed Suitelet visibility,
and displaying zero as blank. The mapping and PDF-action faults were also
detected by the generated properties alone (**2/2**). Temporary copies were
restored and removed. Adversarial cases cover unsafe IDs, wrong document types,
unsupported actions/methods, denied visibility, sandbox mismatches, malformed
PDFs, excessive sizes and hostile HTML. File order was shuffled with seed
14102026. These existing tools added no dependencies.

Read-only inspection of ESTB15268 confirmed the original REST field names and
saved nonzero/zero PLT and PCS values; LYR and SEC are unset on that quotation.
Only synthetic records were used in test containers. No production business
records or NetSuite-hosted scripts were changed by this task. The previous live
endpoint inspection found RESTlet 3.3.0 and an unsupported `estimatePdf` action;
the package is the prepared replacement, rather than a claim of live support.

The first feature run recorded 15 expected failures before implementation.
The stricter linter then identified existing PDF parser complexity; extraction
of the content validator preserved its frozen assertions. The old RESTlet
harness already expected 3.2.2 against the saved 3.3.0 baseline; that failure
was reproduced, and its exact version expectation was updated to 3.4.0 plus
an estimate capability assertion. A full-source secret scan encountered the
unchanged synthetic `ticket` browser token; the final scan covers all task
changes and passes without suppressions. Earlier logs are retained alongside
the final run.

Reproduce the checks and prepare the upload ZIP from the repository root:

```sh
ESTB_QUOTE_PHASE=final bash server/tools/delivery-estb-quote-test.sh
python3 server/tools/delivery-estb-quote-package.py
```

The runner uses the standard isolated Compose configuration, cached browser
image and existing locked toolchain. It registers teardown before launching,
uses mbbs-tests.slice and bounded CPU/memory/PID/tmpfs settings, and removes
containers, disposable volumes and networks on failure or success. The final
teardown exited 0: both docker ps and docker ps -a show exactly the four
production containers; production health passes. Logs, reports, coverage,
screenshots, version information and source hashes are retained under
`server/test-artifacts/delivery-estb-quote-20261014/final/`.

Tool versions: Node 20.20.2, TypeScript 7.0.2, ESLint 10.8.0, c8 12.0.0,
fast-check 4.9.0, Playwright 1.62.1, Express 4.22.2 and pg 8.21.0.
The verified source manifest hash is
`2741c331de8beea4278a0570fbd6a03ea98627c6196ddcc12ea14ceb3eee2a06`.
The ZIP has been checked against the current script/guide hashes and its
archive integrity passes; its manifest and SHA256SUMS.txt identify the upload.

Limits: NetSuite-hosted execution, configured quote PDF templates and deployment
audiences must be verified after the user uploads the scripts. Native PDFs show
the quote's configured template; including packing fields in that template is a
separate account configuration. Dependency/license auditing was omitted because
no dependency changed. No benchmark, cross-version matrix or application-wide
test run is claimed. Upload steps are in
[the guide](../docs/netsuite-quotation-pdf-upload.md).
