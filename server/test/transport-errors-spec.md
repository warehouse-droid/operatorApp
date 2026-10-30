# Specific transport validation errors

Authorized by the reported Plan transport save failure and request for a specific
error. The user supplied a 60,000 lb payload rating for 14YD bins.

1. Expected transport validation errors retain their HTTP status, stable code and
   actionable message through the real MBT router. Unexpected errors remain
   redacted by the existing error envelope.
2. Missing bin capacity, missing cargo weight, weight below known ordered cargo,
   and cargo exceeding capacity have distinct explanations. Quantity and stale
   source errors also remain specific. Failed saves leave no trip or source claim.
3. Plan transport shows the calculated weight for selected quantities, the
   selected bin's capacity, and missing-weight/capacity guidance. It keeps the
   submitted quantities and linked delivery selected after a failed save.
4. A 9-yard Crusher Run line weighing 12,150 lb plus a 4-yard HPB line weighing
   5,200 lb shows 17,350 lb. A missing bin payload produces the specific message.
   Once a valid capacity is configured, the same route can be saved with automatic
   weight calculation and its existing linked BIN delivery.
5. Configure only the active 14YD type to the supplied 60,000 lb rating. The schema
   stores whole kilograms: use floor(60000 / 2.2046226218) = 27,215 kg, preserving a
   conservative limit. Record the prior/new values in an operational audit; do
   not save or alter SOB123353 or BIN00005D on the user's behalf.

Use the existing disposable, resource-bounded runner and toolchain. Add no
dependency, preserve unrelated dirty changes, and release a narrow overlay of the
three changed runtime files. Verify real HTTP/browser failure and recovery,
transport regressions, properties, error redaction, lint/types, changed coverage,
and deliberate mutations. Remove all disposable resources and artifacts.
