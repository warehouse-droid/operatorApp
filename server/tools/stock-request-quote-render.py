"""Render generated quotes with the existing PDFium reviewer, without new packages."""
from pathlib import Path
import json
import struct
import zlib
import pypdfium2 as pdfium

root = Path(__file__).resolve().parents[1] / 'test-artifacts/regular-stock-arrival/quote-packing'
results = []
for file in ['saved-quote.pdf', 'multipage-quote.pdf']:
    pdf = pdfium.PdfDocument(root / file)
    for index in ([0] if len(pdf) == 1 else [0, len(pdf) - 1]):
        page = pdf[index]
        bitmap = page.render(scale=1.5, rev_byteorder=True)
        raw = bytes(bitmap.buffer)
        data = b''.join(b'\0' + raw[y*bitmap.stride:y*bitmap.stride+bitmap.width*bitmap.n_channels] for y in range(bitmap.height))

        def chunk(name, body):
            return struct.pack('>I', len(body)) + name + body + struct.pack('>I', zlib.crc32(name+body) & 0xffffffff)

        output = root / (file[:-4] + f'-{index+1}.png')
        output.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', bitmap.width, bitmap.height, 8, 2 if bitmap.n_channels == 3 else 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(data)) + chunk(b'IEND', b''))
        results.append({'file': file, 'page': index+1, 'pages': len(pdf), 'image': str(output), 'text': page.get_textpage().get_text_range()})
(root / 'rendered.json').write_text(json.dumps(results, indent=2) + '\n')
print(json.dumps([{'file': r['file'], 'page': r['page'], 'pages': r['pages']} for r in results]))
