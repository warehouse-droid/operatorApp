#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
archive="$server_root/test/support/verified-group-actions-source.tar.gz"
verification_root="$(mktemp -d /tmp/group-actions-verified-XXXXXX)"
tar -xzf "$archive" -C "$verification_root"
ln -s "$server_root/test-artifacts" "$verification_root/server/test-artifacts"
python3 - "$verification_root/server" <<'PY'
from pathlib import Path
import hashlib, json, sys
root=Path(sys.argv[1])
for file, expected in json.loads((root/'test/support/verified-group-actions-source.json').read_text()).items():
    assert hashlib.sha256((root/file).read_bytes()).hexdigest()==expected, file
print('Verified exact application/test/tool source:', root)
PY
if [[ "${1:---run}" == --verify-only ]]; then exit; fi
bash "$verification_root/server/tools/link-to-fix-gauntlet.sh"
