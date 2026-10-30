# Stock request user manual — 29 September 2026

- [Printable PDF](Stock_Request_User_Manual_2026-09-29.pdf)
- [Offline HTML with screenshot enlargement](Stock_Request_User_Manual_2026-09-29.html)
- [简体中文 PDF 手册](Stock_Request_User_Manual_2026-09-29_zh-CN.pdf)
- [简体中文离线 HTML（截图可放大）](Stock_Request_User_Manual_2026-09-29_zh-CN.html)

The manual has 28 pages and 29 embedded screenshots. It covers Sales and SCM for regular Pickup, Delivery and Stocking requests, special vendor enquiries, SO/PO processing, readiness, fulfillment, adjustments, closure, alerts and troubleshooting.

The Simplified Chinese edition follows the same 28 pages and 29 screenshots. It translates the instructions, captions, tables, navigation and reference material, while retaining the original English screenshots and English button names alongside Chinese explanations.

Screenshots render the deployed application interface with fictional training records. All screenshot API calls are intercepted; the capture browser runs with networking disabled. No live orders are created or changed. Screenshots represent separate workflow states, not one live transaction.

The approval settings verified for this edition are: automatic approval on, a 12-hour delivery lead time, and 15-minute approval validity. Arrival date/time are shown and mandatory only for Delivery; Pickup and Stocking have neither input. Pickup has no minimum lead time and follows pre-approval → Sales SO → routing confirmation. Stocking always requires SCM review and direct TO creation; no SO is required. These settings are dated reference values; the actual request and current Settings screen remain authoritative.

Special quote previews include the entered PLT, SEC, LYR and PCS quantities beside Amount, following the NetSuite sample. They do not change the sales quantity or pricing. The quote image is rendered from a generated PDF using fictional data.

## Maintaining the guide

Source tools, relative to the server repository:

- `tools/stock-request-manual-capture.mjs`: fictional fixtures and actual UI screenshot captures.
- `tools/stock-request-manual-content.py`: reviewed manual text, layout and embedded screenshots.
- `tools/stock-request-manual-content-zh.py`: complete Simplified Chinese text, using the same screenshots and layout theme without rewriting the English files.
- `tools/stock-request-manual-pdf.mjs`: print layout, image/link checks, PDF creation and screenshot zoom verification.
- `tools/stock-request-manual-build.py`: isolated browser runner and deployed-source verification.

The capture process uses the deployed public assets copied into `test-artifacts/stock-request-manual-20260929/runtime/public`. Source hashes and the deployment image ID are recorded in that directory's sibling `source-evidence.json`.

After reviewing text or screenshots, rebuild from the server repository:

```bash
python3 tools/stock-request-manual-content.py
python3 tools/stock-request-manual-build.py pdf
```

Rebuild the Chinese edition:

```bash
python3 tools/stock-request-manual-content-zh.py
python3 tools/stock-request-manual-build.py pdf zh-CN
```

`validation/build.json` records the final checks. `validation/layout.json` records the layout of every page, and `validation/page-*.png` contains print-layout previews. `screenshots.json` describes the source captures. The HTML contains all used images and requires no external assets or network access.

Chinese validation is saved separately in `validation-zh-CN/`, including a check that Chinese text renders with a Chinese font. Each edition has matching HTML and PDF page counts, working internal links and screenshot enlargement, and no page-content overlap with footers.
