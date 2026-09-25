"""Render the generated quote PDF with the already-installed PDFium reviewer."""
import json, struct, zlib
from pathlib import Path
import pypdfium2 as pdfium
root = Path(__file__).resolve().parents[1] / 'test-artifacts/field-sales/combined-quotes'
pdf = pdfium.PdfDocument(root / 'combined-quote.pdf')
results = []
for index in range(len(pdf)):
    page = pdf[index]
    bitmap = page.render(scale=1.4, rev_byteorder=True)
    assert bitmap.mode in ('RGB', 'RGBA')
    raw = bytes(bitmap.buffer)
    data = b''.join(b'\0' + raw[y*bitmap.stride:y*bitmap.stride+bitmap.width*bitmap.n_channels] for y in range(bitmap.height))
    def chunk(name, body):
        return struct.pack('>I', len(body)) + name + body + struct.pack('>I', zlib.crc32(name+body) & 0xffffffff)
    output = root / ('combined-page-' + str(index+1) + '.png')
    output.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', bitmap.width, bitmap.height, 8, 2 if bitmap.n_channels == 3 else 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(data)) + chunk(b'IEND', b''))
    results.append({'page': index+1, 'image': output.name, 'text': page.get_textpage().get_text_range()})
(root / 'rendered-pdf.json').write_text(json.dumps(results, indent=2))
print(json.dumps({'pages': len(pdf), 'rendered': True}))
