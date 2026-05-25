const copy = {
  outbound: { label: "Outbound picking", complete: "Shipped", unit: "Fulfilling", selected: "Current fulfilling" },
  inbound: { label: "Inbound receiving", complete: "Receive PO", unit: "Received", selected: "Operator received" },
  productReturn: { label: "Product return", complete: "Close return", unit: "Returned", selected: "Operator returned" },
  delivery: { label: "Delivery prep", complete: "Ready for driver", unit: "Fulfilling", selected: "Current fulfilling" }
};

const menuItems = [
  { key: "outbound", title: "Outbound", text: "Scan order and pick items", icon: "OUT" },
  { key: "inbound", title: "Inbound", text: "Choose vendor and PO", icon: "IN" },
  { key: "return", title: "Return", text: "Pallet or product return", icon: "RET" },
  { key: "delivery", title: "Delivery", text: "Scan load and confirm delivery", icon: "DEL" }
];

const I18N = {
  en: {
    langName: "EN",
    brand: "MBBS Yard Operator Application",
    menu: "Menu",
    chooseWorkType: "Choose Work Type",
    outbound: "Outbound",
    inbound: "Inbound",
    return: "Return",
    delivery: "Delivery",
    outboundText: "Scan order and pick items",
    inboundText: "Choose vendor and PO",
    returnText: "Pallet or product return",
    deliveryText: "Prepare stock for driver pickup",
    outboundPicking: "Outbound picking",
    inboundReceiving: "Inbound receiving",
    productReturn: "Product return",
    deliveryPrep: "Delivery prep",
    shipped: "Shipped",
    receivePo: "Receive PO",
    closeReturn: "Close return",
    readyForDriver: "Ready for driver",
    fulfilling: "Fulfilling",
    currentFulfilling: "Current fulfilling",
    received: "Received",
    operatorReceived: "Operator received",
    returned: "Returned",
    operatorReturned: "Operator returned",
    scanOrderSheet: "Scan the QR code on the order sheet.",
    scannerNotWorking: "Scanner not working?",
    enterOrderNumber: "Enter order number",
    openOrder: "Open order",
    qrScanner: "QR Scanner",
    cameraArea: "Prototype camera area",
    fakeScanNow: "Fake scan now",
    selectVendorFirst: "Select vendor first, then choose or search PO number.",
    vendorSelected: "Vendor selected. Search or scan the PO number.",
    vendor: "Vendor",
    reselectVendor: "Re-select vendor",
    pickVendor: "Pick a vendor",
    poSearchHint: "The PO search and number pad will show here.",
    findPo: "Find PO",
    poNumber: "PO number",
    noMatch: "No match",
    scanPaperPo: "Use the pad or scan the paper PO.",
    scanPoBarcode: "Scan PO barcode",
    chooseReturnType: "Choose the return type.",
    palletReturn: "Pallet return",
    palletReturnText: "Enter or scan customer code, then count pallets.",
    productReturnText: "Scan order first. Only items from that order are allowed.",
    returnNumber: "Return number",
    showReturnNumber: "Show this return number to the customer.",
    newPalletReturn: "New pallet return",
    selectCustomerFirst: "Select customer first, or scan a Sales Order Number.",
    customerNameCode: "Customer name or code",
    typeCustomer: "Type customer name or code",
    salesOrderScanner: "Sales Order scanner",
    scanSoNumber: "Scan SO Number",
    fakeScanSo: "Fake scan SO",
    findBySo: "Find by SO",
    noCustomerFound: "No customer found",
    tryCustomerCode: "Try customer code or scan Sales Order Number.",
    customerSelectedQty: "Customer selected. Enter returned pallet quantity.",
    customer: "Customer",
    changeCustomer: "Change customer",
    palletsReturned: "Pallets returned",
    confirmReturn: "Confirm return",
    deliveryPrepTitle: "Delivery Prep",
    deliveryPrepSubtitle: "Prepare stock for drivers to pick up.",
    deliveryDate: "Delivery date",
    notPrepared: "not prepared",
    noDeliveryOrders: "No delivery orders",
    changeDate: "Change the date filter to see other orders.",
    progress: "Progress",
    required: "Required",
    status: "Status",
    open: "Open",
    ready: "Ready",
    itemsInOrder: "Items in this order",
    tapAdjust: "Tap item to adjust",
    pallet: "pallet",
    layer: "layer",
    details: "Details",
    leftover: "Leftover",
    selectedItem: "Selected item",
    confirmLine: "Confirm line",
    scanItem: "Scan item",
    done: "Done",
    adjusted: "Adjusted",
    short: "Short",
    over: "Over",
    shipmentComplete: "Shipment Complete",
    deliveryPrepared: "Delivery Prepared",
    showFulfillment: "Show the fulfillment number and details.",
    fulfillmentNumber: "Fulfillment number",
    backToMenu: "Back to menu",
    cannotOver: "Cannot fulfill more than the order quantity.",
    manualLoaded: "Manual entry loaded.",
    lineConfirmed: "Line confirmed.",
    itemStillOpen: "item line still open.",
    fakeQrLoaded: "Fake QR scan loaded.",
    fakeOrderLoaded: "Fake order scan loaded.",
    fakePoFilled: "Fake PO scan filled the PO number.",
    customerLoadedSo: "Fake SO scan: customer loaded.",
    salesOrderNotFound: "Sales Order not found.",
    selectCustomerFirstToast: "Select customer first."
  },
  zhHans: {
    langName: "简",
    brand: "MBBS 堆场操作应用",
    menu: "菜单",
    chooseWorkType: "选择作业类型",
    outbound: "出库",
    inbound: "入库",
    return: "退回",
    delivery: "配送备货",
    outboundText: "扫描订单并拣货",
    inboundText: "选择供应商和采购单",
    returnText: "托盘退回或商品退回",
    deliveryText: "为司机提货备货",
    outboundPicking: "出库拣货",
    inboundReceiving: "入库收货",
    productReturn: "商品退回",
    deliveryPrep: "配送备货",
    shipped: "已发货",
    receivePo: "收货",
    closeReturn: "关闭退回",
    readyForDriver: "司机可提货",
    fulfilling: "当前备货",
    currentFulfilling: "当前备货",
    received: "已收",
    operatorReceived: "操作员收货",
    returned: "已退",
    operatorReturned: "操作员退回",
    scanOrderSheet: "扫描订单上的二维码。",
    scannerNotWorking: "扫描器不可用？",
    enterOrderNumber: "输入订单号",
    openOrder: "打开订单",
    qrScanner: "二维码扫描",
    cameraArea: "原型相机区域",
    fakeScanNow: "模拟扫描",
    selectVendorFirst: "先选择供应商，然后选择或搜索采购单号。",
    vendorSelected: "已选择供应商。搜索或扫描采购单号。",
    vendor: "供应商",
    reselectVendor: "重新选择供应商",
    pickVendor: "选择供应商",
    poSearchHint: "采购单搜索和数字键盘会显示在这里。",
    findPo: "查找采购单",
    poNumber: "采购单号",
    noMatch: "没有匹配",
    scanPaperPo: "使用键盘或扫描纸质采购单。",
    scanPoBarcode: "扫描采购单条码",
    chooseReturnType: "选择退回类型。",
    palletReturn: "托盘退回",
    palletReturnText: "输入或扫描客户，再填写托盘数量。",
    productReturnText: "先扫描订单，只允许退回该订单内商品。",
    returnNumber: "退回编号",
    showReturnNumber: "向客户显示此退回编号。",
    newPalletReturn: "新的托盘退回",
    selectCustomerFirst: "先选择客户，或扫描销售订单号。",
    customerNameCode: "客户名称或编号",
    typeCustomer: "输入客户名称或编号",
    salesOrderScanner: "销售订单扫描",
    scanSoNumber: "扫描销售订单号",
    fakeScanSo: "模拟扫描SO",
    findBySo: "按SO查找",
    noCustomerFound: "未找到客户",
    tryCustomerCode: "尝试客户编号或扫描销售订单号。",
    customerSelectedQty: "已选择客户。输入退回托盘数量。",
    customer: "客户",
    changeCustomer: "更换客户",
    palletsReturned: "退回托盘数",
    confirmReturn: "确认退回",
    deliveryPrepTitle: "配送备货",
    deliveryPrepSubtitle: "为司机提货准备库存。",
    deliveryDate: "配送日期",
    notPrepared: "未备货",
    noDeliveryOrders: "没有配送订单",
    changeDate: "更改日期筛选查看其他订单。",
    progress: "进度",
    required: "需求",
    status: "状态",
    open: "未完成",
    ready: "就绪",
    itemsInOrder: "订单商品",
    tapAdjust: "点击商品调整",
    pallet: "托盘",
    layer: "层",
    details: "明细",
    leftover: "剩余",
    selectedItem: "已选商品",
    confirmLine: "确认行",
    scanItem: "扫描商品",
    done: "完成",
    adjusted: "已调整",
    short: "不足",
    over: "超出",
    shipmentComplete: "发货完成",
    deliveryPrepared: "配送已备货",
    showFulfillment: "显示履约编号和明细。",
    fulfillmentNumber: "履约编号",
    backToMenu: "返回菜单",
    cannotOver: "不能超过订单数量。",
    manualLoaded: "手动输入已加载。",
    lineConfirmed: "行已确认。",
    itemStillOpen: "个商品行未完成。",
    fakeQrLoaded: "模拟二维码扫描已加载。",
    fakeOrderLoaded: "模拟订单扫描已加载。",
    fakePoFilled: "模拟采购单扫描已填写。",
    customerLoadedSo: "模拟SO扫描：客户已加载。",
    salesOrderNotFound: "未找到销售订单。",
    selectCustomerFirstToast: "请先选择客户。"
  },
  zhHant: {
    langName: "繁",
    brand: "MBBS 堆場操作應用",
    menu: "選單",
    chooseWorkType: "選擇作業類型",
    outbound: "出庫",
    inbound: "入庫",
    return: "退回",
    delivery: "配送備貨",
    outboundText: "掃描訂單並揀貨",
    inboundText: "選擇供應商和採購單",
    returnText: "棧板退回或商品退回",
    deliveryText: "為司機提貨備貨",
    outboundPicking: "出庫揀貨",
    inboundReceiving: "入庫收貨",
    productReturn: "商品退回",
    deliveryPrep: "配送備貨",
    shipped: "已發貨",
    receivePo: "收貨",
    closeReturn: "關閉退回",
    readyForDriver: "司機可提貨",
    fulfilling: "目前備貨",
    currentFulfilling: "目前備貨",
    received: "已收",
    operatorReceived: "操作員收貨",
    returned: "已退",
    operatorReturned: "操作員退回",
    scanOrderSheet: "掃描訂單上的 QR Code。",
    scannerNotWorking: "掃描器不可用？",
    enterOrderNumber: "輸入訂單號",
    openOrder: "開啟訂單",
    qrScanner: "QR Code 掃描",
    cameraArea: "原型相機區域",
    fakeScanNow: "模擬掃描",
    selectVendorFirst: "先選擇供應商，然後選擇或搜尋採購單號。",
    vendorSelected: "已選擇供應商。搜尋或掃描採購單號。",
    vendor: "供應商",
    reselectVendor: "重新選擇供應商",
    pickVendor: "選擇供應商",
    poSearchHint: "採購單搜尋和數字鍵盤會顯示在這裡。",
    findPo: "查找採購單",
    poNumber: "採購單號",
    noMatch: "沒有符合",
    scanPaperPo: "使用鍵盤或掃描紙本採購單。",
    scanPoBarcode: "掃描採購單條碼",
    chooseReturnType: "選擇退回類型。",
    palletReturn: "棧板退回",
    palletReturnText: "輸入或掃描客戶，再填寫棧板數量。",
    productReturnText: "先掃描訂單，只允許退回該訂單內商品。",
    returnNumber: "退回編號",
    showReturnNumber: "向客戶顯示此退回編號。",
    newPalletReturn: "新的棧板退回",
    selectCustomerFirst: "先選擇客戶，或掃描銷售訂單號。",
    customerNameCode: "客戶名稱或編號",
    typeCustomer: "輸入客戶名稱或編號",
    salesOrderScanner: "銷售訂單掃描",
    scanSoNumber: "掃描銷售訂單號",
    fakeScanSo: "模擬掃描SO",
    findBySo: "按SO查找",
    noCustomerFound: "未找到客戶",
    tryCustomerCode: "嘗試客戶編號或掃描銷售訂單號。",
    customerSelectedQty: "已選擇客戶。輸入退回棧板數量。",
    customer: "客戶",
    changeCustomer: "更換客戶",
    palletsReturned: "退回棧板數",
    confirmReturn: "確認退回",
    deliveryPrepTitle: "配送備貨",
    deliveryPrepSubtitle: "為司機提貨準備庫存。",
    deliveryDate: "配送日期",
    notPrepared: "未備貨",
    noDeliveryOrders: "沒有配送訂單",
    changeDate: "更改日期篩選查看其他訂單。",
    progress: "進度",
    required: "需求",
    status: "狀態",
    open: "未完成",
    ready: "就緒",
    itemsInOrder: "訂單商品",
    tapAdjust: "點擊商品調整",
    pallet: "棧板",
    layer: "層",
    details: "明細",
    leftover: "剩餘",
    selectedItem: "已選商品",
    confirmLine: "確認行",
    scanItem: "掃描商品",
    done: "完成",
    adjusted: "已調整",
    short: "不足",
    over: "超出",
    shipmentComplete: "發貨完成",
    deliveryPrepared: "配送已備貨",
    showFulfillment: "顯示履約編號和明細。",
    fulfillmentNumber: "履約編號",
    backToMenu: "返回選單",
    cannotOver: "不能超過訂單數量。",
    manualLoaded: "手動輸入已載入。",
    lineConfirmed: "行已確認。",
    itemStillOpen: "個商品行未完成。",
    fakeQrLoaded: "模擬 QR 掃描已載入。",
    fakeOrderLoaded: "模擬訂單掃描已載入。",
    fakePoFilled: "模擬採購單掃描已填寫。",
    customerLoadedSo: "模擬SO掃描：客戶已載入。",
    salesOrderNotFound: "未找到銷售訂單。",
    selectCustomerFirstToast: "請先選擇客戶。"
  }
};

