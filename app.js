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
  { key: "delivery", title: "Delivery", text: "Scan load and confirm delivery", icon: "DEL" },
  { key: "cycleCount", title: "Inventory Control", text: "Count or report damaged stock", icon: "INV" },
  { key: "history", title: "Personal History", text: "Review and edit completed work", icon: "HIS" }
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
    history: "Personal History",
    cycleCount: "Inventory Control",
    outboundText: "Scan order and pick items",
    inboundText: "Choose vendor and PO",
    returnText: "Pallet or product return",
    deliveryText: "Prepare stock for driver pickup",
    historyText: "Review and edit completed work",
    cycleCountText: "Count or report damaged stock",
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
    searchPo: "Search PO",
    searchPoTop: "Search PO number",
    poSearchTopHint: "Search any open PO first. Selecting a PO opens it directly.",
    categories: "Categories",
    aggregate: "Aggregate",
    interlocking: "Interlocking",
    naturalStone: "Natural stone",
    accessory: "Accessory",
    chooseCategory: "Choose material type, then vendor.",
    chooseVendor: "Choose vendor",
    openPo: "Open POs",
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
    ordered: "Ordered",
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
    edit: "Edit",
    takePhoto: "Take photo",
    photoRequired: "Photo required",
    actualScenePhoto: "Actual scene photo",
    truckLeftPhoto: "Truck left side",
    truckRightPhoto: "Truck right side",
    finishWithPhotos: "Finish with photos",
    personalHistory: "Personal History",
    dateFilter: "Date filter",
    viewRecord: "View record",
    noHistory: "No history records",
    assignedCycleCount: "Assigned cycle count",
    selfRaisedCycleCount: "Self-raised cycle count",
    damageStock: "Damage Stock",
    chooseCycleType: "Choose cycle count type",
    countAssignedSku: "Count assigned SKU",
    chooseProductType: "Choose product type",
    chooseSeries: "Choose series",
    chooseSku: "Choose SKU",
    countQty: "Count quantity",
    submitCount: "Submit count",
    submitDamage: "Submit damage",
    reviewSummary: "Review summary",
    confirmSubmit: "Confirm submit",
    confirmedLines: "Confirmed lines",
    previous: "Previous",
    next: "Next",
    cannotOver: "Cannot fulfill more than the order quantity.",
    cannotReturnMore: "Cannot return more than ordered.",
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
    history: "个人历史",
    cycleCount: "库存控制",
    outboundText: "扫描订单并拣货",
    inboundText: "选择供应商和采购单",
    returnText: "托盘退回或商品退回",
    deliveryText: "为司机提货备货",
    historyText: "查看并编辑已完成作业",
    cycleCountText: "盘点或上报损坏库存",
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
    searchPo: "搜索采购单",
    searchPoTop: "搜索采购单号",
    poSearchTopHint: "先搜索任何未收货采购单，选择后直接打开。",
    categories: "分类",
    aggregate: "骨料",
    interlocking: "联锁砖",
    naturalStone: "天然石材",
    accessory: "配件",
    chooseCategory: "先选择物料类型，再选择供应商。",
    chooseVendor: "选择供应商",
    openPo: "未收货采购单",
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
    ordered: "已订购",
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
    edit: "编辑",
    takePhoto: "拍照",
    photoRequired: "需要拍照",
    actualScenePhoto: "现场照片",
    truckLeftPhoto: "卡车左侧",
    truckRightPhoto: "卡车右侧",
    finishWithPhotos: "带照片完成",
    personalHistory: "个人历史",
    dateFilter: "日期筛选",
    viewRecord: "查看记录",
    noHistory: "没有历史记录",
    assignedCycleCount: "指派盘点",
    selfRaisedCycleCount: "自发盘点",
    damageStock: "损坏库存",
    chooseCycleType: "选择盘点类型",
    countAssignedSku: "盘点指派SKU",
    chooseProductType: "选择产品类型",
    chooseSeries: "选择系列",
    chooseSku: "选择SKU",
    countQty: "盘点数量",
    submitCount: "提交盘点",
    submitDamage: "提交损坏",
    reviewSummary: "查看汇总",
    confirmSubmit: "确认提交",
    confirmedLines: "已确认行",
    previous: "上一页",
    next: "下一页",
    cannotOver: "不能超过订单数量。",
    cannotReturnMore: "不能超过已订购数量。",
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
    history: "個人歷史",
    cycleCount: "庫存控制",
    outboundText: "掃描訂單並揀貨",
    inboundText: "選擇供應商和採購單",
    returnText: "棧板退回或商品退回",
    deliveryText: "為司機提貨備貨",
    historyText: "查看並編輯已完成作業",
    cycleCountText: "盤點或上報損壞庫存",
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
    searchPo: "搜尋採購單",
    searchPoTop: "搜尋採購單號",
    poSearchTopHint: "先搜尋任何未收貨採購單，選擇後直接開啟。",
    categories: "分類",
    aggregate: "骨料",
    interlocking: "連鎖磚",
    naturalStone: "天然石材",
    accessory: "配件",
    chooseCategory: "先選擇物料類型，再選擇供應商。",
    chooseVendor: "選擇供應商",
    openPo: "未收貨採購單",
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
    ordered: "已訂購",
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
    edit: "編輯",
    takePhoto: "拍照",
    photoRequired: "需要拍照",
    actualScenePhoto: "現場照片",
    truckLeftPhoto: "卡車左側",
    truckRightPhoto: "卡車右側",
    finishWithPhotos: "帶照片完成",
    personalHistory: "個人歷史",
    dateFilter: "日期篩選",
    viewRecord: "查看記錄",
    noHistory: "沒有歷史記錄",
    assignedCycleCount: "指派盤點",
    selfRaisedCycleCount: "自發盤點",
    damageStock: "損壞庫存",
    chooseCycleType: "選擇盤點類型",
    countAssignedSku: "盤點指派SKU",
    chooseProductType: "選擇產品類型",
    chooseSeries: "選擇系列",
    chooseSku: "選擇SKU",
    countQty: "盤點數量",
    submitCount: "提交盤點",
    submitDamage: "提交損壞",
    reviewSummary: "查看彙總",
    confirmSubmit: "確認提交",
    confirmedLines: "已確認行",
    previous: "上一頁",
    next: "下一頁",
    cannotOver: "不能超過訂單數量。",
    cannotReturnMore: "不能超過已訂購數量。",
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
  { name: "Apex Aggregates", code: "V-1001", category: "aggregate", pos: ["45128", "45142", "45155"] },
  { name: "Bright Stone Supply", code: "V-1002", category: "naturalStone", pos: ["77201", "77204"] },
  { name: "Cedar Interlock", code: "V-1003", category: "interlocking", pos: ["66018", "66031"] },
  { name: "Delta Landscape", code: "V-1004", category: "accessory", pos: ["88300", "88319"] },
  { name: "Evergreen Aggregates", code: "V-1005", category: "aggregate", pos: ["51290", "51302"] },
  { name: "Freshline Accessories", code: "V-1006", category: "accessory", pos: ["34110", "34122"] },
  { name: "Golden Natural Stone", code: "V-1007", category: "naturalStone", pos: ["71930", "71944"] },
  { name: "Harbor Interlocking", code: "V-1008", category: "interlocking", pos: ["90412", "90413"] },
  { name: "Ironwood Aggregates", code: "V-1009", category: "aggregate", pos: ["22570", "22581"] },
  { name: "Jade Stone Market", code: "V-1010", category: "naturalStone", pos: ["11840", "11866"] },
  { name: "Keystone Pavers", code: "V-1011", category: "interlocking", pos: ["63820", "63821"] },
  { name: "Luma Yard Accessories", code: "V-1012", category: "accessory", pos: ["30319", "30320"] },
  { name: "Metro Aggregate", code: "V-1013", category: "aggregate", pos: ["49110", "49111"] },
  { name: "Northstar Stone", code: "V-1014", category: "naturalStone", pos: ["55510", "55598"] },
  { name: "Orchard Road Pavers", code: "V-1015", category: "interlocking", pos: ["24680", "24681"] }
];

