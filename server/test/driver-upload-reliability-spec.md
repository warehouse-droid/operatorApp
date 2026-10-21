# Driver upload reliability specification

Approved by the user on 2026-10-13 through “Implement the plan.” No deployment.
Tier 3: photo evidence, uncertain writes, authenticated diagnostics.

## Acceptance cases

1. A 100-byte photo at 50% followed by a 300-byte photo at 0% shows current 50%, overall 12%. Confirmed references contribute their full weight on retry.
2. Unknown transfer length shows indeterminate current progress. Percentages stay between 0 and 100; no timer manufactures progress.
3. Sending every byte changes the phase to waiting for confirmation. Only a successful response containing an object key confirms storage.
4. Authorization expires after 60 seconds, transfer uses the existing size-based 90-second to six-minute budget, and saving expires after 120 seconds. A hung response body is also bounded.
5. Timeout, HTTP rejection, network failure, invalid response, and cancellation settle once and release timers/listeners. Logout aborts the active transfer.
6. A partial failure preserves previous upload references and selected photos. Retrying skips confirmed uploads.
7. A lost save response causes a server-history check before any new completion submission; confirmed completion advances the route, while an unconfirmed outcome remains blocked until it can be checked.
8. A failed attempt produces an authenticated, persistent audit record with phase, timestamps, build/version, job/photo, attempt, progress, duration, status, and safe reason. The browser does not invent a DNS/CORS explanation.
9. Diagnostic delivery failure leaves metadata queued. Reconnection resends it under the same failure ID, without duplicate audit records. The queue retains the latest 100 entries, reports overflow, and partitions records by driver/device.
10. Hostile diagnostic input cannot choose another identity, exceed field limits, expose credentials/image contents, or produce unbounded storage. Storage denial does not prevent an upload failure from reaching the UI.
11. All available October 7–13 driver routes replay in mobile Chromium and WebKit against the real isolated application. Reports retain source dates and source coverage, including empty days and today's partial snapshot.

## Failure model and evidence

- Indefinite wait: deadline and stalled-body tests, browser execution.
- Lost/duplicated evidence or completion: partial-retry, lost-response and concurrent/idempotent audit tests.
- Misleading progress: weighted progress property tests and browser phase assertions.
- Missing failure explanation: persistent audit and offline queue tests.
- Identity spoofing/secrets: authentication, hostile input, redaction and diff-secret checks.
- Regressions: baseline comparison, repository tests, lint/types, changed-code coverage and targeted mutation tests.
- Host disruption: standard isolated Compose, mbbs-tests.slice, bounded services, registered cleanup and production health verification.

## Setup and boundaries

Use the existing Node, Playwright, fast-check, ESLint, TypeScript and c8 toolchain;
add no dependencies. Preserve the dirty workspace and capture source hashes;
do not create commits or change deployment configuration. Freeze a read-only
historical snapshot, anonymize identifiers and replace real images with fixture
JPEGs. Test containers use neither production credentials nor production volumes.
Persist commands and results in this repository. Record every unavailable layer,
baseline failure and replay limitation explicitly. Production stays unchanged.