let lang = "en";
function t(key) {
  return I18N[lang][key] || I18N.en[key] || key;
}

function languageSwitcher() {
  return `
    <div class="lang-switcher" aria-label="Language">
      ${Object.keys(I18N).map((key) => `<button class="${lang === key ? "active" : ""}" data-lang="${key}" type="button">${I18N[key].langName}</button>`).join("")}
    </div>
  `;
}

const orders = {
  outbound: [
    {
      id: "OUT-10482",
      customer: "Northbay Retail DC",
      dock: "Door 12",
      due: "10:30",
      skus: [
        { code: "SKU-AX118", name: "Sparkling Water 24ct", required: 20, layerPerPallet: 4, casePerLayer: 18, units: { pallets: 5, layers: 2, cases: 0 }, confirmed: false },
        { code: "SKU-BG442", name: "Protein Bar Mixed Case", required: 9, layerPerPallet: 5, casePerLayer: 12, units: { pallets: 9, layers: 0, cases: 0 }, confirmed: false },
        { code: "SKU-CL990", name: "Chilled Coffee 12ct", required: 6, layerPerPallet: 6, casePerLayer: 10, units: { pallets: 4, layers: 0, cases: 8 }, confirmed: false }
      ]
    }
  ],
  productReturn: [
    {
      id: "OUT-10482",
      customer: "Northbay Retail DC",
      dock: "Return Bay",
      due: "Today",
      skus: [
        { code: "SKU-AX118", name: "Sparkling Water 24ct", required: 2, layerPerPallet: 4, casePerLayer: 18, units: { pallets: 0, layers: 2, cases: 0 }, confirmed: false },
        { code: "SKU-BG442", name: "Protein Bar Mixed Case", required: 1, layerPerPallet: 5, casePerLayer: 12, units: { pallets: 0, layers: 1, cases: 6 }, confirmed: false }
      ]
    }
  ]
};

