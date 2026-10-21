# Completed direct-to-customer transfer receipts

User-authorized scope: keep the TOB01208 → SOA09895 direct link, count the completed
customer delivery locally, reuse its shipped IF157104, and post its missing IR.
Apply the same completion rule to future fully covered direct transfers.
Spec approval: not obtained separately (autonomous run under the user's repair
and deployment instructions). No new dependencies or unrelated SO changes.

Failure model and executable acceptance criteria:

1. A completed linked SO drop, a matching saved direct receipt, and real TO load
   records complete a fully allocated direct TO, including its loaded PALLET
   packaging. Its existing receipt owns exactly one IR job; no yard receipt or
   load is fabricated. Repeat discovery reuses that job.
2. Unallocated material, incomplete dependency allocations, cancelled plans,
   withdrawn Driver evidence, or a receipt from another load cannot complete a
   whole transfer or create an IR job.
3. IR remains waiting until its matching IF quantities are verified completed.
   An existing shipped IF can supply that evidence only after REST and linked
   NetSuite lines verify every local line, item, unit, parent, and quantity.
4. An imported direct receipt with no Operator identity uses a system command
   carrying its saved receipt, actual Driver completion, direct dependency scope,
   and verified IF identity. Ordinary manual submissions still require an
   Operator. PostgreSQL also enforces the system-command boundary.
5. The durable native command and external ID own retries, leases, verification,
   and finalization. An uncertain response cannot create a second IR. The
   existing receipt receives the verified IR evidence and retains its original
   direct-delivery provenance.
6. NetSuite reconciliation after a verified IR updates only the requested TO and
   dependency accounting metadata. The SO link, Driver jobs, dispatch assignment,
   historical completion, packing drafts, and existing physical records remain.

Setup and verification: reuse the repository's bounded, disposable Compose
runner, register teardown before tests, retain logs, and remove test containers,
volumes, and networks. Run the direct-transfer regressions and existing TO,
direct-PO, and native-command regressions against the captured live candidate.
Use targeted mutation checks and record coverage, types, lint, runtime evidence,
and any skipped wider checks honestly. Deploy only an overlay of the captured
live app with an additive constraint migration; preserve the live worker and DB.

Deployment validation added after the first live admission: verify the exact
constraint in the production database and register migration 280 explicitly
before queue admission. Merely copying its SQL file into the image does not
satisfy deployment. A rejected, unsubmitted IR job resumes under its original
identity after this verification; no second job or manual Operator identity is
created. Preserve execution output privately before parsing the result so a
wrapper parsing failure cannot be mistaken for a failed NetSuite submission.
