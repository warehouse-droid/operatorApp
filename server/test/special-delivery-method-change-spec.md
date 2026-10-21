# Special request delivery method changes

Spec approval: not obtained (autonomous run). The user requested editable delivery methods after SO/PO linking and PO reference updates, and alerts to SCM and Dispatch. No new dependencies or commits are needed.

1. An active, unplanned request with linked SO and PO and a saved vendor PO reference can change from vendor pickup to pickup at its inquired MBBS yard. SO/PO IDs, references, pricing, lines, and canonical pickup orders stay intact. The existing handoff workflow becomes available for movement via the yard.
2. Every successful delivery method change creates one durable notice for SCM and one for Dispatch, including the request number, old/new methods, yard, SO and PO references. Existing historical changes do not create new notices.
3. Acknowledgement belongs to one authenticated operator and one audience. Other users/teams retain their notices. Later changes create separate notices. Notices survive page reload and request completion.
4. Editing delivery details without changing the method creates no method-change notice. Header method changes before order creation also alert both teams. Backorder workflow changes are excluded.
5. A failed or rolled-back change creates no notice. Retrying the saved change preserves its target and produces no duplicate notice. A concurrent/stale revision, unauthorized yard, planned/started fulfillment, or closed request is rejected without changing the method.
6. Private SCM (including SCM staff), Dispatch, and admin sessions receive only their permitted alerts. Sales, public sessions, and unauthenticated callers cannot read or acknowledge these team alerts. Responses are not cached.
7. Linked-order Sales UI explains that delivery methods remain editable and the two teams will be alerted. Desktop and phone users can select yard pickup and save using the existing workflow. Alerts show escaped text, can be acknowledged, survive temporary errors, and clear on logout/account changes.

Failure model: partial writes/duplicate alerts (database transaction and retry tests); missed/offline alerts (persisted events and receipts, browser polling); leaked team notices (HTTP role tests and browser session changes); disruption to existing orders or planning (before/after snapshots and existing fulfillment/Dispatch tests); migration/runtime failures (fresh isolated database and candidate-image startup check).

Verification uses the existing disposable Compose environment, `mbbs-tests.slice`, bounded CPU/memory/PIDs/tmpfs, registered teardown, and retained logs/screenshots. Record existing suite/static failures before changing code. Run focused, special-workflow regression, properties, static checks, changed-line coverage, and manual mutation checks; report any limits honestly. Prepare a minimal image overlay from the current live image with a rollback image and additive migration.

8. Twenty concurrent acknowledgements of the same notice by one user all return success, save one receipt, and leave the request unchanged. This supplements the acknowledgement idempotence scenario with real HTTP concurrency.
