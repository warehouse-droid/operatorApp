from pathlib import Path

def change(file,pairs):
 p=Path(file);s=p.read_text()
 for old,new in pairs:
  assert old in s, (file,old[:100])
  s=s.replace(old,new)
 p.write_text(s)

for file in ['public/scm-special-stock-requests.js','public/sales-special-stock-requests.js']:
 change(file,[("  const workflowReady =", "  const transferEtaReady = import('/special-stock-transfer-eta.js?v=20261016');\n  let isSpecialTransferEta, specialSupplyEtaLabel;\n  const workflowReady ="),
 ("      ({ SPECIAL_STAGES, stageFilterHtml, specialStockAvailable } = await workflowReady);", "      ({ SPECIAL_STAGES, stageFilterHtml, specialStockAvailable } = await workflowReady);\n      ({ isSpecialTransferEta, specialSupplyEtaLabel } = await transferEtaReady);")])
change('public/sales-special-stock-requests.js',[("const canAccept = specialStockAvailable(line.supplyStatus) || line.availableDate;", "const canAccept = specialStockAvailable(line.supplyStatus) || line.availableDate || isSpecialTransferEta(line);"),
 ('${escapeHtml(line.availableDate || "—")}', '${escapeHtml(specialSupplyEtaLabel(line))}')])
change('public/scm-special-stock-requests.js',[("const requiresSupplyEta = status => ['production', 'vendor_transfer'].includes(status);", "const requiresSupplyEta = status => status === 'production';"),
 ("    if (line.salesDecision === 'accepted') return", "    const pendingTransfer = isSpecialTransferEta(line) && !state.detail.salesOrderId;\n    if (line.salesDecision === 'accepted') return"),
 ('data-kind="readiness" data-line-id="${line.id}">', 'data-kind="readiness" data-line-id="${line.id}" data-transfer-pending="${pendingTransfer}">'),
 ('value="${escapeHtml(line.availableDate || \'\')}" /></label></div>`;', 'value="${escapeHtml(line.availableDate || \'\')}" /></label><p data-special-transfer-eta ${pendingTransfer ? \'\' : \'hidden\'}>SO placement +5 working days</p></div>`;'),
 ("special-response-stock-row${requiresSupplyEta(line.supplyStatus) ? ' has-eta' : ''}", "special-response-stock-row${requiresSupplyEta(line.supplyStatus) || line.supplyStatus === 'vendor_transfer' ? ' has-eta' : ''}"),
 ('      </div>\n      <div class="special-response-notes-row">', '      <p data-special-transfer-eta ${line.supplyStatus === \'vendor_transfer\' ? \'\' : \'hidden\'}>ETA: SO placement +5 working days</p>\n      </div>\n      <div class="special-response-notes-row">'),
 ("escapeHtml(line.availableDate || 'Not available')", "escapeHtml(specialSupplyEtaLabel(line, 'Not available'))"),
 ("const waiting = status ? requiresSupplyEta(status.value) : form.querySelector('[name=ready]')?.value === 'false';\n    form.querySelector('.special-response-stock-row')?.classList.toggle('has-eta', waiting);", "const relative = status ? status.value === 'vendor_transfer' : form.dataset.transferPending === 'true' && form.querySelector('[name=ready]')?.value === 'false';\n    const waiting = status ? requiresSupplyEta(status.value) : !relative && form.querySelector('[name=ready]')?.value === 'false';\n    const transferLabel = form.querySelector('[data-special-transfer-eta]');\n    if (transferLabel) transferLabel.hidden = !relative;\n    form.querySelector('.special-response-stock-row')?.classList.toggle('has-eta', waiting || relative);"),
 ("availabilityMode: eta ? 'dated' : 'no_projection'", "availabilityMode: fields.supplyStatus === 'vendor_transfer' ? 'so_placement' : eta ? 'dated' : 'no_projection'")])
