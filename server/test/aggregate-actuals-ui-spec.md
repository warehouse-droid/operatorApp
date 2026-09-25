# Aggregate actual-report follow-up

User-confirmed timing on 2026-09-22: actual reporting becomes available immediately after SCM confirms. This supersedes the admission-date restriction in earlier Aggregate specifications. The existing report due date remains a reminder/overdue date; no schema or operational data migration is required.

- Requester and SCM can submit actual loads as soon as confirmation exists, including before the delivery or report due date. Existing ownership, separate yard access, revision, retry, load validation and confirmed-status checks still apply.
- Each of the seven actual-load inputs starts at 0. An input cleared by the user remains invalid until a number is entered.
- Actual-report material and yard cards use a distinct blue background. Each material name and its square SCM-confirmed quantity badge share a row, with the badge on the right and the count in large type. Labels remain English/Chinese, and language changes preserve entered quantities.
- The existing eight-card layout, request/edit stages, next-request workflow and SCM review of differences remain intact.
- Verify with existing domain/property, real HTTP/database and desktop/mobile browser checks. Capture a failing timing regression before removing the restriction. Deploy only this follow-up's patch over the current live image, with asset versions, source hashes, preflight and rollback checks.
