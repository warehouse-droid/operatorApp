# Dispatch pending-approval message

Released 2026-10-27 at 21:03 UTC. SOR00264 initially had NetSuite status A
(`Sales Order : Pending Approval`) while its retained browser card requested
fresh details. The canonical detail lookup correctly excluded that status, but
reported the misleading generic `Dispatch order not found` message.

The detail route now checks the local sales-order status after an unsuccessful
canonical lookup. An active delivery order awaiting approval returns HTTP 409,
code `DISPATCH_ORDER_PENDING_APPROVAL`, and:

> This sales order is pending approval in NetSuite. Approve it in NetSuite, then refresh the order pool.

The change is limited to `src/dispatch-repository.js` and `src/server.js`.
Planning eligibility is unchanged, and missing references retain HTTP 404.

Validation: six tests passed, including fresh and ordinary reads by reference,
lowercase reference and numeric ID; unchanged source state; missing references;
successful detail loading after approval; status-text recognition; and avoiding
false approval explanations for inactive or customer-pickup orders. Both changed
runtime files passed syntax checks. Reproduce the regression with:

```sh
bash docker/run-isolated-tests.sh node --test test/dispatch/integration/dispatch-pending-approval-message.test.js
```

Release validation used a captured live runtime plus only this task's patch.
Initial harness runs exposed copied-source permissions and a nullable fixture
field; both were corrected before the final passing run. All runs used the
standard disposable Compose runner, bounded by `mbbs-tests.slice`, with teardown
and deletion of their unique artifact directories on success and failure.

The deployed files matched the validated hashes. Live configuration and the
three dependency containers were preserved; health returned HTTP 200. During
read-only post-release verification, SOR00264's source status was already
`Sales Order : Pending Billing`, and its fresh detail handler returned HTTP 200
with the correct order. This task did not change the order's status.

Source hashes, rollback configuration, validation and operational readback are
recorded in `server/deployments/dispatch-pending-approval-20261027`.
