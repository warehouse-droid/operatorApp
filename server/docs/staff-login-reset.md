# Staff login and password reset

All staff use `/login.html` (also available at `/`). Driver sign-in remains at `/driver`. Field Sales uses the same staff account and authentication endpoint as the other modules. Module links return to an authorized destination after sign-in.

Select **Forgot password?**, enter the username and the email saved in **Admin → Accounts**, and select **Send code**. Enter the six numeric digits exactly, including a leading zero. The code expires 60 seconds after the mail server accepts delivery. A replacement can be requested 20 seconds after the previous request; it invalidates the previous code and reset grant. After verification, choose and confirm a new password. The verification grant lasts five minutes and can be used once. Successful reset signs out the account's existing online staff sessions.

The sender is **MBBS System <warehouse@mrbininc.com>**, using the existing Gmail SMTP configuration (`BOSS_SMTP_*`). No additional provider setup is required. Account email must be saved by an administrator. Generic request responses avoid confirming whether an account/email combination exists. SMTP acceptance does not guarantee inbox placement.

The server generates codes with `crypto.randomInt`, stores salted scrypt hashes, enforces five wrong guesses per code, rate limits requests/verification in Postgres, and serializes concurrent resets. Passwords retain the existing six-character minimum and have a 256-character maximum. The additive migration is `263_staff_password_reset.sql`.

Verification: `bash tools/boss-test-env.sh start` (only if the isolated environment does not exist), `bash tools/boss-test-env.sh exec node src/migrate.js`, then `bash tools/boss-test-env.sh exec node tools/staff-reset-gauntlet.mjs`. The deployment tool runs all 119 focused tests against the captured candidate source tree before cutover. See the task evidence for recorded versions and known coverage limits.