change('public/backorder-stock-requests.js',[("import {isBackorder,canLinkBackorderOrder}", "import {isSpecialTransferEta,specialSupplyEtaLabel,SPECIAL_TRANSFER_ETA_LABEL} from './special-stock-transfer-eta.js';\nimport {isBackorder,canLinkBackorderOrder}"),
 ("vendor_transfer:'Vendor transfer'", "vendor_transfer:'Wait for Transfer'"),
 ("line.supplyStatus==='in_stock';", "line.supplyStatus==='in_stock',transfer=line.supplyStatus==='vendor_transfer',pendingTransfer=isSpecialTransferEta(line) && !d.salesOrderId;"),
 ("esc(line.availableDate || 'Not available')", "esc(specialSupplyEtaLabel(line, 'Not available'))"),
 ("${line.availableDate?` · ETA ${esc(line.availableDate)}`:''}", "${line.availableDate || isSpecialTransferEta(line)?` · ETA ${esc(specialSupplyEtaLabel(line))}`:''}"),
 ('data-backorder-projection-fields ${inStock?\'hidden disabled\':\'\'}>', 'data-backorder-projection-fields ${inStock || transfer?\'hidden disabled\':\'\'}>'),
 ("${label('availableDate','ETA',line.availableDate,'date')}</fieldset>", "${label('availableDate','ETA',line.availableDate,'date')}</fieldset><p data-backorder-transfer-eta ${transfer?'':'hidden'}>ETA: ${SPECIAL_TRANSFER_ETA_LABEL}</p>"),
 ('data-backorder-readiness-eta ${specialStockAvailable(line.supplyStatus)?\'hidden disabled\':\'\'}>', 'data-backorder-readiness-eta data-transfer-pending="${pendingTransfer}" ${specialStockAvailable(line.supplyStatus) || pendingTransfer?\'hidden disabled\':\'\'}>'),
 ("${label('eta','Revised ETA',line.availableDate,'date')}</fieldset>`)", "${label('eta','Revised ETA',line.availableDate,'date')}</fieldset><p data-backorder-readiness-transfer ${pendingTransfer?'':'hidden'}>${SPECIAL_TRANSFER_ETA_LABEL}</p>`)") ,
 ("['[data-backorder-projection-fields]',!ordered && select.value!=='in_stock']", "['[data-backorder-projection-fields]',!ordered && !['in_stock','vendor_transfer'].includes(select.value)]"),
 ("fields.hidden=!show;fields.disabled=!show;\n      }", "fields.hidden=!show;fields.disabled=!show;\n      }\n      const transferLabel=/** @type {HTMLElement} */ (form.querySelector('[data-backorder-transfer-eta]'));\n      transferLabel.hidden=select.value!=='vendor_transfer';"),
 ("fields.hidden=select.value==='true';fields.disabled=fields.hidden;return;", "const pending=fields.dataset.transferPending==='true';\n      fields.hidden=select.value==='true' || pending;fields.disabled=fields.hidden;\n      const transferLabel=/** @type {HTMLElement} */ (select.closest('form')?.querySelector('[data-backorder-readiness-transfer]'));\n      transferLabel.hidden=!pending || select.value==='true';return;"),
 ("if (fields.supplyStatus==='in_stock') {fields.availabilityMode='no_projection';fields.availableDate='';}", "if (fields.supplyStatus==='in_stock') {fields.availabilityMode='no_projection';fields.availableDate='';}\n    if (fields.supplyStatus==='vendor_transfer') {fields.availabilityMode='so_placement';fields.availableDate='';}")])
for file in ['public/scm-stock-requests.js','public/sales-stock-requests.js']:
 change(file,[("/backorder-stock-requests.js?", "/backorder-stock-requests.js?transferEta=20261016&")])
for file in ['public/scm-stock-requests.html','public/sales-stock-requests.html']:
 audience='scm' if '/scm-' in file else 'sales'
 change(file,[(f'/{audience}-special-stock-requests.js?',f'/{audience}-special-stock-requests.js?transferEta=20261016&'),(f'/{audience}-stock-requests.js?',f'/{audience}-stock-requests.js?transferEta=20261016&')])
