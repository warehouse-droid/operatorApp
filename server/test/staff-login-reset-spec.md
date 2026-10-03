# Shared staff login and numeric email password reset — 3 October 2026

Spec approval: not separately obtained (autonomous run based on the user's requirements).
Tier 3: authentication and concurrent credential changes. No new packages, commits or external test messages. Use the existing Node, Postgres, Playwright, fast-check, ESLint, TypeScript and c8 test image. Tests use disposable accounts and a captured-mail boundary. Production uses the already configured Gmail SMTP sender, MBBS System.

## Executable behaviors

1. Every staff authority, including Field Sales, signs in through `/login.html` (also `/`). Staff login never falls through to driver authentication. Driver retains its own `/driver` login.
2. Dispatch, SCM, Sales, BOSS, administration, yard control, operator, delivery and Field Sales redirect unauthenticated visitors to the shared staff login. Existing authenticated and Field Sales offline workflows remain intact. An internal return path is honored; external/protocol-relative/script URLs and login loops are rejected. Authorization remains enforced by each destination.
3. Forgot password asks for username and the email saved in Accounts. Unknown, inactive, mismatched or email-less accounts produce the same public response and no mail. No arbitrary recipient can be supplied.
4. A cryptographically generated code is exactly six ASCII decimal digits, including leading zeroes. Email contains that code, the 60-second limit and MBBS System sender. Codes are salted and hashed in storage and never appear in logs, audit events, URLs or API responses.
5. Verification is valid for 60 seconds after SMTP accepts the code; at exactly 60 seconds it fails. A new request is allowed at 20 seconds, invalidates the previous code and any prior verification grant, and is serialized with concurrent requests. The server enforces these times independently of the UI.
6. Five failed guesses exhaust a code. Requests and verification are rate limited across processes using Postgres. Cleanup bounds old anonymous reset/rate-limit rows. Malformed, non-string, non-ASCII or non-six-digit codes cannot verify.
7. Verified code is consumed immediately and grants a random, one-use five-minute password-reset token. New password obeys the existing minimum of six characters, with a 256-character maximum. Completion atomically updates the password, consumes the grant and revokes all staff sessions. It preserves email, roles and all other account data. Replayed/expired grants and changed/deactivated accounts fail. Concurrent completion succeeds once.
8. Browser has one numeric text input (`inputmode=numeric`, six-digit pattern, one-time-code autocomplete), preserves `042817`, shows expiry and resend countdowns, disables resend for 20 seconds and verification at expiry, then shows new-password/confirmation fields after verification. Error text is escaped, duplicate submission is disabled, and phone widths 320–430px do not overflow.
9. SMTP failure does not activate a code. Codes remain unusable if sending or account details change. Reset has no NetSuite or driver effects and does not automatically sign in the user.

## Failure model and checks

- Replay, guessing, enumeration, timing boundaries, invalid input: real-database service and HTTP tests, parser properties and explicit hostile-input tests.
- Parallel resend/verify/complete, login racing a password change: row locks, concurrent integration tests, transactional session/password update.
- Browser navigation/open redirects, mixed staff/driver sessions, mobile timing: Playwright tests and route allowlist properties.
- Additive schema and scoped release: rollback rehearsal in disposable database, source hashes, captured-live-image overlays, health and public asset verification; retain previous image.
- Existing approvals/financial values: complete focused BOSS regression suite and decimal property tests. Completed approval history remains immutable.
- Residual limits: no real account password is reset by automation; actual Gmail inbox receipt and user device autofill require user use. Existing offline Field Sales data may remain accessible under its existing offline session policy until online revalidation.

## UI copy and regression selector clarification

The shared login submission button reads **Sign in**. The existing BOSS login regression selector changes from Login to Sign in; its successful authentication, BOSS destination and forbidden-module redirect assertions remain intact. Browser timer tests pause the clock and await resend rendering before typing, so network and typing time cannot change the boundary being checked.