orders.outbound[0].skus.push(
  { code: "SKU-DR111", name: "Dry Pasta 12ct", required: 3, layerPerPallet: 4, casePerLayer: 16, units: { pallets: 0, layers: 0, cases: 0 }, confirmed: false },
  { code: "SKU-SN204", name: "Sea Salt Chips", required: 8, layerPerPallet: 5, casePerLayer: 10, units: { pallets: 0, layers: 0, cases: 0 }, confirmed: false },
  { code: "SKU-CN330", name: "Canned Corn Tray", required: 11, layerPerPallet: 6, casePerLayer: 12, units: { pallets: 0, layers: 0, cases: 0 }, confirmed: false },
  { code: "SKU-TE415", name: "Green Tea Bottles", required: 4, layerPerPallet: 4, casePerLayer: 18, units: { pallets: 0, layers: 0, cases: 0 }, confirmed: false },
  { code: "SKU-CK520", name: "Cookie Variety Pack", required: 7, layerPerPallet: 5, casePerLayer: 9, units: { pallets: 0, layers: 0, cases: 0 }, confirmed: false },
  { code: "SKU-RC608", name: "Rice Crackers", required: 2, layerPerPallet: 4, casePerLayer: 20, units: { pallets: 0, layers: 0, cases: 0 }, confirmed: false },
  { code: "SKU-AP717", name: "Apple Juice 8ct", required: 5, layerPerPallet: 5, casePerLayer: 14, units: { pallets: 0, layers: 0, cases: 0 }, confirmed: false },
  { code: "SKU-MX820", name: "Trail Mix Carton", required: 6, layerPerPallet: 6, casePerLayer: 8, units: { pallets: 0, layers: 0, cases: 0 }, confirmed: false },
  { code: "SKU-OL909", name: "Olive Oil Case", required: 3, layerPerPallet: 3, casePerLayer: 15, units: { pallets: 0, layers: 0, cases: 0 }, confirmed: false },
  { code: "SKU-SP012", name: "Sparkling Lemonade", required: 10, layerPerPallet: 5, casePerLayer: 12, units: { pallets: 0, layers: 0, cases: 0 }, confirmed: false },
  { code: "SKU-FZ144", name: "Frozen Berry Pack", required: 4, layerPerPallet: 4, casePerLayer: 10, units: { pallets: 0, layers: 0, cases: 0 }, confirmed: false },
  { code: "SKU-PB288", name: "Peanut Butter Jars", required: 9, layerPerPallet: 6, casePerLayer: 11, units: { pallets: 0, layers: 0, cases: 0 }, confirmed: false },
  { code: "SKU-CR390", name: "Cranberry Drink", required: 6, layerPerPallet: 4, casePerLayer: 16, units: { pallets: 0, layers: 0, cases: 0 }, confirmed: false },
  { code: "SKU-YG477", name: "Yogurt Multipack", required: 5, layerPerPallet: 5, casePerLayer: 8, units: { pallets: 0, layers: 0, cases: 0 }, confirmed: false },
  { code: "SKU-GR555", name: "Granola Family Case", required: 12, layerPerPallet: 6, casePerLayer: 10, units: { pallets: 0, layers: 0, cases: 0 }, confirmed: false },
  { code: "SKU-SS632", name: "Soup Starter Tray", required: 3, layerPerPallet: 3, casePerLayer: 18, units: { pallets: 0, layers: 0, cases: 0 }, confirmed: false },
  { code: "SKU-WF704", name: "Waffle Mix Carton", required: 2, layerPerPallet: 4, casePerLayer: 12, units: { pallets: 0, layers: 0, cases: 0 }, confirmed: false }
);

