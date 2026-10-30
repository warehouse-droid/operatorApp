# IF/IR quantity handling and wait diagnostics

Spec approval: not obtained (autonomous run). The user requested persistent wait
diagnostics and then explicitly requested that the RESTlet accept 70.6200001,
correct it to NetSuite's 70.62, save the IF/IR, and return its number and fields.
This extends the existing strictly-below-0.01 SQFT rule; it does not round every
quantity to two decimals.

## Acceptance criteria

1. For each supported PO→IR, SO→IF, TO→IF and TO→IR transform, a SQFT request
   for 70.6200001 with authoritative remaining quantity 70.62 saves 70.62.
   The response contains the real transaction ID, number, saved line fields,
   original requested quantity and actual saved quantity.
2. Positive differences strictly below 0.01 SQFT may match the remaining
   quantity in either direction. An exact 0.01 excess, a larger excess, zero
   remaining quantity, missing quantity evidence or conflicting units cannot
   silently become a successful corrected posting. Partial quantities remain
   partial. EACH/PC/TON never acquire the SQFT tolerance.
3. An existing external ID returns the original saved transaction without a
   second save. An uncertain save/readback never causes a native repost.
   Saved workflow changes are returned honestly and still pass the existing
   identity, unit, location, quantity and package verifier.
4. The app may defer the SQFT live quantity read only under an explicit new
   rollout setting plus the existing enabled RESTlet gate. The RESTlet must
   recognize the requested policy. The default remains compatible with the
   currently deployed script until its replacement is uploaded and verified.
   Native routing and gate changes retain live quantity handling.
5. A host collector retains only allowlisted timing metadata from application
   Docker logs in a private operational store outside disposable test output.
   Reattachment/replay is idempotent, and replacement containers are followed.
   No authorization headers, request bodies, photos or raw unrelated logs are
   retained. Malformed events cannot break collection or fabricate timings.
6. Reports distinguish queue waits, remote HTTP calls, authentication, source
   validation, posting and finalization. Nested and parallel spans are not
   summed into a fabricated elapsed total. Missing coverage is explicit.
   Reports work without production DB writes or NetSuite requests.

## Failure model and setup

- Wrong unit/remaining evidence or rounding boundaries: contract examples,
  generated boundary cases, and mutations of the tolerance and unit guards.
- Duplicate saves and uncertain replies: existing RESTlet/client recovery
  suites plus replay tests against simulated N/* boundaries.
- Routing changes between admission and execution: gate/native fallback tests.
- Log loss, duplication, malformed input, nested timing inflation: collector
  restart/replay and interval-accounting tests using synthetic logs.
- Host load and leaked test data: unique retention-runner artifact directory,
  bounded disposable containers in mbbs-tests.slice, registered teardown,
  removal and health verification on success/failure/interruption.

No runtime dependencies are added. Use Python's standard library for the host
collector and existing Node/fast-check/TypeScript/ESLint/c8 tooling for posting
checks. No git commits or broad repository cleanup. Operational logging may be
started independently of the posting rollout. NetSuite script replacement and
activation require the actual deployment to advertise the new capability;
simulated tests alone do not claim live SuiteScript field compatibility.

## User rollout constraint (2026-10-21)

The user explicitly requires the new quantity flow to stay disabled until they
upload the replacement RESTlet to NetSuite and tell us it is ready. Prepare and
test the candidate only. Do not enable it, deploy the application changes, or
make a production test posting. A healthy capability response alone is not
authorization to activate. The independent timing collector can proceed.

## User readiness confirmation (2026-10-21)

The user has now confirmed, "ok, the script is updated". This satisfies the
upload hold and authorizes the prepared app rollout after account validation.
Deployment overlays only the eight quantity-policy runtime files on the
current live image and enables its separate environment flag. It retains the
existing Admin gate, saves rollback metadata, checks active operations before
the app restart, and verifies health and the effective gate afterwards.
Operational validation must not create test IF/IR transactions: guarded
transforms stop at a nonexistent selected line before save, and saved-record
checks replay verified existing external IDs.

## SOB123167 unit-reader repair (2026-10-21)

Spec approval: not obtained (autonomous run under the user's bug-fix request).
Tier 3: a unit mismatch could prevent a legitimate IF or permit an incorrect
quantity. Preserve the deferred unit/identity/location guards and native
fallback checks. Resolve the authoritative unit label in the existing SO
SuiteQL read; do not add a network request or change the uploaded RESTlet.

Acceptance scenarios: SOB123167's REST line has `units: "854"` and no display
label; its SuiteQL line has unit ID 854, label SQFT, remaining 204.6. The reader
must return SQFT and the deferred payload check must accept that line. Object
unit references without labels must work as well. Conflicting REST/SQL unit
IDs or labels must stop before posting. Missing labels and non-SQFT units
must still fail the existing deferred guard. Transaction-unit conversion,
line identity, and the native fallback's near-remaining correction must remain
correct. Exercise the real reader-to-adapter path with raw boundary fixtures,
properties over IDs/unit shapes, changed-line coverage, and targeted mutations.

Use existing locked tools and bounded disposable runner; no new dependencies,
git commits, database edits or automatic retries of failed business commands.
Deploy only the reader repair over the current image, retain rollback data,
and read the affected live order through the repaired path without posting.
