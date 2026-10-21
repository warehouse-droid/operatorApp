# Delivery requests — approved executable specification

Approved by the user through “Implement the plan” on 2026-10-05.

Sales and Dispatch get separate Delivery Requests pages. Sales at the requesting
yard share access and updates. Requesting yard and pricing origin are separate.
Customer is optional. POS and BIN are mutually exclusive positive whole counts.
Quotes use active MBBS/POS or MBT/BIN transport bands and the existing driving
route provider. Trips round up at 26 POS / 1 BIN, with editable standard capacities.
The quote is mandatory at submission, in CAD before tax, and contains its route,
rate version and capacity evidence. Negotiating times preserves that snapshot.
Dispatch confirms or proposes; Sales accepts or counters. Confirmed requests
can be cancelled, but their pricing inputs cannot be edited. No transport job,
NetSuite order, invoice, rental, or disposal charge is created.

Updates produce global popups and top-bar unread request counts for eligible
Sales and Dispatch users except the actor. Closing a popup preserves unread
state; opening a displayed revision marks only that revision read. Access is
rechecked on every API call. Notifications occur only after committed writes.

## Failure model and acceptance tests

| Failure | Required evidence |
| --- | --- |
| Incorrect truck/rate or rounded-down trips | Named POS/BIN fixture tests, trip properties and mutations |
| Wrong distance boundary or excess-km formula | Both cards at 30/50/65/75 km and raw-metre rounding tests |
| Tampered/stale quote or unsupported origin/size | Service/repository and HTTP adversarial tests |
| Same-yard staff blocked or other-yard/public user admitted | Access unit, repository, HTTP and browser tests |
| Conflicting or duplicate responses | Revision-race, operation retry and transaction rollback tests |
| Lost alerts or opening an old revision clears a new update | Per-user read-race, reconnect and browser tests |
| Popup repeats, leaks to the next account, or interrupts a dialog | Browser dismissal, session-change and dialog-queue tests |
| Migration changes existing workflows | Idempotence/rollback rehearsal and regression baseline comparison |

Concrete quote cases: 26 POS → 1 trip; 27 → 2; 52 → 2; 53 → 3;
3 BIN → 3 trips. Current-rate fixtures within 30 km: 27 POS = CAD 470;
3 BIN = CAD 300. Above 75 km, POS uses base plus excess distance while BIN
uses its configured full-distance per-km rule. Existing rates are not rewritten.

## Setup and verification

Use existing Node, PostgreSQL, Playwright, fast-check, c8, TypeScript and ESLint.
No new dependency or checkpoint commit. Keep unrelated dirty workspace changes.
Persist a gauntlet entry point, test fixtures/mutations and source hashes.
Record pre-existing regression failures separately from new failures.
All test containers use the repository Compose limits and mbbs-tests.slice.
Register cleanup before startup, remove volumes/networks/containers even on
failure, verify docker ps and docker ps -a, and keep logs instead of databases.
This implementation does not deploy or migrate the production application.

## User additions — 2026-10-05

These additions supersede the original direct-confirmation behavior above.
One request can contain multiple outbound yards. Each yard has its own positive
POS/BIN quantity and transport quote; the request sums their charges and trips.
Use the separate-yard rate calculation stated to the user; unsupported origins
fail explicitly rather than inventing a rate.

Dispatch OK creates a pre-approval. A proposed slot also starts the approval
clock; Sales acceptance preserves that original deadline. The configurable
defaults are 3 hours until expiry and a reminder 1 hour before expiry. Settings
are snapshotted for each approval cycle. Sales must supply at least one unique
Sales Order number before expiry. Doing so secures the approval and stops its
clock. An expired request can be re-raised under the same reference and history,
with a current mandatory quote, and requires a fresh Dispatch response.

Secured Sales Orders sort first in Dispatch Planning, including paged feeds,
without altering assignment, visibility, order contents or ties between other
orders. Sales can add extra delivery text and drag/drop images or videos for
each linked order on the same request page. Existing instruction permissions,
revision guards, limits, compression and storage tickets remain authoritative.

| Added failure | Required evidence |
| --- | --- |
| Multiple yards underquoted or mixed load types accepted | Multi-yard sum and per-yard trip/property tests |
| Late SO submission, reset clock on acceptance, or duplicate reminder | Fixed-clock boundary, race and expiry-runtime tests |
| Re-raise reuses expired approval or loses history | Same-reference reapproval and audit integration tests |
| Settings retroactively move approvals | Settings snapshot integration tests |
| Linked orders hidden behind feed pagination | Normal/paged planning priority tests |
| Instruction/media attachment bypasses order access or stale revisions | Real instruction API integration and request-page browser tests |

### Pricing correction requested by the user

3445 and 2967 are one billing yard. Preserve both physical outbound entries,
but combine their quantities before rounding trips and charge that group once.
Sales chooses either 3445 or 2967 as the group's distance-pricing origin. Thus
27 POS from 3445 plus 1 POS from 2967 within 30 km of the chosen origin costs
CAD 470 (2 trips), rather than a separate charge for each outbound yard.
This supersedes the separate-yard calculation for this pair only.

### Consolidation correction requested by the user

For combinations involving other yards, compare consolidation at each involved
billing yard: transfer the other yards' quantities there, then deliver the
combined quantity to the customer. Apply the lowest total transfer + delivery
charge; retain alternative totals and the chosen leg breakdown as evidence.
The existing MBBS POS / MBT BIN per-trip transport cards are used for both legs,
as stated while the optional transfer-card question is pending. Their shared
3445/2967 transport bands supply the standard distance rates for these legs.
Each transfer rounds its moved quantity up separately. No transfer is charged
within the 3445/2967 billing group. Route failures prevent claiming a lowest
quote. This prices and records required transfer legs; operational Transfer
Orders continue through the existing workflow.
The user explicitly confirmed “Yes, use the same rate cards” for transfer trips.

### Final adversarial and runtime checks

Inactive BIN sizes must be unavailable even when supplied directly to the API.
Every consolidation route must finish successfully before a cheapest quote is
returned. Independent route calculations run concurrently; a missing option
cannot disappear from the comparison. Quote submission rechecks the active
rate, capacity settings and all route-yard revisions. The expiry scheduler
cannot overlap its own ticks, logs failed ticks, and recovers on the next tick.
Reapplying or transactionally rolling back the additive migration leaves
existing Sales Order and Dispatch data intact.
All consolidation-yard addresses are validated before requesting paid routes.

### Global alert compatibility

The first full regression run exposed Admin-page startup stalls when the new
delivery alert added another persistent connection beside existing alerts.
Global alerts must share their same-origin event connection. Subscriptions must
receive independent events, release their listeners on close, and close the
underlying stream only after the last subscriber leaves. Authenticated streams
must remain separate from anonymous invalidation streams. Admin Accounts and
Audit, and Dispatch Planning, must remain usable with the delivery alerts active.

### Split Sales Order instruction alerts

Linked split Sales Orders keep their original references for Dispatch priority.
An instruction update on their canonical original order must also update the
secured request and notify Dispatch. Two linked children sharing that original
order produce one request revision and one alert for each instruction update.