const deliveryOrders = [
  {
    id: "DEL-8021",
    customer: "Route A - Stop 01",
    dock: "Driver pickup",
    due: "08:30",
    date: "2026-05-22",
    skus: [
      { code: "SKU-BG442", name: "Protein Bar Mixed Case", required: 7, layerPerPallet: 5, casePerLayer: 12, units: { pallets: 2, layers: 0, cases: 0 }, confirmed: false },
      { code: "SKU-HM210", name: "Honey Oat Cereal", required: 5, layerPerPallet: 7, casePerLayer: 9, units: { pallets: 1, layers: 3, cases: 0 }, confirmed: false }
    ]
  },
  {
    id: "DEL-8025",
    customer: "Route A - Stop 04",
    dock: "Driver pickup",
    due: "09:15",
    date: "2026-05-22",
    skus: [
      { code: "SKU-AX118", name: "Sparkling Water 24ct", required: 4, layerPerPallet: 4, casePerLayer: 18, units: { pallets: 0, layers: 2, cases: 0 }, confirmed: false }
    ]
  },
  {
    id: "DEL-8060",
    customer: "Route B - Stop 02",
    dock: "Driver pickup",
    due: "13:00",
    date: "2026-05-23",
    skus: [
      { code: "SKU-CL990", name: "Chilled Coffee 12ct", required: 6, layerPerPallet: 6, casePerLayer: 10, units: { pallets: 2, layers: 1, cases: 0 }, confirmed: false }
    ]
  }
];

deliveryOrders[0].skus.push(
  { code: "SKU-DR111", name: "Dry Pasta 12ct", required: 2, layerPerPallet: 4, casePerLayer: 16, units: { pallets: 0, layers: 0, cases: 0 }, confirmed: false },
  { code: "SKU-SN204", name: "Sea Salt Chips", required: 3, layerPerPallet: 5, casePerLayer: 10, units: { pallets: 0, layers: 0, cases: 0 }, confirmed: false },
  { code: "SKU-AP717", name: "Apple Juice 8ct", required: 1, layerPerPallet: 5, casePerLayer: 14, units: { pallets: 0, layers: 0, cases: 0 }, confirmed: false },
  { code: "SKU-MX820", name: "Trail Mix Carton", required: 4, layerPerPallet: 6, casePerLayer: 8, units: { pallets: 0, layers: 0, cases: 0 }, confirmed: false },
  { code: "SKU-PB288", name: "Peanut Butter Jars", required: 2, layerPerPallet: 6, casePerLayer: 11, units: { pallets: 0, layers: 0, cases: 0 }, confirmed: false },
  { code: "SKU-GR555", name: "Granola Family Case", required: 5, layerPerPallet: 6, casePerLayer: 10, units: { pallets: 0, layers: 0, cases: 0 }, confirmed: false }
);

const vendors = [
  { name: "Apex Foods", code: "V-1001", pos: ["45128", "45142", "45155"] },
  { name: "Bright Cold Chain", code: "V-1002", pos: ["77201", "77204"] },
  { name: "Cedar Beverage", code: "V-1003", pos: ["66018", "66031"] },
  { name: "Delta Harvest", code: "V-1004", pos: ["88300", "88319"] },
  { name: "Evergreen Snacks", code: "V-1005", pos: ["51290", "51302"] },
  { name: "Freshline Dairy", code: "V-1006", pos: ["34110", "34122"] },
  { name: "Golden Mill", code: "V-1007", pos: ["71930", "71944"] },
  { name: "Harbor Produce", code: "V-1008", pos: ["90412", "90413"] },
  { name: "Ironwood Supply", code: "V-1009", pos: ["22570", "22581"] },
  { name: "Jade Market", code: "V-1010", pos: ["11840", "11866"] },
  { name: "Keystone Grocery", code: "V-1011", pos: ["63820", "63821"] },
  { name: "Luma Brands", code: "V-1012", pos: ["30319", "30320"] },
  { name: "Metro Fresh", code: "V-1013", pos: ["49110", "49111"] },
  { name: "Northstar Trading", code: "V-1014", pos: ["55510", "55598"] },
  { name: "Orchard Road", code: "V-1015", pos: ["24680", "24681"] }
];

const customers = [
  { name: "Northbay Retail DC", code: "CUS-1048", salesOrders: ["SO-70018", "SO-70035"] },
  { name: "Customer Choice Market", code: "CUS-2080", salesOrders: ["SO-80114", "SO-80120"] },
  { name: "Luna Grocers", code: "CUS-3095", salesOrders: ["SO-91001"] },
  { name: "Metro Fresh Stores", code: "CUS-4421", salesOrders: ["SO-55109"] },
  { name: "Cedar Corner Foods", code: "CUS-5002", salesOrders: ["SO-66220"] },
  { name: "Golden Basket Wholesale", code: "CUS-6188", salesOrders: ["SO-77006"] }
];

const poLines = {
  "45128": [
    { code: "SKU-RM300", name: "Rice Master Bag", required: 18, layerPerPallet: 6, casePerLayer: 8, units: { pallets: 18, layers: 0, cases: 0 }, confirmed: false },
    { code: "SKU-OJ225", name: "Orange Juice 6ct", required: 12, layerPerPallet: 4, casePerLayer: 16, units: { pallets: 11, layers: 2, cases: 0 }, confirmed: false }
  ],
  default: [
    { code: "SKU-IN100", name: "Mixed inbound item", required: 8, layerPerPallet: 4, casePerLayer: 12, units: { pallets: 8, layers: 0, cases: 0 }, confirmed: false }
  ]
};

let screen = "menu";
let activeMode = "outbound";
let activeOrder = prepareOrder(orders.outbound[0], "outbound");
let selectedSkuIndex = 0;
let selectedVendor = null;
let poSearch = "";
let deliveryDate = "2026-05-22";
let lastResult = null;
let palletCustomerQuery = "";
let selectedPalletCustomer = null;
let toastTimer;

const app = document.getElementById("app");
const toast = document.getElementById("toast");

function loadedQty(sku) {
  return sku.units.pallets + sku.units.layers / sku.layerPerPallet + sku.units.cases / (sku.layerPerPallet * sku.casePerLayer);
}

function requiredLayers(sku) {
  return Math.round(sku.required * sku.layerPerPallet);
}

