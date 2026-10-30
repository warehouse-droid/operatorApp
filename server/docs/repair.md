# Repair module

Repair is controlled by `REPAIR_ENABLED` (off by default). Financial posting
additionally requires `REPAIR_NETSUITE_POSTING_ENABLED=true` and the Admin
posting switch in Repair Settings. Office equipment-master creation is separate
from financial posting. Equipment searches refresh from NetSuite Vehicle Master
and Machine Master automatically. Migrations 310 and 313 provide the Repair
schema and standalone-machine identity.

## Screens and access

* `/repair`: the merged department and office portal for authorized Repair,
  Dispatch and yard Control users. Office/Admin tools include quotes, purchasing,
  record search, parts/stock, equipment master search/creation and posting review.
  Supplier costs and purchase evidence remain Office/Admin only. This is a
  standard browser page; `/repair/office` forwards here and preserves saved links.
  Shared alerts and Repair updates stay together in one persistent top-bar group.
* `/repair/workshop`: the installable Repair Team PWA, using Operator's visual
  shell with only **Jobs** and **Parts**. Jobs uses a 30% card list and 70% detail
  panel on tablets, and list/detail navigation on phones. Technicians start
  work, enter notes, take photos, finish inspection, complete approved jobs and
  request job parts. Equipment correction remains collapsed in job details.
* Team **Parts** searches stock by name/SKU and shows job-linked purchase
  requests and their status. Technicians can request purchases against approved
  repair scope. Office retains purchase approval and actual purchase records.
* Operator and Driver embed `/repair/requester.html`, containing new requests
  and active progress only. Completed work remains visible until receipt.
  Receiving requires a new receiving photo; rejection requires a reason and
  returns the same job to re-inspection.
* `/repair/quote#<secret>`: limited outside-customer quote view and decisions.
  Tokens are hashed, expire after 30 days, and are invalidated by a new link or
  quote revision. The fragment is never included in the page request URL.

Team notes and selected photos are kept while changing tabs/jobs in the open
app. Failed uploads leave the draft available for retry. The Team completion
form requires notes and a photo; server approval, outstanding-parts and receipt
rules still apply. Work mutations require connectivity; the PWA has a reconnect
screen rather than an offline posting queue.

Admin can assign `repair_office` and `repair_technician` using existing account
management. Primary roles retain their established home routes. Internal truck
quote approval requires Dispatch; forklifts/loaders require the responsible yard's Control;
internal MBR requires MBR Sales; outside customers approve through their link.
Office prepares quotes but does not approve on another approver's behalf.

## Equipment selection and correction

The requester selects registered equipment. Its number, name and type appear
together, with a search by number, machine name or serial. Vehicle Master
`custrecord76` was checked through a read-only NetSuite query on 2026-10-26:
it contains explicit labels such as Forklift, Loader, Track Loader, Bin Truck,
Flat Truck and Truck, but also placeholders and model names. Repair retains the
source label and recognizes only explicit truck/forklift/loader classifications.
It does not infer type from company, requester role, model or plate.

Unknown types, or a requester-proposed change to the imported type, require
confirmation by office/Admin or a repair technician before internal quote
approval. Internal approval follows the confirmed type and responsible yard;
MBR Rental and external-customer approval routes retain their separate rules.

Office/Admin and technicians can use **Correct equipment / type** on an open
request. A reason is required. The audit preserves original/current equipment,
type, yard, actor and time. A correction keeps the same request and inspection
fee; it moves only that request's equipment hold. A different asset requires
inspection again. Changed equipment, type or yard invalidates earlier quotes
and public links and rejects outstanding, unpurchased parts requests for review.
The company and billing customer must stay the same. Pending receipt and closed
repairs cannot be bypassed through a correction.

Corrections apply to the repair request; they do not silently edit the NetSuite
Vehicle Master. A posting in progress prevents correction. If posting was already
attempted for a different asset, subsequent automatic posting stops for office
reconciliation of the existing WOR/SOS, retaining their identities and original
inspection charge.

Quote lines initially display Approve, but only **Save all decisions** records
approval. Inspection work is allowed before approval; repair work and parts
requests require accepted scope. A revision requires fresh decisions.
Pending quotes show the total if all lines are accepted. Quote history retains
earlier prices and decisions; quote PDFs include tax and the inspection credit.

## Inspection and accounting

Every request creates one durable inspection posting intent, independently of
quote approval. The default fee is CAD 150 before tax, snapshotted on submission.
An accepted CAD 1,000 repair totals CAD 1,000 before tax: inspection 150 + repair
1,000 − inspection credit 150. If inspection 150 was already invoiced, the
remaining pre-tax charge is 850, subject to office accounting reconciliation.
If every line is rejected, inspection remains chargeable. Re-inspection reuses
the request and inspection identity.