const inboundCategories = ["aggregate", "interlocking", "naturalStone", "accessory"];

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
let itemPage = 0;
let selectedVendor = null;
let selectedInboundCategory = null;
let poSearch = "";
let deliveryDate = "2026-05-22";
let lastResult = null;
let palletCustomerQuery = "";
let selectedPalletCustomer = null;
let pendingCompletion = null;
let historyRecords = [];
let viewingRecord = null;
let editingRecordId = null;
let historyDate = new Date().toISOString().slice(0, 10);
let cycleMode = null;
let cycleProductType = null;
let cycleVendor = null;
let cycleSeriesChoice = null;
let cyclePage = 0;
let cycleDraft = null;
const PAGE_SIZE = 3;
const CYCLE_PAGE_SIZE = 4;
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
    delivery: { label: t("deliveryPrep"), complete: t("readyForDriver"), unit: t("fulfilling"), selected: t("currentFulfilling") },
    cycleCount: { label: t("cycleCount"), complete: t("done"), unit: t("countQty"), selected: t("countQty") }
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
  itemPage = 0;
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
        <div class="topbar-language">${languageSwitcher()}</div>
        <div class="topbar-actions">${actions}</div>
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
    delivery: [t("delivery"), t("deliveryText")],
    history: [t("history"), t("historyText")],
    cycleCount: [t("cycleCount"), t("cycleCountText")]
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
        <div></div>
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
  ` : mode === "productReturn" ? `
    <aside class="manual-scan-panel">
      <p class="eyebrow">${t("scannerNotWorking")}</p>
      <h2>${t("scanSoNumber")}</h2>
      <input id="manualProductReturnInput" class="search-input" value="SO-70018" placeholder="SO-70018" />
      <button class="primary-button" data-action="manual-product-return" type="button">${t("openOrder")}</button>
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
  const searchPanel = renderInboundPoSearch();
  if (selectedVendor !== null) {
    const vendor = vendors[selectedVendor];
    renderShell(t("inbound"), t("vendorSelected"), `
      ${searchPanel}
      <section class="po-focus-layout">
        <div class="selected-vendor-card">
          <span class="eyebrow">${t("vendor")}</span>
          <strong>${vendor.name}</strong>
          <span>${vendor.code}</span>
          <button class="secondary-button" data-action="reselect-vendor" type="button">${t("reselectVendor")}</button>
        </div>
        <aside class="lookup-panel po-list-panel">
          <p class="eyebrow">${t("openPo")}</p>
          <h2>${vendor.name}</h2>
          <div class="po-list">
            ${vendor.pos.map((po) => `
              <button class="po-card" data-po="${po}" type="button">
                <strong>PO ${po}</strong>
                <span>${vendor.code}</span>
              </button>
            `).join("")}
          </div>
        </aside>
      </section>
    `);
    return;
  }

  const categoryBody = selectedInboundCategory === null
    ? `<section class="choice-grid inbound-category-grid">
        ${inboundCategories.map((category) => `
          <button class="choice-card" data-inbound-category="${category}" type="button">
            <strong>${t(category)}</strong>
            <span>${vendors.filter((vendor) => vendor.category === category).length} ${t("vendor")}</span>
          </button>
        `).join("")}
      </section>`
    : `<section class="vendor-layout single-column">
        <div class="section-title"><span>${t(selectedInboundCategory)}</span><span>${t("chooseVendor")}</span></div>
        <div class="vendor-list">
          ${vendors.map((vendor, index) => ({ vendor, index })).filter((item) => item.vendor.category === selectedInboundCategory).map(({ vendor, index }) => `
            <button class="list-card" data-vendor="${index}" type="button">
              <strong>${vendor.name}</strong>
              <span>${vendor.code} - ${vendor.pos.length} ${t("openPo")}</span>
            </button>
          `).join("")}
        </div>
      </section>`;

  renderShell(t("inbound"), t("chooseCategory"), `
    ${searchPanel}
    ${categoryBody}
  `);
}