function currentLayers(sku) {
  return sku.units.pallets * sku.layerPerPallet + sku.units.layers;
}

function formatPalletLayer(layerCount, layersPerPallet) {
  const pallets = Math.floor(layerCount / layersPerPallet);
  const layers = layerCount % layersPerPallet;
  return `${pallets} ${t("pallet")} ${layers} ${t("layer")}`;
}

function formatSkuQty(sku, mode, layerCount = currentLayers(sku)) {
  if (mode === "outbound" || mode === "delivery") return formatPalletLayer(layerCount, sku.layerPerPallet);
  return `${formatQty(loadedQty(sku))} plt`;
}

function unitLabel(key) {
  if (key === "pallet") return lang === "en" ? "Pallets" : t("pallet");
  if (key === "layer") return lang === "en" ? "Layers" : t("layer");
  return key;
}

function processCopy(mode) {
  return {
    outbound: { label: t("outboundPicking"), complete: t("shipped"), unit: t("fulfilling"), selected: t("currentFulfilling") },
    inbound: { label: t("inboundReceiving"), complete: t("receivePo"), unit: t("received"), selected: t("operatorReceived") },
    productReturn: { label: t("productReturn"), complete: t("closeReturn"), unit: t("returned"), selected: t("operatorReturned") },
    delivery: { label: t("deliveryPrep"), complete: t("readyForDriver"), unit: t("fulfilling"), selected: t("currentFulfilling") }
  }[mode];
}

function prepareOrder(order, mode) {
  const nextOrder = structuredClone(order);
  if (mode === "outbound" || mode === "delivery" || mode === "inbound") {
    nextOrder.skus.forEach((sku) => {
      sku.units = { pallets: sku.required, layers: 0, cases: 0 };
      sku.confirmed = false;
    });
  }
  return nextOrder;
}

function formatQty(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("show");
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2000);
}

function goMenu() {
  screen = "menu";
  render();
}

function fakeScan(mode) {
  activeMode = mode;
  activeOrder = prepareOrder(orders[mode][0], mode);
  selectedSkuIndex = 0;
  screen = "work";
  render();
  showToast(mode === "outbound" ? t("fakeQrLoaded") : t("fakeOrderLoaded"));
}

function renderShell(title, subtitle, body, actions = "") {
  app.innerHTML = `
    <section class="screen">
      <header class="topbar">
        <button class="back-button" data-action="menu" type="button">${t("menu")}</button>
        <div>
          <p class="eyebrow">${t("brand")}</p>
          <h1>${title}</h1>
          <p class="subtle">${subtitle}</p>
        </div>
        <div class="topbar-actions">${actions}${languageSwitcher()}</div>
      </header>
      ${body}
    </section>
  `;
}

function renderMenu() {
  const labels = {
    outbound: [t("outbound"), t("outboundText")],
    inbound: [t("inbound"), t("inboundText")],
    return: [t("return"), t("returnText")],
    delivery: [t("delivery"), t("deliveryText")]
  };
  app.innerHTML = `
    <section class="menu-screen">
      <div class="menu-header">
        <div class="brand-row">
          <div class="brand-mark">T</div>
          <div>
            <p class="eyebrow">${t("brand")}</p>
            <h1>${t("chooseWorkType")}</h1>
          </div>
        </div>
        ${languageSwitcher()}
      </div>
      <div class="menu-grid">
        ${menuItems.map((item) => `
          <button class="menu-card" data-menu="${item.key}" type="button">
            <span class="menu-icon">${item.icon}</span>
            <strong>${labels[item.key][0]}</strong>
            <span>${labels[item.key][1]}</span>
          </button>
        `).join("")}
      </div>
    </section>
  `;
}

function renderScanner(mode, title, subtitle) {
  const manualEntry = mode === "outbound" ? `
    <aside class="manual-scan-panel">
      <p class="eyebrow">${t("scannerNotWorking")}</p>
      <h2>${t("enterOrderNumber")}</h2>
      <input id="manualOrderInput" class="search-input" value="OUT-10482" placeholder="OUT-10482" />
      <button class="primary-button" data-action="manual-outbound" type="button">${t("openOrder")}</button>
    </aside>
  ` : "";

  renderShell(title, subtitle, `
    <section class="scanner-screen">
      <div class="scanner-layout">
        <div class="scanner-frame">
          <div class="scan-corners"></div>
          <strong>${t("qrScanner")}</strong>
          <span>${t("cameraArea")}</span>
        </div>
        ${manualEntry}
      </div>
      <button class="big-primary" data-scan="${mode}" type="button">${t("fakeScanNow")}</button>
    </section>
  `);
}

function renderInboundVendors() {
  if (selectedVendor !== null) {
    const vendor = vendors[selectedVendor];
    renderShell(t("inbound"), t("vendorSelected"), `
      <section class="po-focus-layout">
        <div class="selected-vendor-card">
          <span class="eyebrow">${t("vendor")}</span>
          <strong>${vendor.name}</strong>
          <span>${vendor.code}</span>
          <button class="secondary-button" data-action="reselect-vendor" type="button">${t("reselectVendor")}</button>
        </div>
        <aside class="lookup-panel wide">
          ${renderPoLookup()}
        </aside>
      </section>
    `);
    return;
  }

  renderShell(t("inbound"), t("selectVendorFirst"), `
    <section class="vendor-layout">
      <div class="vendor-list">
        ${vendors.map((vendor, index) => `
          <button class="list-card ${selectedVendor === index ? "active" : ""}" data-vendor="${index}" type="button">
            <strong>${vendor.name}</strong>
            <span>${vendor.code} - ${vendor.pos.length} open POs</span>
          </button>
        `).join("")}
      </div>
      <aside class="lookup-panel">
        ${selectedVendor === null ? renderEmptyLookup() : renderPoLookup()}
      </aside>
    </section>
  `);
}

function renderEmptyLookup() {
  return `
    <div class="empty-state">
      <strong>${t("pickVendor")}</strong>
      <span>${t("poSearchHint")}</span>
    </div>
  `;
}

function renderPoLookup() {
  const vendor = vendors[selectedVendor];
  const matches = vendor.pos.filter((po) => po.includes(poSearch));
  return `
    <p class="eyebrow">${vendor.name}</p>
    <h2>${t("findPo")}</h2>
    <input class="search-input" id="poSearch" value="${poSearch}" placeholder="${t("poNumber")}" inputmode="numeric" />
    <div class="number-pad">
      ${["1", "2", "3", "4", "5", "6", "7", "8", "9", "Clear", "0", "Back"].map((key) => `
        <button data-pad="${key}" type="button">${key}</button>
      `).join("")}
    </div>
    <div class="po-list">
      ${(poSearch ? matches : vendor.pos).map((po) => `
        <button class="po-card" data-po="${po}" type="button">
          <strong>PO ${po}</strong>
          <span>${vendor.code}</span>
        </button>
      `).join("") || `<div class="empty-state small"><strong>${t("noMatch")}</strong><span>${t("scanPaperPo")}</span></div>`}
    </div>
    <button class="secondary-wide" data-action="scan-po" type="button">${t("scanPoBarcode")}</button>
  `;
}

