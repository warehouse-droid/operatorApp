"""Package the user-requested NetSuite upload files without publishing them."""
import hashlib
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

server = Path(__file__).resolve().parents[1]
destination = server / "test-artifacts/delivery-estb-quote-20261014/upload"
destination.mkdir(parents=True, exist_ok=True)
files = {
    "netsuite-smart-scm-picking-ticket-restlet.js": server / "netsuite-smart-scm-picking-ticket-restlet.js",
    "netsuite-transaction-pdf-suitelet.js": server / "netsuite-transaction-pdf-suitelet.js",
    "README.md": server / "docs/netsuite-quotation-pdf-upload.md",
}
hashes = {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in files.items()}
checksums = "".join(f"{digest}  {name}\n" for name, digest in hashes.items())
target = destination / "netsuite-quotation-pdf-scripts.zip"
with ZipFile(target, "w", ZIP_DEFLATED) as bundle:
    for name, path in files.items():
        bundle.write(path, name)
    bundle.writestr("SHA256SUMS.txt", checksums)
manifest = {
    "archive": str(target),
    "archiveSha256": hashlib.sha256(target.read_bytes()).hexdigest(),
    "files": hashes,
    "restletVersion": "3.4.0",
    "suiteletVersion": "1.0.0",
    "uploadedToNetSuite": False,
}
(destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(json.dumps(manifest, indent=2))
