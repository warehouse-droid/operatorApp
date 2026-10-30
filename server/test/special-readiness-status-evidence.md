# Special Item stock readiness — 2026-10-26

Accepted Special Item lines now use the same stock status choices as the initial SCM response: In stock, Low inventory, Wait For Production, Wait for Transfer, and No stock or ETA. Production requires a valid ETA. New transfer selections retain the SO-placement-plus-five-working-days rule, and existing transfer ETA revisions remain editable. Existing boolean API callers remain compatible.

Readiness events record the previous and new status, ETA, availability mode, actor, and time. Unavailable changes after a PO still require Sales acknowledgement. Acceptance, pending-information and closed-case guards, transaction rollback, and revision-conflict checks remain enforced.

Validation: 23 targeted database and browser checks passed against the release candidate, including all five selections, failed-save input retention, Low inventory, new and existing transfers, legacy callers, batch rollback, and Sales/SCM transfer views. The older information-panel browser cases expect the superseded interface and were excluded from the targeted readiness run; its accepted-Low-inventory case passed. A subsequent source comparison found only unrelated operator return-notification assets changed in the live image; the three release files and their dependencies were unchanged.

The repository's isolated Compose runner enforced `mbbs-tests.slice`, bounded resources, disposable storage, and automatic cleanup. Test containers, networks, and generated test artifacts were removed after each run. Deployment and verification records are in `server/deployments/special-readiness-status-20261026`.