function makeInboundOrder(po) {
  return prepareOrder({
    id: `PO-${po}`,
    customer: vendors[selectedVendor].name,
    dock: "Receiving",
    due: "Open",
    skus: structuredClone(poLines[po] || poLines.default)
  }, "inbound");
}

function renderReturnType() {
  renderShell(t("return"), t("chooseReturnType"), `
    <section class="choice-grid">
      <button class="choice-card" data-return-type="pallet" type="button">
        <strong>${t("palletReturn")}</strong>
        <span>${t("palletReturnText")}</span>
      </button>
      <button class="choice-card" data-return-type="product" type="button">
        <strong>${t("productReturn")}</strong>
        <span>${t("productReturnText")}</span>
      </button>
    </section>
  `);
}

function renderPalletReturn() {
  if (lastResult?.type === "palletReturn") {
    renderShell(t("palletReturn"), t("showReturnNumber"), `
      <section class="result-screen">
        <span class="eyebrow">${t("returnNumber")}</span>
        <strong>${lastResult.number}</strong>
        <p>${lastResult.qty} ${t("palletsReturned")} - ${lastResult.customer}</p>
        <button class="primary-button" data-action="new-pallet-return" type="button">${t("newPalletReturn")}</button>
      </section>
    `);
    return;
  }

  if (!selectedPalletCustomer) {
    const query = palletCustomerQuery.trim().toLowerCase();
    const matches = customers.filter((customer) => {
      const text = `${customer.name} ${customer.code} ${customer.salesOrders.join(" ")}`.toLowerCase();
      return !query || text.includes(query);
    });

    renderShell(t("palletReturn"), t("selectCustomerFirst"), `
      <section class="pallet-return-layout">
        <div class="customer-select-panel">
          <label>
            <span>${t("customerNameCode")}</span>
            <input id="customerSearch" class="search-input" value="${palletCustomerQuery}" placeholder="${t("typeCustomer")}" autocomplete="off" />
          </label>
          <div class="customer-suggestions">
            ${matches.map((customer) => `
              <button class="list-card" data-customer="${customer.code}" type="button">
                <strong>${customer.name}</strong>
                <span>${customer.code} - ${customer.salesOrders.join(", ")}</span>
              </button>
            `).join("") || `<div class="empty-state small"><strong>${t("noCustomerFound")}</strong><span>${t("tryCustomerCode")}</span></div>`}
          </div>
        </div>
        <aside class="manual-scan-panel">
          <p class="eyebrow">${t("salesOrderScanner")}</p>
          <h2>${t("scanSoNumber")}</h2>
          <div class="mini-scanner">SO</div>
          <input id="salesOrderInput" class="search-input" placeholder="SO-70018" />
          <button class="primary-button" data-action="scan-sales-order" type="button">${t("fakeScanSo")}</button>
          <button class="secondary-button" data-action="find-sales-order" type="button">${t("findBySo")}</button>
        </aside>
      </section>
    `);
    return;
  }

  renderShell(t("palletReturn"), t("customerSelectedQty"), `
    <section class="simple-form">
      <div class="selected-vendor-card">
        <span class="eyebrow">${t("customer")}</span>
        <strong>${selectedPalletCustomer.name}</strong>
        <span>${selectedPalletCustomer.code}</span>
        <button class="secondary-button" data-action="change-pallet-customer" type="button">${t("changeCustomer")}</button>
      </div>
      <label>
        <span>${t("palletsReturned")}</span>
        <input id="palletReturnQty" type="number" min="0" value="0" inputmode="numeric" />
      </label>
      <div class="form-actions">
        <button class="primary-button" data-action="confirm-pallet-return" type="button">${t("confirmReturn")}</button>
      </div>
    </section>
  `);
}

function renderDelivery() {
  const filtered = deliveryOrders
    .filter((order) => order.date === deliveryDate && !order.prepared)
    .sort((a, b) => a.due.localeCompare(b.due));

  renderShell(t("deliveryPrepTitle"), t("deliveryPrepSubtitle"), `
    <section class="delivery-layout">
      <div class="filter-row">
        <label>
          <span>${t("deliveryDate")}</span>
          <input id="deliveryDate" type="date" value="${deliveryDate}" />
        </label>
        <strong>${filtered.length} ${t("notPrepared")}</strong>
      </div>
      <div class="delivery-list">
        ${filtered.map((order) => `
          <button class="list-card delivery-card" data-delivery="${order.id}" type="button">
            <strong>${order.due} - ${order.id}</strong>
            <span>${order.customer} - ${order.skus.length} SKU</span>
          </button>
        `).join("") || `<div class="empty-state"><strong>${t("noDeliveryOrders")}</strong><span>${t("changeDate")}</span></div>`}
      </div>
    </section>
  `);
}

function lineStatus(sku) {
  const diff = activeMode === "outbound" || activeMode === "delivery"
    ? currentLayers(sku) - requiredLayers(sku)
    : loadedQty(sku) - sku.required;
  if (sku.confirmed && diff === 0) return { text: t("done"), cls: "" };
  if (sku.confirmed) return { text: t("adjusted"), cls: "warn" };
  if (diff < 0) return { text: t("short"), cls: "danger" };
  if (diff > 0) return { text: t("over"), cls: "warn" };
  return { text: t("ready"), cls: "" };
}

