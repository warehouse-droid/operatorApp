# Special Sales Order email and public Note

Scope: future application-created Special Item SOs. SOB122473 is a separately
created NetSuite order and is linked manually to SPREQ-000021. Its NetSuite
fields remain unchanged, as explicitly requested by the user.

Tier 3: order creation. Spec approval: not obtained (autonomous run); behavior
was stated in the conversation before implementation. No dependencies or
database migrations are required. Use the existing Node test runner, fast-check,
coverage, lint, and type tools in an isolated, bounded Compose environment.
Preserve other workspace changes; deploy only the two changed production files
on the current application and worker images after checking their source hashes.

## Acceptance criteria

1. Every new standalone, estimate-transform, and discounted Special Item SO
   explicitly sets `toBeEmailed: false`, including when the customer has no
   email. Creation must not send a customer email or change customer settings.
2. The public request `remarks` (the UI's Note) reaches `custbody7` without
   truncating Unicode or interior newlines. Outer whitespace is trimmed.
3. Delivery address/date/window/contact/drop-off instructions remain intact;
   a nonempty Note follows them, separated by a blank line. Pickup SOs also
   carry the Note. Empty pickup notes omit `custbody7`.
4. Sales internal remarks never appear in the outgoing SO.
5. A recovered order is linked without another POST, and a previously started
   submission without a visible marker cannot be blindly resubmitted. Preserve
   the existing customer/location and duplicate-marker rejection behavior.
6. No new order is submitted for SPREQ-000021. It retains SOB122473 with source
   `manual_link`, status `linked`, and no stale creation error or attention.

## Failure model and evidence

- Inherited email preference causes failure or sends email: exact outgoing
  payload assertions across all creation boundaries and a killed email mutant.
- Public Note disappears, is truncated, or leaks private text: unit and service
  regression tests, randomized multiline text, and note/forwarding mutants.
- Delivery instructions are overwritten: unit/property assertions and a killed
  instruction-removal mutant.
- Duplicate financial documents: existing recovery and submission-lock tests;
  no retry-policy implementation changes or live creation smoke test.
- Concurrent release or user edits are overwritten: guarded manual-link
  transaction with audit evidence; production base/source checks before deploy.

Run RED before changing production code. Record the full Special Item workflow
suite baseline, then rerun it after the fix together with new regressions,
coverage, lint, focused types, mutation, and a reverse-order suite-health run.
Run a synthetic payload through the deployed functions after release without
sending an order to NetSuite. Register teardown before tests and remove all
task-owned containers, disposable volumes, and networks, retaining only logs.

## User-requested extension: Purchase Orders

The user subsequently requested the same behavior for POs. Add these criteria
before implementation:

7. New app-created Special Item POs also set `toBeEmailed: false`.
8. PO `custbody7` preserves `for <SO number>` and appends the complete public
   Note after a blank line. A Note without an SO reference is still copied;
   empty Note/reference combinations omit the field. Private remarks stay out.
9. SO/PO payload prices, lines, markers, and current recovery rules are unchanged.

The dependency image initially selected did not contain application modules.
Use the host's existing complete test-tooling cache as a read-only mount; no new
packages are installed. Teardown removed each failed setup before the retry.

## Deployment refinement

Deploy the application service only. The webhook worker has independently
versioned source; it does not serve the SO/PO creation API. Keeping its image
avoids replacing unrelated worker changes. Verify the current application image
and both baseline source hashes immediately before releasing the overlay.

## Type-baseline comparison

The legacy source produces 8,085 diagnostics when its transitive JavaScript
imports are checked strictly, both before and after this patch. Nine existing
missing-property messages print a larger inferred SO payload type after adding
`toBeEmailed`. Normalize only that displayed object member when comparing the
diagnostics; retain every file, error code, missing-property name, and count.
This is a zero-new-diagnostics check, not a claim that the legacy code is typed.

## User-requested extension: release failed requests

The email/Note fix was deployed first, as requested. SPREQ-000068 was then
released with an audit record after its original HTTP 400 email rejection,
an empty live marker search, and an external-ID lookup returning 404.

10. SO and PO creation failures before submission release their operation lock
    when no remote order was found. Keep the error in the audit trail and return
    it to the caller; allow editing and a fresh retry.
11. A received NetSuite 400/401/403/404/422 creation rejection with no duplicate
    or existing-record error code, followed by successful empty recovery checks,
    also releases the operation and submission timestamp. This follows the
    application's existing return-creation rejection policy.
12. Timeouts, 5xx, 408/409/429, duplicate/existing-record errors, failed recovery
    checks, known remote orders, and previously submitted uncertain operations
    keep duplicate protection. A recovered order is linked rather than retried.
13. Failure cleanup must own the operation, must not unlock a linked order, and
    must preserve unrelated attention. A fresh retry makes only one submission.

Add service regressions, database state/edit/retry tests, classifier properties,
and targeted mutants before implementation. Deploy the additional change only
after these checks pass, preserving the already-deployed email and Note fix.

The failure-handler input now has an explicit JSDoc type. The type gate still
requires zero new diagnostics, while allowing existing diagnostics removed by
that annotation. Report both totals and the resolved count; do not suppress or
normalize new error kinds.
