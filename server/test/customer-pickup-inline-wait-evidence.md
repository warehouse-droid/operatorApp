# Customer Pickup inline waiting and TOB01134 sync

The requested Customer Pickup change is deployed. Clicking Load keeps the
truck-load form, photo area and load summary visible during IF posting. The
existing message box shows Loading and one elapsed timer. The separate
verification panel no longer replaces the pickup load page, and technical
verified-transaction counters are omitted from that waiting message.

Load and photo changes stay disabled while the saved submission is pending.
Completion retains the normal Load Complete / Back to Scan flow. An attention
result stays on the same load page, shows the error in the existing message box,
and offers Check status. Ordinary delivery and receiving posting behavior is
unchanged; no backend posting rule was modified by the UI release.

## Verified sync

NetSuite readback at 2026-10-10T01:01:29.054Z confirmed **TOB01134 / 1008202**
as **G, Transfer Order : Received**, with receiving quantities **104.91 SQFT**
and **one EACH pallet**. The existing receipts include **IR14799 / 1010631**
and the user's new **IR15083 / 1053033**. The previously outstanding accounting
quantity is now received.

The scoped sync used the application's normal TO header and line upserts,
recorded an operational audit of the user-authorized external completion, and
attached IR15083 as the latest receipt. The local TO is loaded/received with
local yard status Received and fulfillment status fulfilled. It is absent from
the destination yard's Receiving queue. Existing physical records, posting
jobs and packing/receiving drafts were compared before and after and preserved;
the sync submitted **zero NetSuite transactions** and created **zero physical
records**. The first comparison encountered a Date-versus-JSON-string mismatch;
its transaction rolled back. Normalizing the comparison representation resolved
that mismatch before the successful sync.

Final read-only checks after deployment confirm TOB01200 remains in Receiving
at 2967, and TOB01208 remains completed with IR15082.

## Validation and deployment

The new pickup regression tests initially reproduced three failures in five
cases. The final exact candidate passed **39/39 selected checks**, covering the
pickup waiting/completion/attention states, timer updates, duplicate-submit
protection, pickup photo policy, posting responsiveness and receiving recovery.
A Chromium check clicked Load, retained one live timer, checked disabled
controls, prevented a second submission, and verified completion at desktop
**1280 px** and phone **390 px** sizes. There was no horizontal overflow in the
phone check. Screenshots and browser results are retained with the test logs.

An older cache contract test pinned a September 17 revision. The same assertion
also failed on the captured live September/October asset revisions. It now checks
that exactly one Operator script reference appears in the page and service
worker, both revisions match, and the cache name matches that revision. All
selected checks pass with that invariant. JavaScript syntax and the final diff
and new operational-script credential scans passed. The full repository suite
was not repeated for this presentation change.

Only `public/operator.js`, `public/operator.html` and
`public/service-worker.js` were overlaid on the captured live image. The Operator
script and PWA cache revision is **20261010-pickup-inline-wait-v1**; other asset
versions were retained. The deployed app image is
`sha256:d8ed6d25b9cba496e662acd184671043c7d79af9e71db1e3ffba45edcd1f1d4f`.
There were no dependency, migration or backend source changes in this image
overlay. Live runtime settings and DB, worker and Ollama identities were
preserved. Active native posting was checked before cutover. Local and public
health and all three public asset hashes passed after deployment.

The sync and deployment were authorized by the user's existing instructions.
Private before/after data, NetSuite readback, runtime configuration and rollback
capture are retained under
`/home/ubuntu/operatorapp-deploy-backups/operator-pickup-inline-wait-20261010`.
Redacted manifests, results, screenshots and cleanup evidence are under
`server/test-artifacts/operator-pickup-inline-wait`.

All tests used the bounded standard Compose configuration and `mbbs-tests.slice`,
with teardown registered before launch. Failing and passing stacks were removed
with `down --volumes --remove-orphans`. The one-off scan used init, explicit
memory/CPU/PID/tmpfs limits, the disposable label and `--rm`, with final removal
registered before launch. Final `docker ps` and `docker ps -a` show only the four
production containers; no disposable test volumes or networks remain.