function renderWork() {
  const config = processCopy(activeMode);
  const isFulfillMode = activeMode === "outbound" || activeMode === "delivery";
  const totalRequired = activeOrder.skus.reduce((sum, sku) => sum + sku.required, 0);
  const totalLoaded = activeOrder.skus.reduce((sum, sku) => sum + loadedQty(sku), 0);
  const confirmed = activeOrder.skus.filter((sku) => sku.confirmed).length;
  const sku = activeOrder.skus[selectedSkuIndex];
  const diff = isFulfillMode ? requiredLayers(sku) - currentLayers(sku) : loadedQty(sku) - sku.required;

  renderShell(config.label, `${activeOrder.id} - ${activeOrder.customer}`, `
    <section class="summary-strip">
      <div><span class="metric-label">${t("progress")}</span><strong>${confirmed} / ${activeOrder.skus.length}</strong></div>
      <div><span class="metric-label">${t("required")}</span><strong>${formatQty(totalRequired)} plt</strong></div>
      <div><span class="metric-label">${config.unit}</span><strong>${formatQty(totalLoaded)} plt</strong></div>
      <div><span class="metric-label">${t("status")}</span><strong>${confirmed === activeOrder.skus.length ? t("ready") : t("open")}</strong></div>
    </section>
    <section class="operator-layout">
      <div class="sku-column">
        <div class="section-title"><span>${t("itemsInOrder")}</span><span>${t("tapAdjust")}</span></div>
        <div class="sku-list">
          ${activeOrder.skus.map((item, index) => {
            const itemLeftover = requiredLayers(item) - currentLayers(item);
            const itemDiff = isFulfillMode ? itemLeftover : loadedQty(item) - item.required;
            const status = lineStatus(item);
            return `
              <button class="sku-card ${index === selectedSkuIndex ? "active" : ""} ${item.confirmed ? "confirmed" : ""}" data-sku="${index}" type="button">
                <div class="sku-main">
                  <div>
                    <div class="sku-code">${item.code} - ${item.name}</div>
                    <div class="sku-meta">1 ${t("pallet")} = ${item.layerPerPallet} ${t("layer")} - 1 ${t("layer")} = ${item.casePerLayer} cases</div>
                  </div>
                  <span class="status-pill ${status.cls}">${status.text}</span>
                </div>
                <div class="sku-measures ${isFulfillMode ? "fulfill-measures" : ""}">
                  <div class="measure"><span class="metric-label">${t("required")}</span><b>${isFulfillMode ? formatSkuQty(item, activeMode, requiredLayers(item)) : `${formatQty(item.required)} plt`}</b></div>
                  <div class="measure"><span class="metric-label">${config.unit}</span><b>${formatSkuQty(item, activeMode)}</b></div>
                  ${isFulfillMode ? "" : `<div class="measure"><span class="metric-label">${t("details")}</span><b>${item.units.pallets}P ${item.units.layers}L ${item.units.cases}C</b></div>`}
                  <div class="measure"><span class="metric-label">${isFulfillMode ? t("leftover") : "Diff"}</span><b>${isFulfillMode ? formatPalletLayer(itemLeftover, item.layerPerPallet) : `${itemDiff > 0 ? "+" : ""}${formatQty(itemDiff)} plt`}</b></div>
                </div>
              </button>
            `;
          }).join("")}
        </div>
      </div>
      <aside class="adjust-panel">
        <div class="panel-header">
          <div>
            <p class="eyebrow">${t("selectedItem")}</p>
            <h2>${sku.name}</h2>
          </div>
          <span class="status-pill ${diff === 0 ? "" : diff < 0 ? "danger" : "warn"}">${sku.code}</span>
        </div>
        <div class="unit-grid">
          ${renderStepper("pallets", unitLabel("pallet"), sku.units.pallets)}
          ${renderStepper("layers", unitLabel("layer"), sku.units.layers)}
          ${isFulfillMode ? "" : renderStepper("cases", "Cases", sku.units.cases)}
        </div>
        <div class="conversion-card">
          <div><span class="metric-label">${t("required")}</span><strong>${isFulfillMode ? formatPalletLayer(requiredLayers(sku), sku.layerPerPallet) : `${formatQty(sku.required)} pallets`}</strong></div>
          <div><span class="metric-label">${config.selected}</span><strong>${isFulfillMode ? formatPalletLayer(currentLayers(sku), sku.layerPerPallet) : `${formatQty(loadedQty(sku))} pallets`}</strong></div>
          <div><span class="metric-label">${isFulfillMode ? t("leftover") : "Difference"}</span><strong class="${diff === 0 ? "ok-text" : diff < 0 ? "danger-text" : "warn-text"}">${isFulfillMode ? formatPalletLayer(diff, sku.layerPerPallet) : `${diff > 0 ? "+" : ""}${formatQty(diff)} pallets`}</strong></div>
        </div>
        <div class="action-grid">
          <button class="primary-button" data-action="confirm-line" type="button">${t("confirmLine")}</button>
        </div>
      </aside>
    </section>
  `, `
    <button class="secondary-button" data-action="scan-next" type="button">${t("scanItem")}</button>
    <button class="primary-button" data-action="complete" type="button">${config.complete}</button>
  `);
}

function renderStepper(field, label, value) {
  return `
    <label>
      <span>${label}</span>
      <div class="stepper">
        <button data-step="${field}" data-delta="-1" type="button">-</button>
        <input data-input="${field}" type="number" min="0" value="${value}" inputmode="numeric" />
        <button data-step="${field}" data-delta="1" type="button">+</button>
      </div>
    </label>
  `;
}

function updateUnit(field, value) {
  const sku = activeOrder.skus[selectedSkuIndex];
  const next = Math.max(0, Number(value) || 0);
  if (activeMode === "outbound" || activeMode === "delivery") {
    const draft = { ...sku.units, [field]: next, cases: 0 };
    let layerTotal = draft.pallets * sku.layerPerPallet + draft.layers;
    const maxLayers = requiredLayers(sku);
    if (layerTotal > maxLayers) {
      layerTotal = maxLayers;
      showToast(t("cannotOver"));
    }
    sku.units = {
      pallets: Math.floor(layerTotal / sku.layerPerPallet),
      layers: layerTotal % sku.layerPerPallet,
      cases: 0
    };
  } else {
    sku.units[field] = next;
  }
  sku.confirmed = false;
  render();
}

function render() {
  if (screen === "menu") renderMenu();
  if (screen === "outboundScan") renderScanner("outbound", t("outbound"), t("scanOrderSheet"));
  if (screen === "inbound") renderInboundVendors();
  if (screen === "returnType") renderReturnType();
  if (screen === "palletReturn") renderPalletReturn();
  if (screen === "productReturnScan") renderScanner("productReturn", t("productReturn"), t("productReturnText"));
  if (screen === "delivery") renderDelivery();
  if (screen === "work") renderWork();
  if (screen === "result") renderResult();
}

