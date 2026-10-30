# Return summary and floating errors

Deployed at 2026-10-28T18:34:19Z as
`mbbs-operator-app:return-summary-20261028`, over the current
`repair-office-purchases-20261028` image. The four released file hashes match
the validated candidate and the live HTTP assets. Application health, runtime
configuration, and the other production services passed verification. No
migration was required.

The normal yard banner is removed. Ordering yard appears in the existing Sales
Order summary tile; the Sales Order and receiving-yard helper text is removed.
Stock and pallet lookup, form, quantity, yard-policy, and posting errors use the
fixed dismissible warning. Dismissing a warning preserves validation; an altered
inline error or a new explicit validation error is shown again.

Final command: `sudo -n bash server/tools/run-return-summary-checks.sh`.
The run passed three UI behavior tests and eighteen Chromium cases at widths
320, 390, 768, 1024, and 1440. These include sixty long-text/card-boundary checks,
twenty reason additions preserving scroll position, minimum 15px labels, photo
blocking, the two-unit layout, four summary/error scenarios across stock and
pallet modes, and floating errors on lookup, form, and review screens. Malicious
message text is escaped, dismissed errors stay dismissed while unchanged, and
dismissing a wrong-yard warning does not bypass validation. Syntax and scoped
whitespace checks passed.

The initial summary case detected inherited uppercase styling on the ordering
yard value. Its style was corrected without changing the assertion. The final
run used the corrected release hashes. Browser checks exercise actual rendering
functions with synthetic data; no production credentials or data volumes enter
test containers. Both failed and successful runs removed their disposable
containers, network, and temporary artifacts. Final `docker ps` and `docker ps -a`
showed only the four production containers.

Operational records are in `server/deployments/return-summary-20261028`.
The read-only CMB26105 preview at 18:34:57Z confirmed the original rate and amounts
remain zero and match the immutable return intent. Using the deployed payload
builder with a copied intent at rate 1 produces 11.66 stock value, -4.08 fee,
and 7.58 before tax. No live financial update or message was sent. Execution
awaits the user's choice of restoring the original amounts or retaining test
values. SMS delivery investigation was closed by the user.
