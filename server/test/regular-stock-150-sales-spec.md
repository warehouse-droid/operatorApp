# 150 Sales regular-stock Delivery access

Spec approval: not obtained (autonomous run implementing the user's request). Tier 3 because this changes authorization for inventory transfers.

Acceptance scenarios:

1. Sales assigned to yard 150 (location 26) can preview an SO whose material lines use 3445 (1) or 2967 (28), including the initial lookup before selecting the supplying yard.
2. That Sales account can submit 3445 → 2967 and 2967 → 3445 regular-stock Delivery requests. Existing automatic approval, SO quantities, transfer creation, printing, and duplicate/retry behavior continue to apply.
3. The new requests remain readable in Sales lists, details, vendor filters, and asynchronous operation results. Removing 150 access removes the exception, including queued work and completed operation results.
4. The exception applies only to regular-stock SO-based Delivery (workflow 2, delivery version 1). Pickup, Stocking, Purchase, Waitlist, historical Delivery, and Special Stock retain their existing yard restrictions. An unassigned account or a different yard account gains no access.
5. 150 Sales receives no new routes involving 12441 or 150 as the supplying yard to 3445/2967. Existing routes to the account's assigned yard still require their existing SCM approval. Invalid/same yards, forged item quantities, mismatched SO line yards, and duplicate SO owners remain rejected.
6. In the browser, a server-validated SO Base Yard survives refresh and can be submitted despite differing from the account's assigned yard. Changing back to Pickup or Stocking restores the assigned destination. Both routes work with only 150 assigned.

Failure model: accidental broadening of Sales permissions (route matrix properties and negative service/SQL/HTTP cases); partial authorization across preview, submit, list and retry (isolated end-to-end service, operation and browser execution); permission revocation (queued work and completed operation checks); duplicate external writes (existing transfer concurrency/retry suite); client bypass or route corruption (hostile inputs, SO-derived yard checks, browser refresh).

Setup: reuse existing Node/Docker test images, fast-check, c8, ESLint, TypeScript and Playwright. Use a disposable PostgreSQL database on an internal Docker network, disable external integrations, and substitute only NetSuite/printer boundaries. Capture the existing source and regression baseline; persist tests, a gauntlet runner, coverage and manual mutations, and an evidence report. Add no packages, schema changes, user-role edits, or commits. Prepare a scoped reversible image overlay for the existing app; verify the deployed behavior read-only without creating live SOs, TOs or print jobs.
