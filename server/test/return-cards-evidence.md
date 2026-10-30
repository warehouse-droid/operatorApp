# Return cards, review, and SOB122269

Deployed successfully. All four live source hashes match the validated release;
production health, runtime configuration, and the other services passed
verification. No migration was required. The exact deployment time and image
are recorded in `server/deployments/return-cards-20261028/deployment.json`.

The card redesign removes the returned/reserved summary and reason/photo counts.
The policy badge sits beside the item name, and Remaining/Returning occupy two
full-width cells beneath it. Cards and list rows use content height so English
labels and long quantities stay contained. The review's alert panels are removed;
posting mode uses compact text, failures retain their retry action, and photo
validation still blocks submission and shows its reminder.

Final validation: `sudo -n bash server/tools/run-return-cards-checks.sh` passed
three UI cases and fourteen Chromium cases at 320, 390, 768, 1024, and 1440 pixels.
These include sixty card-boundary checks with long decimal quantities, Allowed
and Not Returnable badges, and quantity font preferences of 16, 24, and 48 pixels;
twenty reason additions preserving scroll positions; the two-unit layout;
minimum 15px text; photo blocking; and review errors retaining their retry button
without recreating alert panels. All JavaScript syntax and whitespace checks passed.
The initial overflow check reproduced a tablet card extending below its border;
content-sized grid rows and card height fixed it without relaxing assertions.

The browser runs use actual render functions with synthetic data in the standard
bounded Compose environment, with no test database or production credentials.
Teardown removed each task-owned container/network and all temporary run output,
including failed runs. Docker listings and production health were checked.
The four release file hashes are recorded in
`server/deployments/return-cards-20261028/validation.json`.

Separately, an exact-ID NetSuite read confirmed that CMB26103 (1097667) was deleted.
At 2026-10-28 16:59:10 UTC the existing guarded reconciliation for SOB122269 batch
53 released its 11.66 SQFT reservation and retained the deleted CM identity and
audit history. A fresh order lookup returned fulfilled 11.66, NetSuite returned
0, local reserved 0, and remaining returnable 11.66 SQFT for source line 5096826.
No financial transaction or customer message was created. The operational record
is `server/deployments/return-cards-20261028/sob122269-reconciliation.json`.
