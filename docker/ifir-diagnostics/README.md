# IF/IR wait diagnostics and quantity rollout

## Rollout state

**Enabled at 2026-10-21 17:22:24 UTC (13:22:24 Toronto)** after the user
confirmed, "ok, the script is updated". The deployed app and existing Admin
gate both report the quantity policy enabled. App health passed and the other
production containers were preserved. No IF/IR transaction was created by
rollout validation. Operational records and rollback configuration are under
`server/deployments/ifir-quantity-policy-20261021`.

At 18:09:07 UTC the app's SO source reader was repaired to resolve numeric REST
unit IDs using the label in its existing SuiteQL request. It checks unit ID and
label agreement and adds no network requests. SOB123167 (204.6 SQFT) and
SOB123163 (4 SQFT) passed the live deferred and native-fallback guards after
deployment. This repair requires no RESTlet upload. Its operational records
are under `server/deployments/ifir-sqft-unit-evidence-20261021`.

The upload candidate is `server/netsuite-ifir-posting-restlet.js`. It remains
compatible with existing requests. New requests explicitly opt in with
`quantityPolicy: "sqft_remaining_v1"`. Its read-only health response advertises
`quantityPolicies: ["sqft_remaining_v1"]`.

For SQFT only, a positive requested quantity within **strictly less than 0.01**
of the transformed line's positive remaining quantity uses that remaining
quantity. Thus 70.6200001 becomes 70.62 when 70.62 remains. A partial quantity
such as 20.1234 remains 20.1234; this is not general two-decimal rounding. Missing
unit/remaining evidence, zero remaining, and excess outside the allowance stop
before save. Other units receive no rounding allowance.

The response retains the actual `id`, `tranId`, `record` body and line fields,
and `source` evidence, with `quantityPolicy` and `quantityAdjustments`. Each
adjustment identifies `orderLine`, `requestedQuantity`, `netSuiteQuantity`, and
`salesUom`. These values come from saved-record readback, including external-ID
replays. Save uncertainty never causes a second native POST.

The app defaults `NETSUITE_IFIR_POSTING_QUANTITY_POLICY_ENABLED` to false.
The release Compose override explicitly sets it to true after account
validation. Enabling it also requires the existing RESTlet environment
settings and Admin gate. A capability response alone does not authorize
activation. The rollback override restores the prior app image and disables
the quantity flag; it leaves the existing Admin gate unchanged.

For simple SO fulfillments using stored line identities, enabling both gates
defers the separate SQFT admission refresh (the reconciliation, source-line,
and linked-transaction readers) to the RESTlet. Current SO identity, unit,
location and completion checks remain before posting. PO, TO, kit, inventory
detail and multi-location safeguards remain. A marker in the durable line
snapshot ensures that native fallback performs a fresh SQFT check even if a
gate is turned off after admission. Existing six-decimal app quantity
normalization is unchanged; the RESTlet also accepts the raw example above.

The Oracle record browser lists `quantityremaining` on both
[Item Fulfillment](https://system.netsuite.com/help/helpcenter/en_US/srbrowser/Browser2025_2/script/record/itemfulfillment.html)
and [Item Receipt](https://system.netsuite.com/help/helpcenter/en_US/srbrowser/Browser2025_2/script/record/itemreceipt.html).
Account validation confirmed live transform quantities and units for SO→IF,
PO→IR and TO→IF using SQFT. Each accepted a 0.0000001 excess and rejected a
0.01 excess. TO→IR was verified using EACH units (exact remaining accepted,
0.01 excess rejected); no open SQFT transfer receipt was available. Its SQFT
tolerance remains covered by the executable SuiteScript fixture. Every live
probe contained a verified nonexistent selected line, so `applyLines` stopped
before `saveOnce`. All responses reported `postingNotAttempted: true`,
`ambiguous: false`, and no transaction ID.

## Persistent collector

`operatorapp-ifir-timings.service` reads the app's existing structured timing
events through `docker logs`. It makes no NetSuite requests and changes no
application database records. It uses Python's standard library only.

The private operational SQLite store is
`/home/ubuntu/operatorapp-operations/ifir-timings/timings.sqlite` (directory 0700,
database 0600). It is operational evidence, outside disposable test output.
The service is limited to 10% CPU, 128 MiB and 32 tasks. Restarting it replays a
small overlap safely. It checks for app container replacement every five
seconds and attaches to the replacement's available logs. Docker's own log
rotation or a destroyed container can still remove logs before collection.

Only allowlisted timing metadata is retained: command/source IDs, operation,
stage, queue, method, sanitized path, duration, outcome and status/error code.
Authorization headers, bodies, photo content and unrelated log text are
discarded. Large or malformed log lines are bounded and ignored. The store is
append-only; there is no automatic deletion of operational audit history.

From the repository root:

```sh
systemctl status operatorapp-ifir-timings.service
python3 -B docker/ifir-diagnostics/timings.py report --since 2026-10-21T14:00:00Z
python3 -B docker/ifir-diagnostics/timings.py report --command-id COMMAND_UUID
python3 -B docker/ifir-diagnostics/timings.py report --since 2026-10-21T14:00:00Z --until 2026-10-21T18:00:00Z --json
```

Reports show IF/IR counts, observed mean/median/p95, then each command's elapsed
span, queue wait, HTTP calls, authentication, admission/source validation,
posting and finalization. Times are UTC; on October 21 Toronto 10:00 is 14:00Z.
Use the detailed `posting.admission`, `posting.transform` and
`posting.finalization` rows to see the posting path. Background photo work can
extend the overall observed span beyond finalization.

Nested and parallel intervals are merged, not added. Per-stage and endpoint
rows may overlap. `queueHttpOverlapMs` exposes concurrency; `unattributedMs`
includes app work, logging gaps and retry delays, not just CPU time. Only
completed spans are recorded, so a request still waiting has incomplete
evidence. Missing admission/finalization and failed spans are flagged. A
command touched by the requested window includes all its retained spans.
Old timing events from containers destroyed before collection cannot be
reconstructed.

## Reproduce checks

```sh
bash docker/ifir-diagnostics/verify.sh
```

The runner uses the standard isolated Compose limits and `mbbs-tests.slice`,
installs the existing locked test dependencies into its unique disposable
artifact directory, and registers teardown before execution. It removes its
containers, networks, temporary sources, logs and coverage, then checks Docker
and production health. It never starts a test database. Concurrent test
projects belonging to another task are left alone.

Type/lint comparison uses read-only copies of deployed app source. For
`netsuite.js`, it preserves unrelated pending workspace changes and removes
only the new client setting. The standalone RESTlet baseline is the committed
version, which predates a separate charge-readback fix. The gauntlet records
that baseline failure separately. Current candidate tests must introduce no
regression, and new diagnostic occurrences are compared as multisets.

See `server/test/ifir-quantity-and-timing-spec.md` and the adjacent evidence
document for the acceptance criteria, final results and validation limits.
