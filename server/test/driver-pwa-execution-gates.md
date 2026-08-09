# Driver PWA execution-gate inventory

Recorded 2026-08-08. This inventory is code-backed and describes rules that can prevent the Driver PWA from releasing, starting, or completing a stop. It is not permission to soften any rule.

## Dependency policy

| Rule | Driver Hard mode | Driver Soft mode | Dispatch planning |
| --- | --- | --- | --- |
| Ordinary `yard_replenishment` TO is incomplete when a pickup/drop-off starts | Block | Allow and show/audit a warning | Always block invalid sequencing |
| Ordinary TO-drop dependency application returns a review conflict | Roll back completion and block | Complete the physical stop and show/audit the review warning | Unchanged |
| Direct-linked `direct_to_customer` / same-truck TO is not operator-loaded | Block | Block | Block |
| Direct-linked dependency cannot be conserved/completed at the SO drop | Block | Block | Block |
| Automatic start of the next stop | Apply both rules above before starting | Ordinary dependency may warn; direct-linked still blocks | Not applicable |

The audited Admin gate is `driver_yard_dependency_soft_mode`; migration `140_driver_yard_dependency_soft_mode.sql` defaults it to `false` (Hard). Missing or malformed values fail closed. The policy implementation is in `src/driver-yard-dependency-mode.js`; Driver wiring is in `src/server.js`. Dispatch dependency validation in `validateDispatchPlanDependencies` does not read this setting.

## Rules that can prevent a start

| Boundary | Hard rule | Current escape/soft behavior |
| --- | --- | --- |
| Client/API | Valid Driver session and current supported PWA version | None. Old clients may drain saved evidence only. |
| Route release | Required pre-trip DVIR and Samsara confirmations before assigned jobs are returned | An explicit dispatcher/testing DVIR-skip workflow already exists; this is separate from dependency Soft mode. |
| Route order | Requested job must still be the exact next assigned, uncompleted job on the confirmed route | None. Live recheck runs immediately before writing start. |
| Driver state | Active rest must be ended | None. |
| Stop type | A truck-switch stop must use its dedicated switch action | Dedicated action only. |
| Yard dependency | Incomplete ordinary yard-replenishment TO | The new Admin setting may convert this one rule to a visible/audited warning. |
| Direct dependency | Direct-linked pickup TO must already be operator-loaded | Always hard, including automatic next-stop start. |
| Samsara | When enabled for that driver, required account/driver/vehicle duty handoff must succeed | Existing dedicated truck-switch skip does not weaken ordinary job-start handoff. |
| Local-first foreground action | Device ID, occurrence time, manifest, job fingerprint, predecessor fingerprint, expiry, and idempotency receipt must agree | Online-only requests without a foreground event use the online path; supplied local-first evidence always fails closed. |
| Offline queue | Manifest/grant/driver/device/sequence/fingerprint/action-receipt authorization must agree | Conflicts go to review or fail; they are not dependency warnings. |
| BIN work | MBT capability, pilot scope, schema/version, route identity, and exact asset/template state must be authorized | None. Unsupported or out-of-scope BIN work fails closed. |

## Rules that can prevent a completion

| Boundary | Hard rule | Current escape/soft behavior |
| --- | --- | --- |
| Route order | Job must still be the exact next assigned job | None. |
| Execution state | Job must be `in_progress` with a start timestamp | None. |
| Timing | At least 10 seconds must have elapsed after start | No server bypass. |
| Photos | Required count must be present; offline photos must also have durable receipt, correct scope, size, MIME/JPEG bytes, and SHA-256 | None. |
| Location | Samsara location must verify | Driver may use the existing explicit location override; this is already a warning/confirmation path rather than an absolute block. |
| Yard dependency | Ordinary TO-drop application conflicts require dependency review | The new Admin setting may commit the physical completion and return a visible/audited warning. Internal repository errors still fail hard. |
| Direct dependency | Direct-linked completion/conservation must succeed | Always hard. |
| Order side effects | Custom-order completion and transactional order/dependency updates must succeed | None; the completion transaction rolls back on failure. |
| Foreground/offline identity | Receipt, manifest, device, sequence, immutable fingerprints, evidence identity, and replay rules must agree | Review workflow only; no Soft dependency bypass. |
| BIN evidence/state | Required scans, signatures, receipts, photos, exact assets, state revisions, and predecessor stop state must validate | None. |

If completion succeeds but the next stop cannot be automatically started, the completed stop remains complete and the next stop remains unstarted with `nextStartBlock` returned. The Driver must resolve or explicitly retry that next stop; the system does not undo valid completion evidence.

## Separate dispatcher reopen controls

`validateDriverPwaStopReopen` also prevents a dispatcher from reopening a stop unless it is a pickup/drop-off, is in progress or complete, remains assigned to the current confirmed route, has no later active stop, no active rest, no unresolved truck-switch attention, no foreground action still executing, and no unrelated nonterminal offline event. These controls are independent from Driver dependency Soft mode.

## Testing candidates versus integrity rules

Candidates for a future, explicit testing-only setting are the 10-second delay and selected external-service readiness checks such as Samsara handoff. GPS already has an explicit override, and pre-trip DVIR already has an explicit testing skip.

Do not soften authentication/version enforcement, exact-next-route identity, foreground/offline idempotency, required photo integrity, start-before-complete state, direct-linked same-truck dependencies, transactional order conservation, or BIN asset/state checks. Those protect ownership, evidence, replay safety, or inventory integrity rather than operational timing.
