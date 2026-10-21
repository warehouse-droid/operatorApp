"""Scan task additions; never print the value of a potential secret."""
import json,re
from pathlib import Path

root=Path(__file__).resolve().parents[1]
patterns=[r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',r'AKIA[A-Z0-9]{16}',
          r'gh[pousr]_[A-Za-z0-9]{30,}',r'sk-(?:proj-)?[A-Za-z0-9_-]{30,}',
          r'(?i)(?:client_secret|access_token|api_key|password)\s*[:=]\s*[\"\'][^\"\']{16,}[\"\']']
findings=[];file='';number=0
for line in (root/'test/regular-stock-v2.changes.patch').read_text().splitlines():
    if line.startswith('+++ b/'):
        file=line[6:];continue
    hunk=re.match(r'^@@ .* \+(\d+)',line)
    if hunk:
        number=int(hunk[1]);continue
    if line.startswith('+'):
        if any(re.search(pattern,line[1:]) for pattern in patterns):findings.append(f'{file}:{number}')
        number+=1
    elif line.startswith(' '):number+=1
out=root/'test-artifacts/regular-stock-v2/secrets.json'
out.write_text(json.dumps({'findings':findings,'scope':'task runtime additions'},indent=2)+'\n')
print(json.dumps({'secretFindings':len(findings)}))
if findings:raise SystemExit(1)
