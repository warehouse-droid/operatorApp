"""Review only the captured feature delta; never print environment or credential files."""
import json
import re
from pathlib import Path

server = Path(__file__).resolve().parents[1]
root = server / "test-artifacts/bin-order-workflow-20261020/browser-artifacts"
patch = (root / "workflow-runtime.diff").read_text()
added = "\n".join(line[1:] for line in patch.splitlines() if line.startswith("+") and not line.startswith("+++"))
patterns = {
    "private-key": r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
    "aws-access-key": r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b",
    "github-token": r"\bgh[pousr]_[A-Za-z0-9]{30,}\b",
    "literal-secret": r"(?:client_secret|api_secret|password)\s*[:=]\s*['\"][^'\"]{16,}['\"]",
}
findings = [name for name, pattern in patterns.items() if re.search(pattern, added, re.IGNORECASE)]
capabilities = {
    "dependenciesAdded": [],
    "externalNetworkDestinationsAdded": [],
    "runtimeFilesystemOrSubprocessAdded": [],
    "runtimeEnvironmentVariablesAdded": [],
    "internalEndpointsAdded": [
        "GET /api/mbt/planning/workflows/:visitId",
        "POST /api/mbt/planning/workflows/:visitId",
        "POST /api/mbt/planning/workflows/:visitId/handoffs",
    ],
    "access": "Existing dispatcher/admin authorization, capability gates and authenticated server actor; mutations require idempotency keys.",
    "databaseChanges": "Additive migration 297; new rental identities, order parts, dependencies, claims and audit events.",
    "secretPatternFindings": findings,
    "reviewMethod": "Pattern scan of added lines plus manual inspection of imports, handlers and migration.",
}
(root / "workflow-capabilities.json").write_text(json.dumps(capabilities, indent=2) + "\n")
print(json.dumps({"secretPatternFindings": findings, "runtimeDependenciesAdded": 0}))
if findings:
    raise SystemExit(1)
