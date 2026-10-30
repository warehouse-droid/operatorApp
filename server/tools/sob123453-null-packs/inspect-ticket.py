"""Read the real BFO PDF text/cell coordinates using its embedded Unicode maps."""
import hashlib
import json
from pathlib import Path
import re
import sys
import zlib

pdf = Path(sys.argv[1]).read_bytes()
assert pdf.startswith(b'%PDF-')
objects = {int(m[1]): m[2] for m in re.finditer(rb'(\d+)\s+0\s+obj\s*([\s\S]*?)endobj', pdf)}


def stream(obj):
    match = re.search(rb'stream\r?\n', obj)
    if not match:
        return b''
    length = re.search(rb'/Length\s+(\d+)(\s+0\s+R)?', obj[:match.start()])
    assert length, 'Stream length is required'
    size = int(objects[int(length[1])].strip()) if length[2] else int(length[1])
    data = obj[match.end():match.end() + size]
    return zlib.decompress(data) if b'/FlateDecode' in obj[:match.start()] else data


maps = {}
for number, obj in objects.items():
    reference = re.search(rb'/ToUnicode\s+(\d+)\s+0\s+R', obj)
    if not reference:
        continue
    cmap = stream(objects[int(reference[1])])
    mapping = {}
    for block in re.findall(rb'beginbfchar([\s\S]*?)endbfchar', cmap):
        for key, value in re.findall(rb'<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>', block):
            mapping[int(key, 16)] = bytes.fromhex(value.decode()).decode('utf-16-be')
    for block in re.findall(rb'beginbfrange([\s\S]*?)endbfrange', cmap):
        for match in re.finditer(rb'<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<([0-9a-fA-F]+)>|\[([^\]]+)\])', block):
            start, end = int(match[1], 16), int(match[2], 16)
            if match[4]:
                base = int(match[4], 16)
                for key in range(start, end + 1):
                    mapping[key] = (base + key - start).to_bytes(len(match[4]) // 2, 'big').decode('utf-16-be')
            else:
                for key, value in enumerate(re.findall(rb'<([0-9a-fA-F]+)>', match[5]), start):
                    mapping[key] = bytes.fromhex(value.decode()).decode('utf-16-be')
    maps[number] = mapping

fonts = {name.decode(): maps.get(int(number), {}) for obj in objects.values()
         for name, number in re.findall(rb'/(R\d+)\s+(\d+)\s+0\s+R', obj) if int(number) in maps}
runs = []
pattern = re.compile(rb'(?P<bt>\bBT\b)|/(?P<font>R\d+)\s+[\d.]+\s+Tf|(?P<x>-?[\d.]+)\s+(?P<y>-?[\d.]+)\s+Td|\[(?P<tj>[^\]]*)\]\s*TJ')
for obj in objects.values():
    content = stream(obj)
    if not re.search(rb'\bBT\s', content) or b'TJ' not in content:
        continue
    x = y = 0
    font = None
    for match in pattern.finditer(content):
        if match['bt']:
            x = y = 0
        elif match['font']:
            font = match['font'].decode()
        elif match['x']:
            x += float(match['x'])
            y += float(match['y'])
        else:
            parts = []
            for token in re.finditer(rb'<([0-9a-fA-F]+)>|\(([^()]*)\)', match['tj']):
                if token[1]:
                    hex_value = token[1].decode()
                    mapping = fonts.get(font, {})
                    parts.append(''.join(mapping.get(int(hex_value[i:i+4], 16), '\ufffd') for i in range(0, len(hex_value), 4)))
                else:
                    parts.append(token[2].decode('latin1'))
            text = ''.join(parts).strip()
            if text:
                runs.append({'x': round(x, 3), 'y': round(y, 3), 'text': text})

assert any('SOB123453' in row['text'] for row in runs), 'Wrong or unreadable picking ticket'
headers = {row['text']: row for row in runs if row['text'] in ['PLT', 'SEC', 'LYR', 'PCS']}
assert len(headers) == 4, headers
rows = [row for row in runs if row['text'] == 'MBBS-Special Order']
assert len(rows) == 5, rows
cells = []
for index, row in enumerate(rows):
    values = dict.fromkeys(['PLT', 'SEC', 'LYR', 'PCS'], '')
    for cell in runs:
        if 436 <= cell['x'] <= 576 and row['y'] - 12 <= cell['y'] <= row['y'] + 3:
            column = min(headers, key=lambda key: abs(headers[key]['x'] - cell['x']))
            assert not values[column], 'Duplicate cell'
            values[column] = cell['text']
    cells.append({'row': index + 1, **values})
zero_count = sum(row[col] == '0' for row in cells for col in headers)
expected = 16 if sys.argv[2] == 'before' else 0
assert zero_count == expected, cells
expected_rows = [['', '', '4', ''], ['1', '', '', ''], ['2', '', '', ''], ['1', '', '', ''], ['', '', '', '']]
if sys.argv[2] == 'after':
    assert [[row[col] for col in ['PLT', 'SEC', 'LYR', 'PCS']] for row in cells] == expected_rows, cells
report = {'order': 'SOB123453', 'phase': sys.argv[2], 'pdfSha256': hashlib.sha256(pdf).hexdigest(),
          'pdfBytes': len(pdf), 'printedZeroPackFields': zero_count, 'rows': cells}
if len(sys.argv) > 3:
    Path(sys.argv[3]).write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report))
