"""Check and render the saved MBBS template sample with the existing PDFium tool."""
import json, struct, zlib
from pathlib import Path
import pypdfium2 as pdfium

root = Path(__file__).resolve().parents[1] / 'test-artifacts/field-sales/customer-links'
pdf = pdfium.PdfDocument(root / 'mbbs-settings-preview.pdf')
assert len(pdf) == 1
page = pdf[0]
text = page.get_textpage().get_text_range()
for value in ['Mr Bin Building Supply LTD', '3445 Kennedy Road', 'Toronto ON M1V 4Y3', '(416) 912-9555', '719366486', '$50.00', '$6.50', '$56.50']:
    assert value in text, 'Missing PDF value: ' + value
bitmap = page.render(scale=1.4, rev_byteorder=True)
assert bitmap.mode in ('RGB', 'RGBA')
raw = bytes(bitmap.buffer)
data = b''.join(b'\0' + raw[y*bitmap.stride:y*bitmap.stride+bitmap.width*bitmap.n_channels] for y in range(bitmap.height))
def chunk(name, body):
    return struct.pack('>I', len(body)) + name + body + struct.pack('>I', zlib.crc32(name+body) & 0xffffffff)
(root / 'mbbs-settings-preview.png').write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', bitmap.width, bitmap.height, 8, 2 if bitmap.n_channels == 3 else 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(data)) + chunk(b'IEND', b''))
report = {'passed': True, 'pages': 1, 'companyHeaderVerified': True, 'sampleTotalVerified': True, 'text': text}
(root / 'mbbs-settings-pdf.json').write_text(json.dumps(report, indent=2))
print(json.dumps({k: v for k, v in report.items() if k != 'text'}))
