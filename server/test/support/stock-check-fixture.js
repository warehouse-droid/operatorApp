export const ENDURA_SKU='177ECS0163703-0';
export const UNILOCK_FIXTURE_ORIGIN='https://ontario.order.unilock.com';
export function selectedProductHtml({pickup='Pickering',sku=ENDURA_SKU}={}) {
  return `<!doctype html><html><head><title>Products - Unilock's eCommerce - ENDURA™ COPING - endura-coping-ontario - Z_NTN_E0D</title></head><body>
    <a id="SelectedShipping">Pickup at Loc 07 - Unilock Ayr on 10/15/2026</a>
    <form action="/products/products/endura-coping" method="post">
    <input type="hidden" name="__VIEWSTATE" value="synthetic-viewstate">
    <input name="ctl00$cpholder$txtPassword" type="password" value="fixture-secret-never-returned">
    <span id="ctl00_cpholder_ctl00_selectedItemName">Endura™ Coping 24x14 Cham Oat Beige</span>
    <span id="ctl00_cpholder_ctl00_selectedFinish">SMOOTH</span>
    <span id="ctl00_cpholder_ctl00_selectedColour">OAT BEIGE</span>
    <span id="ctl00_cpholder_ctl00_selectedShape">COPING</span>
    <span id="ctl00_cpholder_ctl00_selectedItemLocation">${pickup}</span>
    <span id="ctl00_cpholder_ctl00_selectedItemNo">${sku}</span>
    <a id="ctl00_cpholder_ctl00_rptFinish_ctl00_rptColorF_ctl09_colorFinishId" title="OAT BEIGE, SMOOTH" href='javascript:WebForm_DoPostBackWithOptions(new WebForm_PostBackOptions("ctl00$cpholder$ctl00$rptFinish$ctl00$rptColorF$ctl09$colorFinishId", "", true, "", "", false, true))'>OAT BEIGE</a>
    <a id="ctl00_cpholder_ctl00_rptFinish_ctl00_rptColorF_ctl10_colorFinishId" title="OAT BEIGE, SMOOTH" href='javascript:__doPostBack("ctl00$cpholder$ctl00$rptFinish$ctl00$rptColorF$ctl10$colorFinishId", "")'>OAT BEIGE</a>
    <a id="ctl00_cpholder_ctl00_rptChildShape_ctl00_rptChildItem_ctl00_Link" title="${sku}" href='javascript:WebForm_DoPostBackWithOptions(new WebForm_PostBackOptions("ctl00$cpholder$ctl00$rptChildShape$ctl00$rptChildItem$ctl00$Link", "", true, "", "", false, true))'>
      <img class="childItemImg" src="https://ontario.order.unilock.com/SupplyImages/Ontario/E0D/${sku}_S1X.jpg">
      <span id="ctl00_cpholder_ctl00_rptChildShape_ctl00_rptChildItem_ctl00_Label2">Endura™ Coping 24x14 Cham Oat Beige</span>
      <span id="ctl00_cpholder_ctl00_rptChildShape_ctl00_rptChildItem_ctl00_Label4">600mm x 60mm x 355mm</span>
      <span id="ctl00_cpholder_ctl00_rptChildShape_ctl00_rptChildItem_ctl00_Label5">23 5/8" x 2 3/8" x 14"</span>
      <span id="ctl00_cpholder_ctl00_rptChildShape_ctl00_rptChildItem_ctl00_PlantDescription">Plant Produced: Ayr</span>
    </a>
    <span id="ctl00_cpholder_ctl00_stockAvail">Available - Low in Stock</span>
    <span class="text-danger" id="ctl00_cpholder_ctl00_error" style="display:none">Not enough stock</span>
    </form></body></html>`;
}
export function cartHtml(rows=[{sku:ENDURA_SKU,quantity:5,uom:'BNDL'},{sku:'OTHER-1',quantity:2,uom:'BNDL'}]) {
  return `<!doctype html><html><body><a id="SelectedShipping">Pickup at Loc 03 - Unilock Pickering on 10/15/2026</a>
    <form action="/shoppingCart.aspx" method="post">${rows.map((row,index)=>{
      const ctl=String(index+1).padStart(2,'0'),prefix='ctl00_cpholder_CartInfoCtl_datalistctl_ctl'+ctl;
      const name='ctl00$cpholder$CartInfoCtl$datalistctl$ctl'+ctl;
      return `<div class="cart-line"><a id="${prefix}_HyperLink1">${row.sku}</a>
        <div class="avail-col"><span id="${prefix}_availability">${row.availabilityText??'Available'}</span></div>
        <input id="${prefix}_QuantityTextBox" name="${name}$QuantityTextBox" value="${row.quantity}">
        <select id="${prefix}_uomctl_iuom" name="${name}$uomctl$iuom"><option value="BNDL" ${row.uom==='BNDL'?'selected':''}>Bundle</option><option value="SQFT" ${row.uom==='SQFT'?'selected':''}>Square Ft</option></select>
        <a id="${prefix}_removefromcart" href='javascript:WebForm_DoPostBackWithOptions(new WebForm_PostBackOptions("${name}$removefromcart", "", true, "", "", false, true))'>Remove</a></div>`;
    }).join('')}</form></body></html>`;
}
