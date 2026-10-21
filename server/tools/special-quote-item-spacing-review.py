"""Inspect the generated quote PDFs with the existing PDFium installation."""
import json
from pathlib import Path
import struct
import sys
import zlib

import pypdfium2 as pdfium


def bounds(text, value):
    match = text.search(value).get_next()
    assert match, 'Missing quote text: ' + value
    boxes = [text.get_charbox(i) for i in range(match[0], match[0] + match[1])]
    return [min(b[0] for b in boxes), min(b[1] for b in boxes),
            max(b[2] for b in boxes), max(b[3] for b in boxes)]


def render(page, target):
    bitmap = page.render(scale=1.5, rev_byteorder=True)
    raw = bytes(bitmap.buffer)
    data = b''.join(b'\0' + raw[y * bitmap.stride:y * bitmap.stride + bitmap.width * bitmap.n_channels]
                    for y in range(bitmap.height))

    def chunk(name, body):
        return struct.pack('>I', len(body)) + name + body + struct.pack('>I', zlib.crc32(name + body) & 0xffffffff)

    target.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', bitmap.width,
                       bitmap.height, 8, 2 if bitmap.n_channels == 3 else 6, 0, 0, 0))
                       + chunk(b'IDAT', zlib.compress(data)) + chunk(b'IEND', b''))


def inspect(path, aligned):
    pdf = pdfium.PdfDocument(path)
    page = pdf[0]
    text = page.get_textpage()
    item, amount = bounds(text, 'MBBS-Special'), bounds(text, '$988.00')
    gap = amount[3] - item[3]
    assert (abs(gap) < 2 if aligned else gap > 12), f'Unexpected Item alignment: {gap}'
    assert '建筑材料' in text.get_text_range()
    render(page, path.with_suffix('.png'))
    text.close()
    page.close()
    pages = len(pdf)
    pdf.close()
    return {'file': str(path), 'pages': pages, 'itemToAmountTopDifferencePt': round(gap, 3),
            'aligned': aligned, 'chineseVisible': True}


def main():
    root = Path(__file__).resolve().parents[1] / 'test-artifacts/special-quote-item-spacing'
    if len(sys.argv) > 1:
        result = inspect(Path(sys.argv[1]), True)
        print(json.dumps(result))
        return
    results = []
    for directory, aligned in [('before-pdf', False), ('after-pdf', True)]:
        for name in ['draft-quote.pdf', 'saved-quote.pdf', 'multipage-quote.pdf']:
            results.append(inspect(root / directory / name, aligned))
    for name in ['draft-quote.pdf', 'saved-quote.pdf']:
        before = next(r for r in results if r['file'].endswith('before-pdf/' + name))
        after = next(r for r in results if r['file'].endswith('after-pdf/' + name))
        assert abs(before['itemToAmountTopDifferencePt'] - after['itemToAmountTopDifferencePt'] - 14) < .01
    (root / 'render-review.json').write_text(json.dumps({'passed': True, 'documents': results}, indent=2) + '\n')
    print(json.dumps({'passed': True, 'documents': results}))


if __name__ == '__main__':
    main()
