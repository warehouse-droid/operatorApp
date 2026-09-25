# Aggregate actual-report follow-up evidence

Deployed on 2026-09-22T15:25:35.923918+00:00 to `https://test.mbbsoperation.com`.

- User confirmed that actual reporting opens immediately after SCM confirms. Removed the requester, SCM and server date locks. Due/overdue dates remain unchanged.
- Actual inputs default to zero; cleared inputs still require a valid whole number. Blue actual-report cards contain a square SCM quantity badge beside each material label, with translated captions and large counts.
- 57 focused Aggregate tests pass both in the workspace and against the exact release candidate. Includes domain/property, real HTTP/database, access/revocation, retries, concurrency, requester/SCM workflows, English/Chinese, mobile/desktop geometry and accessibility.
- Two timing regressions failed before the date-lock removal. Restoring the previous lock with the updated mutation also produces both failures.
- Syntax, lint and domain types pass. Screenshots reviewed for desktop English and mobile English/Chinese. This focused follow-up did not rerun the full repository suite; its prior known failures remain outside scope.
- Seven runtime files patched over the live v3 image. No database migration or operational-data updates. Zero active postings/fulfillments/Dispatch leases before cutover. Configuration and other services unchanged; rollback image retained.
- Live local/public health and pages returned 200, all four protected APIs returned 401 without credentials, and all six changed public assets matched their expected hashes. Seven runtime file hashes verified.

Image: `mbbs-operator-app:aggregate-actuals-20260922-v4`
Image ID: `sha256:7ac391ea6c88341a44da6e1509ee868dd62a7fdebc87752f9db535c1ea2c5500`

Artifacts: `server/test-artifacts/aggregate-actuals-ui/` and `server/test-artifacts/aggregate-actuals-deployment-20260922/`.
