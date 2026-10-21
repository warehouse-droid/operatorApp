"""Read the embedded Unicode maps in this task's NetSuite ticket snapshots."""
import json
from pathlib import Path
import re
import zlib

OUT = Path(__file__).resolve().parents[1] / 'test-artifacts/regular-stock-delivery-conversions'


def ticket_text(path):
    objects = {int(match[1]): match[2] for match in re.finditer(rb'(\d+) 0 obj\s*(.*?)\s*endobj', path.read_bytes(), re.S)}
    def stream(body):
        content = re.search(rb'stream\r?\n(.*?)\r?\nendstream', body, re.S)[1]
        return zlib.decompress(content) if b'/FlateDecode' in body else content
    pages = [body for body in objects.values() if re.search(rb'/Type/Page\b', body)]
    assert len(pages) == 1, 'Expected this task\'s single-page picking ticket'
    page = pages[0]
    fonts = {}
    for name, ref in re.findall(rb'/(R\d+) (\d+) 0 R', page):
        font = objects[int(ref)]
        unicode_ref = re.search(rb'/ToUnicode (\d+) 0 R', font)
        if not unicode_ref:
            continue
        cmap = stream(objects[int(unicode_ref[1])])
        mapping = {}
        for block in re.findall(rb'beginbfrange(.*?)endbfrange', cmap, re.S):
            for first, last, dest in re.findall(rb'<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*<([0-9a-f]+)>', block):
                first, last, dest = int(first, 16), int(last, 16), int(dest, 16)
                for code in range(first, last + 1):
                    mapping[code] = chr(dest + code - first)
        for block in re.findall(rb'beginbfchar(.*?)endbfchar', cmap, re.S):
            for code, dest in re.findall(rb'<([0-9a-f]+)>\s*<([0-9a-f]+)>', block):
                mapping[int(code, 16)] = bytes.fromhex(dest.decode()).decode('utf-16-be')
        fonts[name] = mapping
    contents = re.search(rb'/Contents\[(.*?)\]', page)[1]
    runs = []
    for ref in re.findall(rb'(\d+) 0 R', contents):
        active = None
        x, y = 0, 0
        for match in re.finditer(rb'/(R\d+) [-\d.]+ Tf|\[([^\]]*)\]TJ|([-\d.]+) ([-\d.]+) Td|(BT)\b', stream(objects[int(ref)])):
            if match[1]:
                active = match[1]
                continue
            if match[3]:
                x, y = x + float(match[3]), y + float(match[4])
                continue
            if match[5]:
                x, y = 0, 0
                continue
            assert active in fonts
            value = ''
            for hex_value in re.findall(rb'<([0-9a-fA-F]+)>', match[2]):
                raw = bytes.fromhex(hex_value.decode())
                assert len(raw) % 2 == 0
                value += ''.join(fonts[active][int.from_bytes(raw[index:index + 2], 'big')] for index in range(0, len(raw), 2))
            runs.append({'text': value.strip(), 'x': round(x, 4), 'y': round(y, 4)})
    return runs


proof = {}
for kind in ['original', 'corrected']:
    path = OUT / ('TOB01183-' + kind + '-ticket.pdf')
    runs = ticket_text(path)
    assert any('TOB01183' in value['text'] for value in runs)
    index = next(index for index, value in enumerate(runs) if value['text'] == 'BWS-PW-REG-GM')
    row = runs[index:index + 5]
    assert [value['text'] for value in row[2:5]] == ['160', 'PC', '160'], row
    # The ticket's printed column order is PLT, SEC, LYR, PCS.
    headers = {value['text']: value['x'] for value in runs if value['text'] in ['PLT', 'SEC', 'LYR', 'PCS']}
    assert len(headers) == 4
    columns = dict.fromkeys(headers, 0)
    for value in runs:
        if abs(value['y'] - row[0]['y']) <= 5 and value['x'] > 436:
            label = min(headers, key=lambda key: abs(headers[key] - value['x']))
            columns[label] = float(value['text'])
    assert columns == ({'PLT': 0, 'SEC': 0, 'LYR': 0, 'PCS': 0} if kind == 'original' else {'PLT': 2, 'SEC': 0, 'LYR': 0, 'PCS': 40}), columns
    (OUT / ('TOB01183-' + kind + '-ticket-text.json')).write_text(json.dumps(runs, indent=2) + '\n')
    proof[kind] = {'filename': path.name, 'material': 'BWS-PW-REG-GM', 'quantity': 160, 'columns': columns}
(OUT / 'ticket-verification.json').write_text(json.dumps(proof, indent=2) + '\n')
print(json.dumps(proof))