Verified account formats:

| Record | Mapping |
| --- | --- |
| WOR | `customrecord_mbr_work_order`; vehicle `custrecord_wo_vehicle`, customer `custrecord_wo_customer`, complaint `custrecord147` |
| Labor | `customrecord246`; parent `custrecord141`, item `custrecord209`, actual hours `custrecord152`, billable hours/rate `custrecord156/157` |
| Parts | `customrecord247`; parent `custrecord159`, issued/returned `custrecord162/167`, billable quantity/price `custrecord169/170` |
| SOS | Sales Order form 183, subsidiary 7, Repair location 52, currency 1; WOR link `custbody14` |
| Inspection | Service item 10660; flat inspection credit uses discount item 10716 |
| Purchase Bill | Form 137; expense lines; account 2211, class 127, location 52; 13% tax code 11 |
| Vehicle / machine | `customrecord240` and `customrecord_mrb_machine_master`; link by shared item identity, never placeholder plate `#` |

The purchase format was inspected against Bill **00214958**, internal ID
1032718. Completed, invoiced purchases create expense Vendor Bills. Numbered local POs
can be issued from approved repair jobs; they do not create NetSuite POs or
NetSuite item receipts. Local stock receipt is
independent of Bill posting; consuming stock never creates another Bill.

Configure the MBBS billing customer before refreshing the directory. MBT's
verified customer is 7973; internal MBR Rental is 13366. The current renter from
Machine Master is not used as the owning/billing company. Missing Vehicle Master
registration requires an existing NetSuite customer and enabled posting gates.

## Recovery and evidence

Commands are idempotent per actor and command UUID. Job revisions prevent stale
overwrites. Stock movements lock the part and deny negative balances. Posting
workers lease durable intents, reuse external IDs and preserve recovered WOR
references. Expired leases or ambiguous responses stop for office review rather
than automatically repeating writes. Supplier/invoice duplicates are checked.
Existing billed, externally modified, or manually linked orders require office
reconciliation; automatic financial replacement is blocked.
Purchase detail shows Bill posting status and errors, and offers an audited retry
after reconciliation or verification of an existing Bill.

Upload bytes are validated before storage. Original receipts remain unchanged.
Files use the existing R2 worker when configured, otherwise private files under
the application data directory's `repair-originals`. Downloads verify size and
SHA-256 after authorization; archived R2 evidence remains readable through the
photo archive. Generic photo preview cannot bypass Repair's evidence authority.
Search covers request, vehicle, part, supplier, invoice, date, filename and caption
metadata. OCR is not included.

Notifications are persistent in Repair. Optional Web Push reuses the existing
VAPID configuration and requires browser permission. A dedicated Repair service
worker opens the correct Driver/staff view without caching private API responses.
Repair submissions, work updates and receipt require a connection. The request
form retains its text draft in the current browser session; the existing Driver
offline workflow remains separate.

## Fleet safety and activation limits

Out-of-service truck holds share the Dispatch mutation lock, block future plans
and new Driver job starts (including replay), and leave already-started work
completable. Repaired equipment is released only after formal receipt; receiving
a declined repair retains the hold. Requesting drivers/operators, technicians and authorized office staff
can change condition with an audited reason.

Equipment selection is on the Repair request, as clarified by the user. The
existing Operator loading-job flow still has no forklift/loader assignment.
Repair and Control display the selected equipment's condition; this selection
does not associate a machine with unrelated loading jobs. Operator loading-job
execution blocking is therefore not implemented.

No live posting verification has been performed: production creates would make
real financial records. Keep posting gates off until account mappings, tax
treatment and write permissions have been verified through the deployment's
approved NetSuite validation process. The adapters stop on unverified tax codes,
unexpected totals, billed orders and external edits.

## Reproducible checks

Run from the repository root:

```sh
sudo -n bash docker/run-repair-tests.sh
```

The runner uses the standard bounded E2E Compose service, `mbbs-tests.slice`, a
disposable database, and a unique retention-managed artifact directory. All
containers, disposable volumes/networks, logs and coverage output are removed
on success, failure or interruption. `--source` uses existing test images with
explicit read-only source mounts; it never mounts production settings or data.
The acceptance specification is `test/repair/spec.md`. Final results and known
coverage limits are recorded in `test/repair/evidence.md`.

## Office request and job workflow

