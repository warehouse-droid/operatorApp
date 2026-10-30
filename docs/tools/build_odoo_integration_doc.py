#!/usr/bin/env python3
"""Build/check the Odoo handoff DOCX with only the Python standard library.

Supported Markdown is deliberately small: headings, paragraphs, flat lists,
pipe tables, fenced code, inline code/emphasis, and links. Unsupported input
fails instead of disappearing. No network access or application imports.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree as ET
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "docs" / "odoo-api-webhook-integration.md"
DESTINATION = SOURCE.with_suffix(".docx")
LANGUAGE = "en-CA"
BODY_FONT = "Calibri"
EAST_ASIA_FONT = "Calibri"
CODE_FONT = "Consolas"
NS = {
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "pr": "http://schemas.openxmlformats.org/package/2006/relationships",
    "ct": "http://schemas.openxmlformats.org/package/2006/content-types",
    "cp": "http://schemas.openxmlformats.org/package/2006/metadata/core-properties",
    "dc": "http://purl.org/dc/elements/1.1/",
    "dcterms": "http://purl.org/dc/terms/",
    "xsi": "http://www.w3.org/2001/XMLSchema-instance",
}
for prefix, uri in NS.items():
    ET.register_namespace(prefix, uri)

LINK = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")
INLINE = re.compile(r"\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*")


def element(name: str, attrs: dict[str, str] | None = None, text: str | None = None):
    prefix, local = name.split(":", 1)
    node = ET.Element(f"{{{NS[prefix]}}}{local}")
    for key, value in (attrs or {}).items():
        if ":" in key:
            pfx, attr = key.split(":", 1)
            node.set(f"{{{NS[pfx]}}}{attr}", str(value))
        else:
            node.set(key, str(value))
    node.text = text
    return node


def xml(node) -> bytes:
    return ET.tostring(node, encoding="utf-8", xml_declaration=True)


def package_xml(node, prefix: str) -> bytes:
    # Use conventional default namespaces for OPC packaging. Some document
    # importers do not recognize prefixed Content_Types/Relationships roots.
    ET.register_namespace("", NS[prefix])
    try:
        return xml(node)
    finally:
        ET.register_namespace(prefix, NS[prefix])


@dataclass
class Block:
    kind: str
    text: str = ""
    level: int = 0
    rows: list[list[str]] | None = None
    language: str = ""


def table_row(line: str) -> list[str]:
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def parse_markdown(content: str) -> list[Block]:
    lines = content.splitlines()
    blocks: list[Block] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        if not line.strip():
            index += 1
            continue
        if line.startswith("```"):
            language = line[3:].strip()
            index += 1
            code = []
            while index < len(lines) and lines[index] != "```":
                code.append(lines[index])
                index += 1
            if index == len(lines):
                raise ValueError("Unclosed fenced code block")
            blocks.append(Block("code", "\n".join(code), language=language))
            index += 1
            continue
        heading = re.match(r"^(#{1,3}) (.+)$", line)
        if heading:
            blocks.append(Block("heading", heading.group(2), level=len(heading.group(1))))
            index += 1
            continue
        if line.startswith("|"):
            rows = [table_row(line)]
            index += 1
            if index >= len(lines) or not all(
                re.fullmatch(r":?-{3,}:?", cell) for cell in table_row(lines[index])
            ):
                raise ValueError("Table missing separator row")
            index += 1
            while index < len(lines) and lines[index].startswith("|"):
                row = table_row(lines[index])
                if len(row) != len(rows[0]):
                    raise ValueError(f"Inconsistent table column count: {row}")
                rows.append(row)
                index += 1
            blocks.append(Block("table", rows=rows))
            continue
        if line.startswith("- "):
            blocks.append(Block("bullet", line[2:]))
            index += 1
            continue
        if re.match(r"^\d+\. ", line):
            blocks.append(Block("number", line))
            index += 1
            continue
        paragraph = [line]
        index += 1
        while index < len(lines) and lines[index].strip():
            if re.match(r"^(#|\||```|- |\d+\. )", lines[index]):
                break
            paragraph.append(lines[index])
            index += 1
        value = " ".join(part.strip() for part in paragraph)
        if value.startswith((">", "<", "![", "    ")):
            raise ValueError(f"Unsupported Markdown block: {value[:80]}")
        blocks.append(Block("paragraph", value))
    return blocks


def validate_source(blocks: list[Block], content: str):
    headings = [block for block in blocks if block.kind == "heading"]
    if len([b for b in headings if b.level == 1]) != 1:
        raise ValueError("Expected exactly one document title")
    major_numbers = [int(re.match(r"(\d+)\.", b.text).group(1))
                     for b in headings if b.level == 2]
    if major_numbers != list(range(1, 19)):
        raise ValueError("Expected sequential sections 1 through 18")
    json_count = 0
    for block in blocks:
        if block.kind == "code" and block.language == "json":
            def no_duplicate_keys(pairs):
                result = {}
                for key, value in pairs:
                    if key in result:
                        raise ValueError(f"Duplicate JSON key: {key}")
                    result[key] = value
                return result
            json.loads(block.text, object_pairs_hook=no_duplicate_keys)
            json_count += 1
    for match in LINK.finditer(content):
        url = match.group(2)
        if url.startswith(("https://", "http://", "#")):
            continue
        target = (SOURCE.parent / unquote(urlsplit(url).path)).resolve()
        if not target.is_relative_to(ROOT) or not target.is_file():
            raise ValueError(f"Missing/unsafe local source reference: {url}")
    if json_count < 10:
        raise ValueError("Expected at least ten worked JSON examples")
    acceptance_ids = re.findall(r"^\| (A\d\d) \|", content, re.MULTILINE)
    if acceptance_ids != [f"A{i:02d}" for i in range(1, 31)]:
        raise ValueError("Acceptance scenario IDs must run from A01 to A30")
    return json_count


class WordDocument:
    def __init__(self):
        self.root = element("w:document")
        self.body = ET.SubElement(self.root, f"{{{NS['w']}}}body")
        self.relationships = element("pr:Relationships")
        self.hyperlinks: dict[str, str] = {}
        self.bookmark_id = 0
        for rid, kind, target in [
            ("rIdStyles", "styles", "styles.xml"),
            ("rIdSettings", "settings", "settings.xml"),
            ("rIdHeader", "header", "header1.xml"),
            ("rIdFooter", "footer", "footer1.xml"),
        ]:
            self.relationships.append(element("pr:Relationship", {
                "Id": rid, "Type": NS["r"] + "/" + kind, "Target": target,
            }))

    def relationship(self, url: str) -> str:
        if url not in self.hyperlinks:
            rid = f"rIdLink{len(self.hyperlinks) + 1}"
            self.hyperlinks[url] = rid
            self.relationships.append(element("pr:Relationship", {
                "Id": rid, "Type": NS["r"] + "/hyperlink",
                "Target": url, "TargetMode": "External",
            }))
        return self.hyperlinks[url]

    @staticmethod
    def run(text: str, code=False, bold=False, link=False):
        run = element("w:r")
        properties = element("w:rPr")
        if code:
            properties.append(element("w:rFonts", {"w:ascii": CODE_FONT, "w:hAnsi": CODE_FONT}))
            properties.append(element("w:sz", {"w:val": "17"}))
        if bold:
            properties.append(element("w:b"))
        if link:
            properties.append(element("w:color", {"w:val": "126B73"}))
            properties.append(element("w:u", {"w:val": "single"}))
        if len(properties):
            run.append(properties)
        value = element("w:t", text=text)
        value.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
        run.append(value)
        return run

    def inline(self, paragraph, value: str):
        offset = 0
        for match in INLINE.finditer(value):
            if match.start() > offset:
                paragraph.append(self.run(value[offset:match.start()]))
            if match.group(1):
                url = match.group(2)
                # Relative repository references remain understandable in a
                # standalone Word handoff rather than becoming broken links.
                if url.startswith(("https://", "http://")):
                    link = element("w:hyperlink", {"r:id": self.relationship(url)})
                    link.append(self.run(match.group(1), link=True))
                    paragraph.append(link)
                else:
                    paragraph.append(self.run(match.group(1), bold=True))
                    paragraph.append(self.run(f" ({url})", code=True))
            elif match.group(3):
                paragraph.append(self.run(match.group(3), code=True))
            else:
                paragraph.append(self.run(match.group(4), bold=True))
            offset = match.end()
        if offset < len(value):
            paragraph.append(self.run(value[offset:]))

    def paragraph(self, value="", style="Normal", parent=None, raw=False, break_before=False):
        parent = self.body if parent is None else parent
        paragraph = element("w:p")
        props = element("w:pPr")
        props.append(element("w:pStyle", {"w:val": style}))
        if break_before:
            props.append(element("w:pageBreakBefore"))
        paragraph.append(props)
        if raw:
            paragraph.append(self.run(value))
        else:
            self.inline(paragraph, value)
        parent.append(paragraph)
        return paragraph

    def navigation(self, blocks: list[Block]):
        container = element("w:sdt")
        props = element("w:sdtPr")
        props.append(element("w:tag", {"w:val": "generated-navigation"}))
        container.append(props)
        content = element("w:sdtContent")
        container.append(content)
        self.paragraph("目录" if LANGUAGE == "zh-CN" else "Contents",
                       "Heading1", parent=content, break_before=True)
        for block in blocks:
            if block.kind != "heading" or block.level != 2:
                continue
            num = re.match(r"\d+", block.text).group()
            para = self.paragraph(style="Navigation", parent=content)
            link = element("w:hyperlink", {"w:anchor": f"section_{num}"})
            link.append(self.run(block.text, link=True))
            para.append(link)
        self.body.append(container)

    def table(self, rows: list[list[str]]):
        table = element("w:tbl")
        props = element("w:tblPr")
        props.append(element("w:tblW", {"w:w": "10080", "w:type": "dxa"}))
        props.append(element("w:tblLayout", {"w:type": "fixed"}))
        borders = element("w:tblBorders")
        for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
            borders.append(element(f"w:{edge}", {"w:val": "single", "w:sz": "4", "w:color": "D9E3E9"}))
        props.append(borders)
        margins = element("w:tblCellMar")
        for edge in ("top", "left", "bottom", "right"):
            margins.append(element(f"w:{edge}", {"w:w": "85", "w:type": "dxa"}))
        props.append(margins)
        table.append(props)
        width_choices = {2: [3300, 6780], 3: [2750, 3350, 3980], 4: [1600, 2750, 2750, 2980]}
        widths = width_choices[len(rows[0])]
        if rows[0][0] in ("ID", "HTTP status"):
            widths = [850, 3900, 5330]
        elif rows[0][0] == "HTTP 状态":
            widths = [1600, 3500, 4980]
        elif rows[0][0] == "方法与路径":
            widths = [4800, 850, 4430]
        grid = element("w:tblGrid")
        for width in widths:
            grid.append(element("w:gridCol", {"w:w": str(width)}))
        table.append(grid)
        for row_index, values in enumerate(rows):
            row = element("w:tr")
            row_props = element("w:trPr")
            row_props.append(element("w:cantSplit"))
            if row_index == 0:
                row_props.append(element("w:tblHeader"))
            row.append(row_props)
            for index, value in enumerate(values):
                cell = element("w:tc")
                cell_props = element("w:tcPr")
                cell_props.append(element("w:tcW", {"w:w": str(widths[index]), "w:type": "dxa"}))
                cell_props.append(element("w:vAlign", {"w:val": "top"}))
                color = "17364D" if row_index == 0 else ("F3F7F9" if row_index % 2 else "FFFFFF")
                cell_props.append(element("w:shd", {"w:fill": color, "w:val": "clear"}))
                cell.append(cell_props)
                self.paragraph(value, "TableHeader" if row_index == 0 else "TableText", parent=cell)
                row.append(cell)
            table.append(row)
        self.body.append(table)
        self.paragraph(style="TableSpacer")

    def build(self, blocks: list[Block]):
        navigation_added = False
        for block in blocks:
            if block.kind == "heading":
                is_major = block.level == 2
                if is_major and not navigation_added:
                    self.navigation(blocks)
                    navigation_added = True
                number = int(re.match(r"\d+", block.text).group()) if is_major else None
                para = self.paragraph(block.text, {1: "Title", 2: "Heading1", 3: "Heading2"}[block.level],
                                      break_before=number in (1, 6, 8, 10, 14, 18))
                if is_major:
                    self.bookmark_id += 1
                    start = element("w:bookmarkStart", {"w:id": str(self.bookmark_id), "w:name": f"section_{number}"})
                    para.insert(1, start)
                    para.append(element("w:bookmarkEnd", {"w:id": str(self.bookmark_id)}))
            elif block.kind == "table":
                self.table(block.rows)
            elif block.kind == "code":
                for line in block.text.split("\n"):
                    self.paragraph(line, "Code", raw=True)
                self.paragraph(style="TableSpacer")
            elif block.kind == "bullet":
                self.paragraph("• " + block.text, "ListText")
            elif block.kind == "number":
                self.paragraph(block.text, "ListText")
            else:
                style = "Subtitle" if block.text.startswith(("Version:", "版本：")) else "Normal"
                self.paragraph(block.text, style)
        section = element("w:sectPr")
        section.append(element("w:headerReference", {"w:type": "default", "r:id": "rIdHeader"}))
        section.append(element("w:footerReference", {"w:type": "default", "r:id": "rIdFooter"}))
        section.append(element("w:pgSz", {"w:w": "12240", "w:h": "15840"}))
        section.append(element("w:pgMar", {"w:top": "1008", "w:right": "1080", "w:bottom": "1008",
                                           "w:left": "1080", "w:header": "450", "w:footer": "450", "w:gutter": "0"}))
        self.body.append(section)


def styles():
    root = element("w:styles")
    defaults = element("w:docDefaults")
    default_run = element("w:rPrDefault")
    props = element("w:rPr")
    props.append(element("w:rFonts", {"w:ascii": BODY_FONT, "w:hAnsi": BODY_FONT,
                                      "w:eastAsia": EAST_ASIA_FONT}))
    props.append(element("w:sz", {"w:val": "21"}))
    props.append(element("w:lang", {"w:val": LANGUAGE, "w:eastAsia": LANGUAGE}))
    default_run.append(props)
    defaults.append(default_run)
    root.append(defaults)
    definitions = [
        ("Normal", "Normal", 21, "263746", 120, False),
        ("Title", "Title", 42 if LANGUAGE == "zh-CN" else 46, "17364D", 220, True),
        ("Subtitle", "Subtitle", 20, "126B73", 180, False),
        ("Heading1", "heading 1", 30, "17364D", 160, True),
        ("Heading2", "heading 2", 24, "126B73", 120, True),
        ("TableText", "Table Text", 18, "263746", 40, False),
        ("TableHeader", "Table Header", 18, "FFFFFF", 40, True),
        ("Code", "Code", 16, "233645", 0, False),
        ("ListText", "List Text", 21, "263746", 100, False),
        ("TableSpacer", "Table Spacer", 4, "263746", 30, False),
        ("Navigation", "Navigation", 22, "126B73", 130, False),
        ("HeaderFooter", "Header and Footer", 17, "647789", 0, False),
    ]
    for sid, name, size, color, after, bold in definitions:
        attrs = {"w:type": "paragraph", "w:styleId": sid}
        if sid == "Normal":
            attrs["w:default"] = "1"
        style = element("w:style", attrs)
        style.append(element("w:name", {"w:val": name}))
        if sid != "Normal":
            style.append(element("w:basedOn", {"w:val": "Normal"}))
        pp = element("w:pPr")
        pp.append(element("w:spacing", {"w:after": str(after), "w:line": "260", "w:lineRule": "auto"}))
        pp.append(element("w:widowControl"))
        if sid in ("Title", "Heading1", "Heading2"):
            pp.append(element("w:keepNext"))
            pp.append(element("w:keepLines"))
            if sid != "Title":
                pp.append(element("w:outlineLvl", {"w:val": "0" if sid == "Heading1" else "1"}))
                pp.find(f"{{{NS['w']}}}spacing").set(f"{{{NS['w']}}}before", "220")
        if sid == "Code":
            pp.append(element("w:shd", {"w:val": "clear", "w:fill": "F3F6F8"}))
            pp.append(element("w:ind", {"w:left": "130", "w:right": "130"}))
            pp.find(f"{{{NS['w']}}}spacing").set(f"{{{NS['w']}}}line", "220")
        if sid == "ListText":
            pp.append(element("w:ind", {"w:left": "260", "w:hanging": "260"}))
        style.append(pp)
        rp = element("w:rPr")
        rp.append(element("w:sz", {"w:val": str(size)}))
        rp.append(element("w:color", {"w:val": color}))
        if bold:
            rp.append(element("w:b"))
        if sid == "Code":
            rp.append(element("w:rFonts", {"w:ascii": CODE_FONT, "w:hAnsi": CODE_FONT}))
        style.append(rp)
        root.append(style)
    return xml(root)


def header_footer():
    header = element("w:hdr")
    footer = element("w:ftr")
    for parent, label in [
        (header, "MBBS / MBT  •  Odoo API 与 Webhook 集成规范" if LANGUAGE == "zh-CN"
         else "MBBS / MBT  •  ODOO INTEGRATION SPECIFICATION"),
        (footer, "拟实施规范  •  v1.0  •  2026 年 10 月 22 日                         第 "
         if LANGUAGE == "zh-CN"
         else "Proposed specification  •  v1.0  •  22 October 2026                         Page "),
    ]:
        paragraph = element("w:p")
        props = element("w:pPr")
        props.append(element("w:pStyle", {"w:val": "HeaderFooter"}))
        paragraph.append(props)
        paragraph.append(WordDocument.run(label))
        if parent is footer:
            field = element("w:fldSimple", {"w:instr": "PAGE"})
            field.append(WordDocument.run("1"))
            paragraph.append(field)
            if LANGUAGE == "zh-CN":
                paragraph.append(WordDocument.run(" 页"))
        parent.append(paragraph)
    return xml(header), xml(footer)


def write_docx(blocks: list[Block], source_hash: str):
    word = WordDocument()
    word.build(blocks)
    types = element("ct:Types")
    for ext, mime in [("rels", "application/vnd.openxmlformats-package.relationships+xml"), ("xml", "application/xml")]:
        types.append(element("ct:Default", {"Extension": ext, "ContentType": mime}))
    for part, suffix in [
        ("/word/document.xml", "document.main+xml"),
        ("/word/styles.xml", "styles+xml"),
        ("/word/settings.xml", "settings+xml"),
        ("/word/header1.xml", "header+xml"),
        ("/word/footer1.xml", "footer+xml"),
    ]:
        types.append(element("ct:Override", {"PartName": part,
            "ContentType": "application/vnd.openxmlformats-officedocument.wordprocessingml." + suffix}))
    types.append(element("ct:Override", {"PartName": "/docProps/core.xml",
        "ContentType": "application/vnd.openxmlformats-package.core-properties+xml"}))
    relationships = element("pr:Relationships")
    relationships.append(element("pr:Relationship", {"Id": "rIdDocument", "Type": NS["r"] + "/officeDocument", "Target": "word/document.xml"}))
    relationships.append(element("pr:Relationship", {"Id": "rIdCore", "Type": NS["pr"] + "/metadata/core-properties", "Target": "docProps/core.xml"}))
    core = element("cp:coreProperties")
    core.append(element("dc:title", text=next(block.text for block in blocks
                                             if block.kind == "heading" and block.level == 1)))
    core.append(element("dc:creator", text="MBBS / MBT"))
    core.append(element("dc:description", text=f"Source SHA-256: {source_hash}"))
    core.append(element("cp:version", text="1.0"))
    core.append(element("dcterms:created", {"xsi:type": "dcterms:W3CDTF"}, "2026-10-22T00:00:00Z"))
    settings = element("w:settings")
    settings.append(element("w:updateFields", {"w:val": "true"}))
    settings.append(element("w:defaultTabStop", {"w:val": "720"}))
    header, footer = header_footer()
    parts = {
        "[Content_Types].xml": package_xml(types, "ct"),
        "_rels/.rels": package_xml(relationships, "pr"),
        "docProps/core.xml": xml(core), "word/document.xml": xml(word.root),
        "word/_rels/document.xml.rels": package_xml(word.relationships, "pr"),
        "word/styles.xml": styles(), "word/settings.xml": xml(settings),
        "word/header1.xml": header, "word/footer1.xml": footer,
    }
    temporary = DESTINATION.with_suffix(".docx.tmp")
    try:
        with ZipFile(temporary, "w", ZIP_DEFLATED) as archive:
            for name, data in parts.items():
                archive.writestr(name, data)
        temporary.replace(DESTINATION)
    finally:
        temporary.unlink(missing_ok=True)


def word_plain(value: str) -> str:
    def replace(match):
        if match.group(1):
            url = match.group(2)
            if url.startswith(("https://", "http://")):
                return match.group(1)
            return f"{match.group(1)} ({url})"
        return match.group(3) or match.group(4)
    return INLINE.sub(replace, value)


def check_docx(blocks: list[Block], source_hash: str):
    expected = []
    for block in blocks:
        if block.kind == "table":
            expected.extend(word_plain(cell) for row in block.rows for cell in row)
        elif block.kind == "code":
            expected.extend(block.text.split("\n"))
        else:
            expected.append(("• " if block.kind == "bullet" else "") + word_plain(block.text))
    expected = [value for value in expected if value]
    with ZipFile(DESTINATION) as archive:
        if archive.testzip():
            raise ValueError("DOCX ZIP integrity failure")
        for name in archive.namelist():
            ET.fromstring(archive.read(name))
        core = ET.fromstring(archive.read("docProps/core.xml"))
        if core.findtext("dc:description", namespaces=NS) != f"Source SHA-256: {source_hash}":
            raise ValueError("DOCX source hash does not match Markdown")
        root = ET.fromstring(archive.read("word/document.xml"))
        body = root.find("w:body", NS)
        actual = []
        for child in body:
            if child.tag == f"{{{NS['w']}}}sdt":
                continue
            paragraphs = [child] if child.tag == f"{{{NS['w']}}}p" else child.findall(".//w:p", NS)
            for paragraph in paragraphs:
                value = "".join(node.text or "" for node in paragraph.findall(".//w:t", NS))
                if value:
                    actual.append(value)
        if expected != actual:
            mismatch = next((i for i, pair in enumerate(zip(expected, actual)) if pair[0] != pair[1]), min(len(expected), len(actual)))
            raise ValueError(f"Word/Markdown text mismatch at paragraph/cell {mismatch}")
        bookmarks = {node.get(f"{{{NS['w']}}}name") for node in root.findall(".//w:bookmarkStart", NS)}
        if bookmarks != {f"section_{i}" for i in range(1, 19)}:
            raise ValueError("Missing document navigation bookmarks")
        relationships = ET.fromstring(archive.read("word/_rels/document.xml.rels"))
        known_ids = {node.get("Id") for node in relationships}
        for node in root.findall(".//w:hyperlink", NS):
            relation = node.get(f"{{{NS['r']}}}id")
            if relation and relation not in known_ids:
                raise ValueError("Broken document hyperlink relationship")
    return len(expected)


def main():
    global SOURCE, DESTINATION, LANGUAGE, BODY_FONT, EAST_ASIA_FONT, CODE_FONT
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Validate existing Markdown/DOCX without writing")
    parser.add_argument("--source", type=Path, default=SOURCE, help="Markdown source path")
    parser.add_argument("--output", type=Path, help="DOCX output path; defaults to source with .docx suffix")
    parser.add_argument("--language", choices=("en-CA", "zh-CN"), default="en-CA",
                        help="Document labels, language metadata and fonts")
    args = parser.parse_args()
    SOURCE = args.source.resolve()
    DESTINATION = args.output.resolve() if args.output else SOURCE.with_suffix(".docx")
    if DESTINATION.suffix.lower() != ".docx":
        parser.error("--output must have a .docx suffix")
    LANGUAGE = args.language
    if LANGUAGE == "zh-CN":
        BODY_FONT, EAST_ASIA_FONT, CODE_FONT = "DejaVu Sans", "Noto Sans CJK SC", "DejaVu Sans Mono"
    content = SOURCE.read_text(encoding="utf-8")
    digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
    blocks = parse_markdown(content)
    examples = validate_source(blocks, content)
    if not args.check:
        write_docx(blocks, digest)
    text_items = check_docx(blocks, digest)
    print(f"{'Checked' if args.check else 'Built'} {DESTINATION.name}: "
          f"18 sections, {examples} valid JSON examples, 30 acceptance scenarios, "
          f"{text_items} matching paragraphs/cells/code lines.")
    print(f"Markdown SHA-256: {digest}")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, json.JSONDecodeError) as error:
        print(f"Document validation failed: {error}", file=sys.stderr)
        raise SystemExit(1)
