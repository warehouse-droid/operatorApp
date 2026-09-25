# Field Sales

Entry point: `/field-sales/`. This is a separate module for `field_sales` and `admin` authorities. Existing Sales access does not grant Field Sales access. Jobsites, notes and quotes are shared; only the assigned rep or an administrator can change a route. No production deployment, live quote publication or production import is performed by the verification tools.

## City data and refresh

The module uses public structured APIs rather than scraping the Application Information Centre page:

| Data | API |
| --- | --- |
| Community Planning applications | [Toronto ArcGIS feature service](https://services3.arcgis.com/b9WvedVPoizGfvfD/ArcGIS/rest/services/COTGEO_IBMS_AIC_POINT/FeatureServer/0) |
| Active building permits, development-application postal areas, municipal addresses | [Toronto Open Data CKAN API](https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/) |

Planning requests use `APPLICATION_TYPE = 'Community planning' AND STATUS_GROUP = 'Open'`, without ward or district restrictions. The verified planning export contained 5,724 address records representing 2,154 applications, all 25 wards and four districts. Counts are a snapshot, not a guarantee of subsequent feed size. Related addresses remain attached to one application and can be added individually to a route.

Recommended leads include **Statement of Approval Issued** and **Notice of Approval Conditions Issued**, plus issued/inspection-stage permits. An approved **City Council Decision Made** is an earlier opportunity to review through the Planning applications filter. Other milestones remain available. Planning milestones indicate planning progress, not a confirmed start of construction. Inspect the original documents, permit description/date and rep observations before treating a project as active. See the City's [Site Plan Control guidance](https://www.toronto.ca/city-government/planning-development/application-forms-fees/building-toronto-together-a-development-guide/site-plan-control-applications/) and [building-permit status search](https://www.toronto.ca/services-payments/building-construction/building-permit/after-you-apply-for-a-building-permit/search-the-status-of-a-building-permit-application/).

The planner defaults to **the last 12 months**, with 6-month, 24-month and **All ages** choices. Permits use a valid issue date, then application date, then the stored source date; planning uses its latest milestone date. These are lead-prioritization dates, not legal expiry or confirmed activity dates. Import timestamps never make an old record recent. Older and undated records remain stored and available under All ages, including from saved routes and jobsite history. Manual jobsites need no City date.

The construction filter hides mechanical, plumbing, fire/security, sign and alternative-solution categories, plus structured work labels for isolated backwater valves, solar collectors, party-wall administration, change-of-use-only and window-only repairs. Standalone drainage is hidden; building-related drainage, site service and conditional building drainage remain. **Include minor/service work** restores these records. Description keywords do not exclude an otherwise qualifying building project; unfamiliar work is flagged for review. Every selected date, status, category and work condition must match the same City record. Results show that qualifying record and its labelled date, sorted by rep priority, source date and readiness.

Selecting a milestone automatically selects **Planning applications** and clears permit status; selecting a permit status selects **Active permits** and clears milestone. **Notice of Complete Application Issued** is searchable and describes early planning, not construction approval. The map area and age filter stay selected; the visible list, map counts and Select all use the same criteria. Permit matches to another application's address are displayed as address evidence, not automatically merged into the project. Ambiguous municipal coordinates are not assigned. Postal filters use three-character FSAs; the system does not invent full postal codes.

When both the module and automatic imports are enabled, a worker checks every minute. It refreshes planning, permits and postal areas daily, and municipal addresses weekly. The initial run imports planning, postal areas, permits and addresses, one source per tick. Admins can refresh each source manually and inspect run counts, timestamps and errors in Settings. A failed attempt is retried by the normal daily/weekly schedule; an admin can retry sooner. Interrupted running leases expire after two hours.

The importer pages through the entire feed, checks row identities/counts and source metadata, stages records, and applies a complete snapshot in one transaction. Failed or changing feeds retain the previous complete snapshot. Absent source records are marked absent rather than deleted. Rep notes, priority, contacts, visits, quotes and manually overridden details survive refresh. Source URLs, labelled source dates and **Last imported** timestamps remain available on the jobsite.

Resource IDs are versioned in `src/field-sales/importer.js`. If Toronto replaces a dataset or changes fields, failed-run history makes that visible; update the adapter and rerun its contract tests before accepting the new source.

## Planning and visiting

Desktop Prospects supports search, district, ward, FSA, milestone, source, category, permit status, priority, observed stage, visit outcome, follow-up date and map bounds. Wards display their names alongside their numbers. The list automatically follows the visible map rectangle when the map moves or zooms; filters and pagination retain that map position and unsaved route details. Select individual checkboxes or use **Select all** to select every matching jobsite in that area across pages, then **Add selected to route**. Changing the map area or filters clears the selection. Bulk additions skip identical jobsite/address stops already on the chosen route and respect the 250-stop route limit; narrow the map or filters for larger result sets. Detail views include contacts, notes, source documents, address aliases, visits/photos and quotes. Reps can add manual jobsites and review possible duplicates before merging.

Routes have a Toronto-local date, morning/afternoon/full-day/custom window, multiple named areas, optional origin/destination, and editable stop durations (15 minutes initially). Multiple routes may be planned for a date. Visiting keeps the route open without Start/Pause/Finish controls and remembers the selected route across reloads. Each stop has **Record Visit**, **Edit Stop**, **Navigate** and **Quote** actions; the jobsite name opens its details. Record Visit opens a popup and changes nothing until saved. Edit Stop includes Visit Next, Skip/Restore and Remove. Quote starts the existing quote editor with that jobsite selected. Completed visit evidence remains preserved, with navigation and quoting still available. See [Visiting verification](field-sales-visiting.md).

Suggested ordering uses geographic nearest-neighbour and two-opt refinement. It is a preview requiring Apply; it is not a promise of the fastest driving route. Road estimates use the existing metered Google Maps gateway, including origin/destination travel and visit time. Requests exceeding the gateway's point limit are chunked with overlapping endpoints so every leg is counted once. Missing/disabled Maps produces an unavailable estimate instead of an invented driving time. No separate billing key bypass is introduced.

The phone layout keeps routes open and supports navigation links, Visit next, editing/skipping/restoring stops, and adding an existing or newly discovered jobsite. Arrival recording supports configurable outcomes, notes, JPEG/PNG/WebP photos, observed construction stage, revisit date and revisit priority. Follow-ups remain a separate queue until someone adds them to a dated route.

The PWA caches its own shell and keeps per-operator IndexedDB records, quote drafts, ordered commands and photos. Open needed routes/jobsites/catalog searches online before disconnecting. Pending work is removed only after server acknowledgement. Reconnection retries durable command IDs; server receipts prevent duplicate visits and quotes. Stale route/jobsite edits have a review action; tax/stale quote failures open a reviewed replacement draft and retain previous pending copies. A recovery download is available. Other validation errors remain queued with their reason and Retry; they are not silently discarded.

Offline cached sign-in is limited to 14 days after a successful online verification. Revoked/expired sessions cannot synchronize until authentication succeeds. Offline access necessarily relies on the security of the rep's device. PDFs and confirmed Sales Order submission require connectivity; quote drafts and calculations work offline.

## Customers, quotes and Sales Orders

The dedicated **Customers** directory stores Field Sales customers separately from the NetSuite mirror. Customers have multiple editable types, representatives and jobsites; each jobsite can link multiple customers. Representatives can have a name, role, phone and email. Archiving keeps historical records. Customer edits use revision checks.

**Record Visit → + Add customer** creates the customer and representatives inline, preserving the visit note, photo selection and revisit date/priority. Existing customers use one autocomplete textbox: search by name, phone or email, choose a suggestion, then **Add to site**. The linked list shows customer and representative contact details without checkboxes. **Remove** unlinks that site only; it retains the directory record, other site associations and historical visits. The visible active customers and their representatives are recorded with the visit. The quote's customer popup uses the same controls. Offline commands synchronize customer, site link, visit and photos in order.

Choose a linked jobsite, local customer and optional representative, then add items from any company. The editor automatically groups them into **MBBS**, **MBT** and **MBR** totals. Saving creates **one quote in Field Sales**, with a shared number, revision, customer, jobsite, memo, confirmation and overall total. **Download PDF** produces one file, with every represented company starting on a new page using its own template and totals. Company sections can continue over further pages. There is no issuing-company selector. Offline saves retain the parent quote ID. Old pending company batches can be reviewed into one quote while their originals remain in recovery. Proven unconfirmed saved batches are consolidated by migration 214, retaining company document numbers and immutable history. Original child links open the parent; explicitly selected historical revisions remain readable. **Create combined draft** copies legacy items into one draft without deleting old history.

The item textbox stays at the bottom of Items & services and searches all three companies, including saved catalog items offline. MBBS suggests **TRADE-A** prices; MBT and MBR suggest **TRADE**. Quantity breaks update unchanged suggestions while preserving entered rates. Missing prices require an entered rate. Each item shows a subtotal, the totals panel lists items under their company totals, and a single memo appears below the total and appears on each company section of the PDF. Prices retain up to six decimals; line amounts and tax round half-up to CAD cents.

Each save snapshots the customer, representative, company template, memo, catalog price, entered rate and tax policy. Quote date is automatically today's Toronto date at save; expiry uses that company's validity setting, defaulting to 30 days (one month). There are no quote-date, expiry-date, Bill To, Ship To or Expected Close inputs. PDFs use the selected revision and follow QuoteSample.pdf with company header, customer/contact, jobsite, date, expiry, rep, shipping method, items, totals, memo, signatures and barcode. New PDFs omit Bill To/Ship To blocks and Expected Close; older saved PDFs retain their original layout. Chinese fonts are embedded. Packing columns PLT/SEC/LYR/PCS are omitted. Admin Settings can edit each company's name, address, phone, HST number, terms, validity in days and visible fields, and preview the template before saving.

Quotes remain local. **Confirm & Create Sales Orders** records who confirmed, when, notes and optional PDF/image evidence against the saved revision. The confirmation popup selects existing NetSuite customers for MBBS and the shared MBT/MBR account. Confirmation validates every required link and company, saves the selected links and locks that revision atomically with one durable Sales Order intent per represented company. Missing/invalid links or a stale customer edit reject the entire confirmation. All intents link to the same Field Sales quote ID. The quote displays each company order's reference, status and error; individual failed orders can be retried. Changes afterward use **Copy to new quote**; changes to an existing order are handled in NetSuite.

Customers and subsidiary memberships are created and maintained in NetSuite. Field Sales only reads and links existing active CAD customers; it never creates NetSuite customers or subsidiary relationships. Local customer records, visits and quotes remain available without NetSuite links. MBBS uses a separate mapping; MBT/MBR share one existing customer with both subsidiary memberships. Stable order external IDs, locked customer mappings and a unique per-quote/company outbox prevent duplicates. Lost responses recover by order external ID. Remote customer identity, membership, item state and exact totals are verified; discrepancies retain any known NetSuite ID and stop in **attention**. Retry reconciles that same order. Legacy intents without an explicit accepted customer link cannot create new orders; already-created orders can still be recovered by their saved identity.

Company settings have no default NetSuite customer ID, customer form ID or new-customer status ID. The selected quote customer's own NetSuite account is resolved when its Sales Order is created. MBBS's 3445 yard is NetSuite location **1**; the display code 3445 is not its internal ID.

New quotes leave Sales Order billing to the NetSuite customer's sourced billing address. Billing is maintained in NetSuite; shipping derives from the linked jobsite. Local customer billing fields are optional and do not gate confirmation. Quote forms cannot override customer billing. See [combined quote verification](field-sales-combined-quotes-evidence.md) for the current workflow.

## Activation

1. Apply Field Sales migrations `210`, `211`, `213_field_sales_customer_quotes.sql` and `214_field_sales_combined_quotes.sql`. The combined-quote release applies only 214 over the existing module after a backup and rollback rehearsal. Retain all legacy quote revisions, estimates and queued recovery data.
2. Grant Field Sales through **Admin → Accounts**. Configure company templates and tax policies in `/field-sales/#settings`. Local customer, quote and PDF features work while external posting is disabled.
3. For Sales Orders, deploy [netsuite-field-sales-restlet.js](../netsuite-field-sales-restlet.js) version 2.1 as a SuiteScript 2.1 RESTlet to the NetSuite sandbox, with the existing integration role/OAuth access. Grant read access to customers, customer-subsidiary relationships and item/currency search, and the required Sales Order permissions. Customer/relationship create permissions are unnecessary.
4. Enable Multi-Subsidiary Customer for the shared MBT/MBR customer. Configure each company's subsidiary, Sales Order form, CAD currency, location and payment terms. Configure the legacy tax code if SuiteTax is disabled and pick-up/delivery IDs for the account's `custbody3`. Current subsidiary mappings are MBBS=1, MBT=3, MBR=7; verify them in the target account. Do not substitute guessed form, status or currency IDs.
5. Add these fields to each Sales Order form: `custbody_fs_quote_revision` (integer), `custbody_fs_quote_hash` (free-form text), `custbody_fs_state_hash` (free-form text, at least 72 characters), `custbody_fs_company` (free-form text). The revision/hash fields may reuse their existing definitions with Sales Order applicability enabled. Keep legacy Estimate fields for historical records. Add `custscript_fs_allow_writes` checkbox to the RESTlet, initially false.
6. Configure the URL below and use **Check NetSuite connection**. Validate existing customer links, shared subsidiary membership, all three company forms, units, taxes, exact totals, confirmation retries, lost responses and external edits in the sandbox before operational enablement. The local contract tests simulate NetSuite APIs; they do not establish account compatibility.

```dotenv
FIELD_SALES_RESTLET_URL=https://ACCOUNT-sb1.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=SCRIPT_ID&deploy=DEPLOYMENT_ID
FIELD_SALES_NETSUITE_WRITES_ENABLED=false
FIELD_SALES_NETSUITE_REQUIRE_SANDBOX=true
```

Submission requires all three gates: server environment, **Allow confirmed Sales Orders** in Settings, and the RESTlet write parameter. Production also requires the intended production URL and `FIELD_SALES_NETSUITE_REQUIRE_SANDBOX=false`. The current deployment leaves posting disabled because the dedicated RESTlet URL is absent. It does not create NetSuite customers, estimates or Sales Orders during deployment.

Rollback uses the prior application image, preserving the additive tables and all data. Disable Sales Order posting before rollback; do not drop production tables.

## Customer/quote verification

The September 21 customer release is recorded in [customer quote evidence](field-sales-customer-quotes-evidence.md). For the combined quote editor, see [combined quote evidence](field-sales-combined-quotes-evidence.md). The current existing-NetSuite-customer confirmation workflow, 150-test regression suite and scoped deployment are documented in [existing customer evidence](field-sales-existing-customers-evidence.md). From the repository root, the current isolated runner is:

```sh
sudo -n bash server/tools/field-sales-existing-customers-test.sh start
python3 server/tools/field-sales-existing-customers-evidence.py inputs
sudo -n bash server/tools/field-sales-existing-customers-test.sh exec bash tools/field-sales-existing-customers-checks.sh
python3 server/tools/field-sales-existing-customers-evidence.py report
```

The UUID compatibility fix uses `getRandomValues` when `randomUUID` is unavailable. It preserves existing IDs and pending work; it does not change George's permissions or account.

## Original module baseline

The initial Field Sales release's wider repository results remain in [the original evidence report](field-sales-evidence.md). That baseline contained 37 pre-existing failed assertions across 30 files. The current customer/quote verification above covers the complete Field Sales test suite and its desktop/phone/offline workflows; it does not claim a fresh pass of unrelated operator and dispatch suites.
