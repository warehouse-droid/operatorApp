"""Verify the emitted discount row and render an actual quote for review."""
import importlib.util
import json
from pathlib import Path
import sys

import pypdfium2 as pdfium

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('quote_layout', SERVER / 'tools/special-quote-item-spacing-review.py')
layout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(layout)


def inspect(path, boundary=False):
    pdf = pdfium.PdfDocument(path)
    index = len(pdf) - 1 if boundary else 0
    page = pdf[index]
    text = page.get_textpage()
    label = 'Total Discount (1.11%)' if boundary else 'Total Discount (5%)'
    amount = '$10.00' if boundary else '$52.00'
    discount = layout.bounds(text, label)
    value = layout.bounds(text, amount)
    subtotal = layout.bounds(text, 'Subtotal')
    total = layout.bounds(text, 'Total CAD')
    assert discount[1] > subtotal[3], 'Discount must be above Subtotal'
    assert discount[3] - discount[1] < 13, 'Discount label wrapped'
    assert abs(discount[3] - value[3]) < 2, 'Discount amount is not aligned with its label'
    assert total[1] > 792 - 675, 'Totals overlap the footer region'
    if boundary:
        assert len(pdf) == 2 and index == 1, 'Boundary totals must move to a second page'
    else:
        assert len(pdf) == 1
        assert '建筑材料' in text.get_text_range()
        item, line_amount = layout.bounds(text, 'MBBS-Special'), layout.bounds(text, '$988.00')
        assert abs(item[3] - line_amount[3]) < 2, 'The Item column regained its empty line'
    layout.render(page, path.with_suffix('.png'))
    result = {'file': str(path), 'pages': len(pdf), 'page': index + 1, 'discount': label,
              'amount': amount, 'beforeSubtotal': True, 'singleLineLabel': True, 'totalsAboveFooter': True}
    text.close()
    page.close()
    pdf.close()
    return result


def main():
    if len(sys.argv) > 1:
        print(json.dumps(inspect(Path(sys.argv[1]))))
        return
    root = SERVER / 'test-artifacts/special-quote-discount-summary'
    results = [inspect(root / 'pdf' / name) for name in ['draft-quote.pdf', 'saved-quote.pdf']]
    results.append(inspect(root / 'pdf/boundary-quote.pdf', boundary=True))
    result = {'passed': True, 'documents': results}
    (root / 'render-review.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