document.addEventListener("click", (event) => {
  const target = event.target.closest("button");
  if (!target) return;

  if (target.dataset.lang) {
    lang = target.dataset.lang;
    return render();
  }
  if (target.dataset.action === "menu") return goMenu();
  if (target.dataset.menu === "outbound") {
    screen = "outboundScan";
    return render();
  }
  if (target.dataset.menu === "inbound") {
    screen = "inbound";
    selectedVendor = null;
    poSearch = "";
    return render();
  }
  if (target.dataset.menu === "return") {
    screen = "returnType";
    return render();
  }
  if (target.dataset.menu === "delivery") {
    screen = "delivery";
    return render();
  }
  if (target.dataset.scan) return fakeScan(target.dataset.scan);
  if (target.dataset.vendor) {
    selectedVendor = Number(target.dataset.vendor);
    poSearch = "";
    return render();
  }
  if (target.dataset.pad) {
    if (target.dataset.pad === "Clear") poSearch = "";
    else if (target.dataset.pad === "Back") poSearch = poSearch.slice(0, -1);
    else poSearch += target.dataset.pad;
    return render();
  }
  if (target.dataset.po) {
    activeMode = "inbound";
    activeOrder = makeInboundOrder(target.dataset.po);
    selectedSkuIndex = 0;
    screen = "work";
    return render();
  }
  if (target.dataset.action === "reselect-vendor") {
    selectedVendor = null;
    poSearch = "";
    return render();
  }
  if (target.dataset.delivery) {
    activeMode = "delivery";
    activeOrder = prepareOrder(deliveryOrders.find((order) => order.id === target.dataset.delivery), "delivery");
    selectedSkuIndex = 0;
    screen = "work";
    return render();
  }
  if (target.dataset.returnType === "pallet") {
    selectedPalletCustomer = null;
    palletCustomerQuery = "";
    lastResult = null;
    screen = "palletReturn";
    return render();
  }
  if (target.dataset.returnType === "product") {
    screen = "productReturnScan";
    return render();
  }
  if (target.dataset.sku) {
    selectedSkuIndex = Number(target.dataset.sku);
    return render();
  }
  if (target.dataset.step) {
    const input = document.querySelector(`[data-input="${target.dataset.step}"]`);
    return updateUnit(target.dataset.step, Number(input.value) + Number(target.dataset.delta));
  }
  if (target.dataset.action === "confirm-line") {
    activeOrder.skus[selectedSkuIndex].confirmed = true;
    render();
    return showToast(t("lineConfirmed"));
  }
  if (target.dataset.action === "scan-next") {
    const next = activeOrder.skus.findIndex((sku) => !sku.confirmed);
    selectedSkuIndex = next >= 0 ? next : 0;
    render();
    return showToast(t("fakeOrderLoaded"));
  }
  if (target.dataset.action === "complete") {
    const open = activeOrder.skus.filter((sku) => !sku.confirmed).length;
    if (open) return showToast(`${open} ${t("itemStillOpen")}`);
    lastResult = {
      type: "fulfillment",
      number: `${activeMode === "delivery" ? "DP" : "SHIP"}-${Math.floor(100000 + Math.random() * 900000)}`,
      order: activeOrder,
      mode: activeMode
    };
    screen = "result";
    renderResult();
    return;
  }
  if (target.dataset.action === "scan-po") {
    poSearch = selectedVendor === 0 ? "45128" : vendors[selectedVendor].pos[0];
    render();
    return showToast(t("fakePoFilled"));
  }
  if (target.dataset.action === "manual-outbound") {
    const orderNumber = document.getElementById("manualOrderInput").value.trim() || "OUT-10482";
    activeMode = "outbound";
    activeOrder = prepareOrder({ ...orders.outbound[0], id: orderNumber }, "outbound");
    selectedSkuIndex = 0;
    screen = "work";
    render();
    return showToast(`${t("manualLoaded")} ${orderNumber}`);
  }
  if (target.dataset.customer) {
    selectedPalletCustomer = customers.find((customer) => customer.code === target.dataset.customer);
    palletCustomerQuery = selectedPalletCustomer.name;
    render();
    return showToast(`${selectedPalletCustomer.name} selected.`);
  }
  if (target.dataset.action === "scan-sales-order") {
    selectedPalletCustomer = customers[0];
    palletCustomerQuery = selectedPalletCustomer.name;
    render();
    return showToast(t("customerLoadedSo"));
  }
  if (target.dataset.action === "find-sales-order") {
    const so = document.getElementById("salesOrderInput").value.trim().toLowerCase();
    const customer = customers.find((item) => item.salesOrders.some((order) => order.toLowerCase() === so));
    if (!customer) return showToast(t("salesOrderNotFound"));
    selectedPalletCustomer = customer;
    palletCustomerQuery = customer.name;
    render();
    return showToast(`${customer.name} loaded from SO.`);
  }
  if (target.dataset.action === "change-pallet-customer") {
    selectedPalletCustomer = null;
    return render();
  }
  if (target.dataset.action === "new-pallet-return") {
    lastResult = null;
    selectedPalletCustomer = null;
    palletCustomerQuery = "";
    return render();
  }
  if (target.dataset.action === "confirm-pallet-return") {
    if (!selectedPalletCustomer) return showToast(t("selectCustomerFirstToast"));
    const customer = selectedPalletCustomer.name;
    const qty = document.getElementById("palletReturnQty").value || "0";
    lastResult = {
      type: "palletReturn",
      number: `RET-P-${Math.floor(100000 + Math.random() * 900000)}`,
      customer,
      qty
    };
    return renderPalletReturn();
  }
});

document.addEventListener("change", (event) => {
  if (event.target.dataset.input) updateUnit(event.target.dataset.input, event.target.value);
  if (event.target.id === "poSearch") {
    poSearch = event.target.value.replace(/\D/g, "");
    render();
  }
  if (event.target.id === "deliveryDate") {
    deliveryDate = event.target.value;
    render();
  }
});

document.addEventListener("input", (event) => {
  if (event.target.id === "customerSearch") {
    palletCustomerQuery = event.target.value;
    render();
    const input = document.getElementById("customerSearch");
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
});

function renderResult() {
  const order = lastResult.order;
  const mode = lastResult.mode;
  renderShell(mode === "delivery" ? t("deliveryPrepared") : t("shipmentComplete"), t("showFulfillment"), `
    <section class="result-screen">
      <span class="eyebrow">${t("fulfillmentNumber")}</span>
      <strong>${lastResult.number}</strong>
      <p>${order.id} - ${order.customer}</p>
      <div class="result-lines">
        ${order.skus.map((sku) => `
          <div class="result-line">
            <span>${sku.code} - ${sku.name}</span>
            <b>${formatPalletLayer(currentLayers(sku), sku.layerPerPallet)}</b>
          </div>
        `).join("")}
      </div>
      <button class="primary-button" data-action="menu" type="button">${t("backToMenu")}</button>
    </section>
  `);
}

render();