function renderInboundPoSearch() {
  const matches = poSearch
    ? vendors.flatMap((vendor, vendorIndex) => vendor.pos
        .filter((po) => po.includes(poSearch))
        .map((po) => ({ po, vendor, vendorIndex })))
    : [];

  return `
    <section class="po-search-sticky">
      <div>
        <p class="eyebrow">${t("searchPo")}</p>
        <h2>${t("searchPoTop")}</h2>
        <p class="subtle">${t("poSearchTopHint")}</p>
      </div>
      <input class="search-input" id="poSearch" value="${poSearch}" placeholder="${t("poNumber")}" inputmode="numeric" />
      ${poSearch ? `
        <div class="po-autocomplete">
          ${matches.map(({ po, vendor }) => `
            <button class="po-card compact" data-po="${po}" type="button">
              <strong>PO ${po}</strong>
              <span>${vendor.name} - ${vendor.code}</span>
            </button>
          `).join("") || `<div class="empty-state small"><strong>${t("noMatch")}</strong><span>${t("scanPaperPo")}</span></div>`}
        </div>
      ` : ""}
    </section>
  `;
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
  const vendor = vendors[selectedVendor] || vendors.find((item) => item.pos.includes(po)) || vendors[0];
  return prepareOrder({
    id: `PO-${po}`,
    customer: vendor.name,
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
        <aside class="manual-scan-panel sales-order-panel">
          <p class="eyebrow">${t("salesOrderScanner")}</p>
          <h2>${t("scanSoNumber")}</h2>
          <div class="scanner-frame embedded-scanner">
            <div class="scan-corners"></div>
            <strong>${t("scanSoNumber")}</strong>
            <span>${t("cameraArea")}</span>
          </div>
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

function requiredPhotoLabels(mode) {
  if (mode === "inbound") return [t("truckLeftPhoto"), t("truckRightPhoto")];
  if (mode === "outbound" || mode === "delivery") return [t("actualScenePhoto")];
  return [];
}

function renderPhotoCapture() {
  const labels = pendingCompletion?.photos || [];
  renderShell(t("photoRequired"), pendingCompletion.order.id, `
    <section class="photo-capture-screen">
      ${labels.map((label, index) => `
        <div class="photo-card ${pendingCompletion.captured[index] ? "captured" : ""}">
          <span class="eyebrow">${label}</span>
          <div class="photo-preview">${pendingCompletion.captured[index] ? "OK" : "PHOTO"}</div>
          <button class="primary-button" data-photo-index="${index}" type="button">${t("takePhoto")}</button>
        </div>
      `).join("")}
      <button class="primary-button" data-action="finish-photos" type="button" ${pendingCompletion.captured.every(Boolean) ? "" : "disabled"}>${t("finishWithPhotos")}</button>
    </section>
  `);
}

function createCompletionRecord(mode, order, photos = []) {
  return {
    id: `${mode.toUpperCase()}-${Math.floor(100000 + Math.random() * 900000)}`,
    mode,
    order: structuredClone(order),
    photos,
    date: new Date().toISOString().slice(0, 10),
    time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  };
}

function completeWithRecord(record) {
  if (editingRecordId) {
    record.id = editingRecordId;
    const index = historyRecords.findIndex((item) => item.id === editingRecordId);
    if (index >= 0) historyRecords[index] = record;
    else historyRecords.unshift(record);
    editingRecordId = null;
  } else {
    historyRecords.unshift(record);
  }
  lastResult = {
    type: "fulfillment",
    number: record.id,
    order: record.order,
    mode: record.mode,
    record
  };
  viewingRecord = record;
  screen = "result";
  renderResult();
}

function renderHistory() {
  const records = historyRecords.filter((record) => !historyDate || record.date === historyDate);
  renderShell(t("personalHistory"), t("historyText"), `
    <section class="history-screen">
      <div class="filter-row">
        <label>
          <span>${t("dateFilter")}</span>
          <input id="historyDate" type="date" value="${historyDate}" />
        </label>
        <strong>${records.length}</strong>
      </div>
      <div class="history-list">
        ${records.map((record) => `
          <button class="list-card" data-history-id="${record.id}" type="button">
            <strong>${record.time} - ${record.id}</strong>
            <span>${processCopy(record.mode).label} - ${record.order.customer}</span>
          </button>
        `).join("") || `<div class="empty-state"><strong>${t("noHistory")}</strong><span>${historyDate}</span></div>`}
      </div>
    </section>
  `);
}

function renderHistoryView() {
  const record = viewingRecord;
  if (!record) return renderHistory();
  lastResult = {
    type: "fulfillment",
    number: record.id,
    order: record.order,
    mode: record.mode,
    record
  };
  renderResult();
}

const cycleSeriesOptions = {
  aggregate: ["Granite", "Limestone", "River Rock"],
  interlocking: ["Classic", "Modern", "Permeable"],
  naturalStone: ["Flagstone", "Coping", "Slab"],
  accessory: ["Edge", "Sand", "Sealant"]
};

function renderCycleCount() {
  if (!cycleMode) {
    renderShell(t("cycleCount"), t("chooseCycleType"), `
      <section class="choice-grid">
        <button class="choice-card" data-cycle-mode="assigned" type="button">
          <strong>${t("assignedCycleCount")}</strong>
          <span>${t("countAssignedSku")}</span>
        </button>
        <button class="choice-card" data-cycle-mode="self" type="button">
          <strong>${t("selfRaisedCycleCount")}</strong>
          <span>${t("chooseProductType")}</span>
        </button>
        <button class="choice-card" data-cycle-mode="damage" type="button">
          <strong>${t("damageStock")}</strong>
          <span>${t("chooseProductType")}</span>
        </button>
      </section>
    `);
    return;
  }

  if (cycleMode === "assigned") {
    const assigned = orders.outbound[0].skus.slice(0, 5);
    renderShell(t("assignedCycleCount"), t("countAssignedSku"), `
      <section class="cycle-list">
        ${renderPaginatedCycleRows(assigned, false)}
      </section>
    `);
    return;
  }

  if (!cycleProductType) {
    renderShell(cycleMode === "damage" ? t("damageStock") : t("selfRaisedCycleCount"), t("chooseProductType"), `
      <section class="cycle-step-actions">
        <button class="secondary-button step-back-button" data-action="cycle-back-mode" type="button">${t("previous")} - ${t("cycleCount")}</button>
      </section>
      <section class="choice-grid">
        ${inboundCategories.map((category) => `
          <button class="choice-card" data-cycle-product="${category}" type="button">
            <strong>${t(category)}</strong>
            <span>${t("chooseVendor")}</span>
          </button>
        `).join("")}
      </section>
    `);
    return;
  }

  if (!cycleVendor) {
    const related = vendors.filter((vendor) => vendor.category === cycleProductType);
    renderShell(cycleMode === "damage" ? t("damageStock") : t("selfRaisedCycleCount"), t("chooseVendor"), `
      <section class="vendor-layout single-column">
        <button class="secondary-button step-back-button" data-action="cycle-back-product" type="button">${t("previous")} - ${t("chooseProductType")}</button>
        <div class="vendor-list">
          ${related.map((vendor) => `
            <button class="list-card" data-cycle-vendor="${vendor.code}" type="button">
              <strong>${vendor.name}</strong>
              <span>${vendor.code}</span>
            </button>
          `).join("")}
        </div>
      </section>
    `);
    return;
  }

  const seriesList = cycleSeriesOptions[cycleProductType] || [];
  if (!cycleSeriesChoice) {
    renderShell(cycleMode === "damage" ? t("damageStock") : t("selfRaisedCycleCount"), t("chooseSeries"), `
      <section class="cycle-step-actions">
        <button class="secondary-button step-back-button" data-action="cycle-back-vendor" type="button">${t("previous")} - ${t("chooseVendor")}</button>
      </section>
      <section class="choice-grid">
        ${seriesList.map((series) => `
          <button class="choice-card" data-cycle-series="${series}" type="button">
            <strong>${series}</strong>
            <span>${t("chooseSku")}</span>
          </button>
        `).join("")}
      </section>
    `);
    return;
  }

  const skuList = orders.outbound[0].skus;
  renderShell(cycleMode === "damage" ? t("damageStock") : t("selfRaisedCycleCount"), t("chooseSku"), `
    <section class="cycle-step-actions">
      <button class="secondary-button step-back-button" data-action="cycle-back-series" type="button">${t("previous")} - ${t("chooseSeries")}</button>
    </section>
    <section class="cycle-list">
      ${renderPaginatedCycleRows(skuList, cycleMode === "damage")}
    </section>
  `);
}

function renderPaginatedCycleRows(skus, isDamage) {
  const pageCount = Math.max(1, Math.ceil(skus.length / CYCLE_PAGE_SIZE));
  cyclePage = Math.min(cyclePage, pageCount - 1);
  const start = cyclePage * CYCLE_PAGE_SIZE;
  const pageSkus = skus.slice(start, start + CYCLE_PAGE_SIZE);
  return `
    ${pageSkus.map((sku) => renderCycleCountRow(sku, isDamage)).join("")}
    <div class="pagination-row">
      <button class="secondary-button" data-action="cycle-page-prev" type="button" ${cyclePage === 0 ? "disabled" : ""}>${t("previous")}</button>
      <strong>${cyclePage + 1} / ${pageCount}</strong>
      <button class="secondary-button" data-action="cycle-page-next" type="button" ${cyclePage >= pageCount - 1 ? "disabled" : ""}>${t("next")}</button>
    </div>
    <div class="cycle-submit-row">
      <strong>${cycleDraft ? cycleDraft.lines.length : 0} ${t("done")}</strong>
      <button class="primary-button" data-action="review-cycle-batch" type="button">${t("reviewSummary")}</button>
    </div>
  `;
}

function renderCycleCountRow(sku, isDamage) {
  const saved = cycleDraft?.lines.find((line) => line.code === sku.code);
  return `
    <div class="cycle-row ${saved ? "confirmed" : ""}" data-cycle-sku="${sku.code}" data-cycle-name="${sku.name}">
      <div><strong>${sku.code}</strong><span>${sku.name}</span></div>
      <label><span>${unitLabel("pallet")}</span><input data-cycle-unit="pallets" type="number" min="0" value="${saved?.pallets || 0}" inputmode="numeric" /></label>
      <label><span>${unitLabel("layer")}</span><input data-cycle-unit="layers" type="number" min="0" value="${saved?.layers || 0}" inputmode="numeric" /></label>
      <button class="primary-button" data-action="confirm-cycle-line" type="button">${t("confirmLine")}</button>
    </div>
  `;
}

function renderCycleSummary() {
  const isDamage = cycleDraft?.mode === "damage";
  const title = isDamage ? t("damageStock") : t("selfRaisedCycleCount");
  renderShell(title, t("reviewSummary"), `
    <section class="result-screen">
      <span class="eyebrow">${t("confirmedLines")}</span>
      <strong>${cycleDraft?.lines.length || 0}</strong>
      <div class="result-lines">
        ${(cycleDraft?.lines || []).map((line) => `
          <div class="result-line">
            <span>${line.code} - ${line.name}</span>
            <b>${line.pallets}P ${line.layers}L</b>
          </div>
        `).join("") || `<div class="empty-state small"><strong>0</strong><span>${t("confirmedLines")}</span></div>`}
      </div>
      <button class="secondary-button" data-action="cycle-summary-back" type="button">${t("edit")}</button>
      <button class="primary-button" data-action="submit-cycle-batch" type="button">${t("confirmSubmit")}</button>
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
  const pageCount = Math.max(1, Math.ceil(activeOrder.skus.length / PAGE_SIZE));
  itemPage = Math.min(itemPage, pageCount - 1);
  const pageStart = itemPage * PAGE_SIZE;
  const pageItems = activeOrder.skus.slice(pageStart, pageStart + PAGE_SIZE);
  const diff = isFulfillMode
    ? requiredLayers(sku) - currentLayers(sku)
    : activeMode === "productReturn"
      ? sku.required - loadedQty(sku)
      : loadedQty(sku) - sku.required;

  renderShell(config.label, `${activeOrder.id} - ${activeOrder.customer}`, `
    <section class="summary-strip">
      <div><span class="metric-label">${t("progress")}</span><strong>${confirmed} / ${activeOrder.skus.length}</strong></div>
      <div><span class="metric-label">${activeMode === "productReturn" ? t("ordered") : t("required")}</span><strong>${formatQty(totalRequired)} plt</strong></div>
      <div><span class="metric-label">${config.unit}</span><strong>${formatQty(totalLoaded)} plt</strong></div>
      <div><span class="metric-label">${t("status")}</span><strong>${confirmed === activeOrder.skus.length ? t("ready") : t("open")}</strong></div>
    </section>
    <section class="operator-layout">
      <div class="sku-column">
        <div class="section-title"><span>${t("itemsInOrder")}</span><span>${t("tapAdjust")}</span></div>
        <div class="sku-list">
          ${pageItems.map((item, localIndex) => {
            const index = pageStart + localIndex;
            const itemLeftover = requiredLayers(item) - currentLayers(item);
            const itemDiff = isFulfillMode
              ? itemLeftover
              : activeMode === "productReturn"
                ? item.required - loadedQty(item)
                : loadedQty(item) - item.required;
            const status = lineStatus(item);
            const useThreeMeasureLayout = isFulfillMode || activeMode === "productReturn";
            const firstLabel = activeMode === "productReturn" ? t("ordered") : t("required");
            const thirdLabel = isFulfillMode ? t("leftover") : activeMode === "productReturn" ? t("leftover") : "Diff";
            const thirdValue = isFulfillMode
              ? formatPalletLayer(itemLeftover, item.layerPerPallet)
              : `${itemDiff > 0 && activeMode !== "productReturn" ? "+" : ""}${formatQty(itemDiff)} plt`;
            return `
              <button class="sku-card ${index === selectedSkuIndex ? "active" : ""} ${item.confirmed ? "confirmed" : ""}" data-sku="${index}" type="button">
                <div class="sku-main">
                  <div>
                    <div class="sku-code">${item.code} - ${item.name}</div>
                    <div class="sku-meta">1 ${t("pallet")} = ${item.layerPerPallet} ${t("layer")} - 1 ${t("layer")} = ${item.casePerLayer} cases</div>
                  </div>
                  <span class="status-pill ${status.cls}">${status.text}</span>
                </div>
                <div class="sku-measures ${useThreeMeasureLayout ? "fulfill-measures" : ""}">
                  <div class="measure"><span class="metric-label">${firstLabel}</span><b>${isFulfillMode ? formatSkuQty(item, activeMode, requiredLayers(item)) : `${formatQty(item.required)} plt`}</b></div>
                  <div class="measure"><span class="metric-label">${config.unit}</span><b>${formatSkuQty(item, activeMode)}</b></div>
                  ${useThreeMeasureLayout ? "" : `<div class="measure"><span class="metric-label">${t("details")}</span><b>${item.units.pallets}P ${item.units.layers}L ${item.units.cases}C</b></div>`}
                  <div class="measure"><span class="metric-label">${thirdLabel}</span><b>${thirdValue}</b></div>
                </div>
              </button>
            `;
          }).join("")}
        </div>
        <div class="pagination-row">
          <button class="secondary-button" data-action="page-prev" type="button" ${itemPage === 0 ? "disabled" : ""}>${t("previous")}</button>
          <strong>${itemPage + 1} / ${pageCount}</strong>
          <button class="secondary-button" data-action="page-next" type="button" ${itemPage >= pageCount - 1 ? "disabled" : ""}>${t("next")}</button>
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
          <div><span class="metric-label">${activeMode === "productReturn" ? t("ordered") : t("required")}</span><strong>${isFulfillMode ? formatPalletLayer(requiredLayers(sku), sku.layerPerPallet) : `${formatQty(sku.required)} pallets`}</strong></div>
          <div><span class="metric-label">${config.selected}</span><strong>${isFulfillMode ? formatPalletLayer(currentLayers(sku), sku.layerPerPallet) : `${formatQty(loadedQty(sku))} pallets`}</strong></div>
          <div><span class="metric-label">${isFulfillMode || activeMode === "productReturn" ? t("leftover") : "Difference"}</span><strong class="${diff === 0 ? "ok-text" : diff < 0 ? "danger-text" : "warn-text"}">${isFulfillMode ? formatPalletLayer(diff, sku.layerPerPallet) : `${diff > 0 && activeMode !== "productReturn" ? "+" : ""}${formatQty(diff)} pallets`}</strong></div>
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
  } else if (activeMode === "productReturn") {
    const draft = { ...sku.units, [field]: next };
    let caseTotal = draft.pallets * sku.layerPerPallet * sku.casePerLayer + draft.layers * sku.casePerLayer + draft.cases;
    const maxCases = sku.required * sku.layerPerPallet * sku.casePerLayer;
    if (caseTotal > maxCases) {
      caseTotal = maxCases;
      showToast(t("cannotReturnMore"));
    }
    const pallets = Math.floor(caseTotal / (sku.layerPerPallet * sku.casePerLayer));
    const afterPalletCases = caseTotal % (sku.layerPerPallet * sku.casePerLayer);
    sku.units = {
      pallets,
      layers: Math.floor(afterPalletCases / sku.casePerLayer),
      cases: afterPalletCases % sku.casePerLayer
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
  if (screen === "photoCapture") renderPhotoCapture();
  if (screen === "history") renderHistory();
  if (screen === "historyView") renderHistoryView();
  if (screen === "cycleCount") renderCycleCount();
  if (screen === "cycleSummary") renderCycleSummary();
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
    selectedInboundCategory = null;
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
  if (target.dataset.menu === "history") {
    screen = "history";
    return render();
  }
  if (target.dataset.menu === "cycleCount") {
    screen = "cycleCount";
    cycleMode = null;
    cycleProductType = null;
    cycleVendor = null;
    cycleSeriesChoice = null;
    cyclePage = 0;
    cycleDraft = null;
    return render();
  }
  if (target.dataset.scan) return fakeScan(target.dataset.scan);
  if (target.dataset.inboundCategory) {
    selectedInboundCategory = target.dataset.inboundCategory;
    selectedVendor = null;
    return render();
  }
  if (target.dataset.vendor) {
    selectedVendor = Number(target.dataset.vendor);
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
    const vendorIndex = vendors.findIndex((vendor) => vendor.pos.includes(target.dataset.po));
    if (vendorIndex >= 0) selectedVendor = vendorIndex;
    activeOrder = makeInboundOrder(target.dataset.po);
    selectedSkuIndex = 0;
    itemPage = 0;
    screen = "work";
    return render();
  }
  if (target.dataset.action === "reselect-vendor") {
    selectedVendor = null;
    return render();
  }
  if (target.dataset.delivery) {
    activeMode = "delivery";
    activeOrder = prepareOrder(deliveryOrders.find((order) => order.id === target.dataset.delivery), "delivery");
    selectedSkuIndex = 0;
    itemPage = 0;
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
  if (target.dataset.action === "page-prev") {
    itemPage = Math.max(0, itemPage - 1);
    selectedSkuIndex = itemPage * PAGE_SIZE;
    return render();
  }
  if (target.dataset.action === "page-next") {
    const pageCount = Math.max(1, Math.ceil(activeOrder.skus.length / PAGE_SIZE));
    itemPage = Math.min(pageCount - 1, itemPage + 1);
    selectedSkuIndex = itemPage * PAGE_SIZE;
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
    itemPage = Math.floor(selectedSkuIndex / PAGE_SIZE);
    render();
    return showToast(t("fakeOrderLoaded"));
  }
  if (target.dataset.action === "complete") {
    const open = activeOrder.skus.filter((sku) => !sku.confirmed).length;
    if (open) return showToast(`${open} ${t("itemStillOpen")}`);
    const photos = requiredPhotoLabels(activeMode);
    if (photos.length) {
      pendingCompletion = {
        mode: activeMode,
        order: structuredClone(activeOrder),
        photos,
        captured: photos.map(() => false)
      };
      screen = "photoCapture";
      render();
      return;
    }
    completeWithRecord(createCompletionRecord(activeMode, activeOrder));
    return;
  }
  if (target.dataset.photoIndex) {
    pendingCompletion.captured[Number(target.dataset.photoIndex)] = true;
    return render();
  }
  if (target.dataset.action === "finish-photos") {
    if (!pendingCompletion.captured.every(Boolean)) return;
    const record = createCompletionRecord(pendingCompletion.mode, pendingCompletion.order, pendingCompletion.photos);
    pendingCompletion = null;
    completeWithRecord(record);
    return;
  }
  if (target.dataset.action === "edit-record") {
    const record = lastResult?.record || viewingRecord;
    if (!record) return;
    if (record.mode === "cycleCount" && record.inventoryType !== "damage") return;
    if (record.mode === "cycleCount" && record.inventoryType === "damage") {
      cycleMode = "damage";
      cycleProductType = "aggregate";
      cycleVendor = record.order.customer;
      cycleSeriesChoice = "Granite";
      cycleDraft = {
        id: `${record.id}-EDIT`,
        mode: "damage",
        lines: structuredClone(record.order.skus || [])
      };
      editingRecordId = record.id;
      screen = "cycleCount";
      return render();
    }
    editingRecordId = record.id;
    activeMode = record.mode;
    activeOrder = structuredClone(record.order);
    selectedSkuIndex = 0;
    itemPage = 0;
    screen = "work";
    return render();
  }
  if (target.dataset.historyId) {
    viewingRecord = historyRecords.find((record) => record.id === target.dataset.historyId);
    screen = "historyView";
    return render();
  }
  if (target.dataset.cycleMode) {
    cycleMode = target.dataset.cycleMode;
    cycleProductType = null;
    cycleVendor = null;
    cycleSeriesChoice = null;
    cyclePage = 0;
    cycleDraft = {
      id: `${cycleMode === "damage" ? "DMG" : "CC"}-TEMP-${Math.floor(1000 + Math.random() * 9000)}`,
      mode: target.dataset.cycleMode,
      lines: []
    };
    return render();
  }
  if (target.dataset.cycleProduct) {
    cycleProductType = target.dataset.cycleProduct;
    cycleVendor = null;
    cycleSeriesChoice = null;
    cyclePage = 0;
    return render();
  }
  if (target.dataset.cycleVendor) {
    cycleVendor = target.dataset.cycleVendor;
    cycleSeriesChoice = null;
    cyclePage = 0;
    return render();
  }
  if (target.dataset.cycleSeries) {
    cycleSeriesChoice = target.dataset.cycleSeries;
    cyclePage = 0;
    return render();
  }
  if (target.dataset.action === "cycle-back-product") {
    cycleProductType = null;
    cycleVendor = null;
    cycleSeriesChoice = null;
    cyclePage = 0;
    return render();
  }
  if (target.dataset.action === "cycle-back-mode") {
    cycleMode = null;
    cycleProductType = null;
    cycleVendor = null;
    cycleSeriesChoice = null;
    cyclePage = 0;
    cycleDraft = null;
    return render();
  }
  if (target.dataset.action === "cycle-back-vendor") {
    cycleVendor = null;
    cycleSeriesChoice = null;
    cyclePage = 0;
    return render();
  }
  if (target.dataset.action === "cycle-back-series") {
    cycleSeriesChoice = null;
    cyclePage = 0;
    return render();
  }
  if (target.dataset.action === "cycle-page-prev") {
    cyclePage = Math.max(0, cyclePage - 1);
    return render();
  }
  if (target.dataset.action === "cycle-page-next") {
    cyclePage += 1;
    return render();
  }
  if (target.dataset.action === "review-cycle-batch") {
    screen = "cycleSummary";
    return render();
  }
  if (target.dataset.action === "cycle-summary-back") {
    screen = "cycleCount";
    return render();
  }
  if (target.dataset.action === "confirm-cycle-line") {
    const isDamage = cycleMode === "damage";
    if (!cycleDraft) cycleDraft = { id: `${isDamage ? "DMG" : "CC"}-TEMP`, mode: cycleMode, lines: [] };
    const row = target.closest(".cycle-row");
    const line = {
      code: row.dataset.cycleSku,
      name: row.dataset.cycleName,
      pallets: Number(row.querySelector('[data-cycle-unit="pallets"]').value) || 0,
      layers: Number(row.querySelector('[data-cycle-unit="layers"]').value) || 0
    };
    const index = cycleDraft.lines.findIndex((item) => item.code === line.code);
    if (index >= 0) cycleDraft.lines[index] = line;
    else cycleDraft.lines.push(line);
    showToast(t("lineConfirmed"));
    return render();
  }
  if (target.dataset.action === "submit-cycle-batch") {
    const isDamage = cycleMode === "damage";
    const record = createCompletionRecord("cycleCount", {
      id: isDamage ? "DAMAGE" : "CYCLE",
      customer: cycleVendor || "Assigned",
      skus: structuredClone(cycleDraft?.lines || [])
    });
    record.id = `${isDamage ? "DMG" : "CC"}-${Math.floor(100000 + Math.random() * 900000)}`;
    record.inventoryType = isDamage ? "damage" : "cycle";
    record.canEdit = isDamage;
    if (editingRecordId) {
      record.id = editingRecordId;
      const index = historyRecords.findIndex((item) => item.id === editingRecordId);
      if (index >= 0) historyRecords[index] = record;
      else historyRecords.unshift(record);
      editingRecordId = null;
    } else {
      historyRecords.unshift(record);
    }
    cycleDraft = null;
    showToast(`${record.id} ${t("done")}`);
    screen = "menu";
    return render();
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
    itemPage = 0;
    screen = "work";
    render();
    return showToast(`${t("manualLoaded")} ${orderNumber}`);
  }
  if (target.dataset.action === "manual-product-return") {
    const soNumber = document.getElementById("manualProductReturnInput").value.trim() || "SO-70018";
    activeMode = "productReturn";
    activeOrder = prepareOrder({ ...orders.productReturn[0], id: soNumber }, "productReturn");
    selectedSkuIndex = 0;
    itemPage = 0;
    screen = "work";
    render();
    return showToast(`${t("manualLoaded")} ${soNumber}`);
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
  if (event.target.id === "historyDate") {
    historyDate = event.target.value;
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
  if (event.target.id === "poSearch") {
    poSearch = event.target.value.replace(/\D/g, "");
    render();
    const input = document.getElementById("poSearch");
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
});

function renderResult() {
  const order = lastResult.order;
  const mode = lastResult.mode;
  const lines = order.skus || [];
  renderShell(mode === "delivery" ? t("deliveryPrepared") : t("shipmentComplete"), t("showFulfillment"), `
    <section class="result-screen">
      <span class="eyebrow">${t("fulfillmentNumber")}</span>
      <strong>${lastResult.number}</strong>
      <p>${order.id} - ${order.customer}</p>
      <div class="result-lines">
        ${lines.map((sku) => `
          <div class="result-line">
            <span>${sku.code} - ${sku.name}</span>
            <b>${sku.layerPerPallet ? formatPalletLayer(currentLayers(sku), sku.layerPerPallet) : `${sku.pallets || 0}P ${sku.layers || 0}L`}</b>
          </div>
        `).join("")}
      </div>
      ${lastResult.record?.canEdit !== false ? `<button class="secondary-button" data-action="edit-record" type="button">${t("edit")}</button>` : ""}
      <button class="primary-button" data-action="menu" type="button">${t("backToMenu")}</button>
    </section>
  `);
}

render();