The New request form offers existing equipment or registration of a new Vehicle
Master / Machine Master during intake. The request and master registration use
separate persistent command IDs, so retrying a lost response returns the same
records. Operator and Driver keep their focused requester screens.

The office portal lists one row per request. Opening it shows its repair jobs,
with their own quote revisions, approvals, work notes, parts and purchase orders.
The first job requires inspection. Team can report an additional issue with notes
and photos; office issuing its quote creates another job on the request. Earlier
approved jobs can continue while the additional job awaits its own approval.

Request/job status is Queue for Inspection, Wait for Quote, Wait for Approval,
Queue for Repair, Completed or Closed. Parts status is independent: Wait for PO,
Wait for Parts, Parts ready or no outstanding request. Work and purchases remain
limited to approved scope. Each job completes independently; parent receipt
waits for every job and all reported issues to be resolved. Office may dismiss
an issue only with an audited reason. Existing operating restrictions remain.
Completed stays visible to the requester until equipment is received. Receipt of
declined work still preserves its operating restriction.

Office job details group equipment/type, priority and condition in an open panel.
Condition and equipment corrections require a reason. Quote preview has Edit and
Cancel controls; saving creates a new version requiring fresh approval. Job
completion remains in the Repair Team PWA with notes and photos.

Office or Team may request approved job parts. Office searches a supplier and
issues a numbered local PO from the job, enters or updates ETA, downloads the PO,
and records physical receipt in that same section. Partial orders leave the
unbought quantity available for another order. Local PO issue creates no NetSuite
PO or Vendor Bill. Record the supplier invoice on the existing local PO and attach
the original receipt and purchase photo before completing the purchase. Physical
receipt and the later invoice share one purchase identity, preventing duplicate
stock. Existing financial posting gates still apply.

Parts used/returned can be added and corrected from the job or Team view.
Corrections require a reason, preserve an audit event and write compensating
stock movements; stale edits, negative stock and returns exceeding use are denied.

A job may have multiple POs at different repair stages. Each order keeps its own
supplier, ETA, receipts and invoice; all remain on the job after receipt. Further
parts requests can be raised during approved repair work. The job's parts ETA is
the latest outstanding delivery, so editing an already received PO cannot replace
the ETA for a later order. Printed POs and their invoice pages identify the job.

All child jobs post through their parent request's existing WOR and SOS. The
worker aggregates current approved quotes, parts usage and work entries across
the request. Inspection is charged and credited once. Existing MBR internal
repair routing is preserved. Child job creation never creates another inspection
posting. Quote line IDs must be unique across active request quotes.

Migrations 316–318 retain original request IDs, quote history, stock quantities
and NetSuite links, and create an initial child job with the original request ID.
Job-specific records keep both request and job links. Team reads child jobs; the
office list and Operator/Driver progress remain grouped by request.

Requester details explicitly aggregate every child job, including mixed-role
Operator accounts, while retaining the correct action revision for handover.

Operator and Driver now open **Repair requests** as a separate page from their
PWA. Personal History contains its normal records and a navigation button.
The requester page shows New repair request and Ongoing requests raised by that
signed-in identity. Completed company repairs remain ongoing until received.
The requester API context also restricts accounts with additional staff roles;
their departmental permissions remain available in the Repair department portal.

Control has an **Equipment receipt assignments** button for internal forklifts
and loaders. Dispatch has the same button for trucks. Search equipment or a
request number, choose an active Operator/Driver, and save the receipt assignment
for that request. The default receiver is its requester. Assignment never clears
an operating hold or changes dispatch plans. A delegated receiver gets a separate
**Equipment to receive** section with the handover details and photo form; the
other person's full repair request is not added to their personal request list.

Receipt is stored once on the parent request. All jobs must be completed and
newly reported issues resolved before any receipt is available. Internal company
equipment requires an Operator or Driver's photographed acceptance/rejection.
MBR rental equipment closes directly when the Repair Team completes the last
job. Previously completed rentals still awaiting receipt have a Close rental
repair action in Repair Team.

For external equipment, Office or Repair Team creates a **Customer confirmation
link** after all jobs finish. The customer opens it without a staff login, enters
their name, takes a handover photo and accepts or rejects the equipment. The link
is valid for 30 days; creating another replaces it. It exposes only the request's
handover details, with no quote prices, supplier records or private attachments.
Rejection sends the request for re-inspection. Declined repairs retain their
operating restriction after receipt.
Equipment/type/yard corrections reopen affected jobs for approval. A different
asset also requires inspection again; the superseded quotes remain in history
and the office can prepare their replacements.
