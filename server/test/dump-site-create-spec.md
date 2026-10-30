# Dump-site creation fix — 2026-10-23

Reported input: code `3445`; creation returns “The dump-site row is invalid.”
Spec approval: not obtained (autonomous run); the user requested the fix and
confirmed the failing code. No dependencies, database migrations, or commits.

1. An Admin can create a dump site with code `3445` from the actual configuration
   form, with selected dump items and opening hours persisted and listed.
2. Codes may start with a letter or number and contain letters, numbers,
   underscores, or hyphens (maximum 64 characters). Trim and uppercase codes;
   keep the same identity through edit, activation, deletion, and CSV validation.
3. Unsupported code characters and invalid opening intervals get useful errors.
   The form retains entered values after rejection and can be corrected/retried.
4. Preserve Admin authorization, revision checks, accepted-item requirements,
   atomic persistence, and all existing unrelated configuration behavior.

Validation: reproduce the failure before editing runtime code, exercise the real
browser/server/database flow in the bounded disposable runner, run affected
configuration/import regressions and static checks, then deploy a narrow overlay
over the captured live source. Never create test dump sites in production.
