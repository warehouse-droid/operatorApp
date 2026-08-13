const salesDeliveryInstructionApp = document.getElementById("salesDeliveryInstructionApp");
const deliveryInstructionT = (key, fallback) => window.MBBS_I18N?.t(key, fallback) || fallback;

const salesDeliveryInstructionState = {
  operator: null,
  orders: [],
  selectedId: Number(localStorage.getItem("mbbs.sales.deliveryInstructions.selected")) || null,
  detail: null,
  search: "",
  loadingList: true,
  loadingDetail: false,
  saving: false,
  error: "",
  notice: "",
  searchTimer: null,
  listGeneration: 0
};

function deliveryInstructionEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[character]));
}

function deliveryInstructionDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value).slice(0, 10) || "—";
  return new Intl.DateTimeFormat(window.MBBS_I18N?.language?.() === "zh-CN" ? "zh-CN" : "en-CA", {
    dateStyle: "medium"
  }).format(date);
}

function deliveryInstructionBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function salesDeliveryInstructionApi(path, options = {}) {
  const response = await fetch(path, {
    cache: "no-store",
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    const error = new Error(payload?.error || payload || `Request failed (${response.status})`);
    error.status = response.status;
    error.code = payload?.code || "";
    throw error;
  }
  return payload;
}

function deliveryInstructionContentUrl(media) {
  const base = String(media?.contentUrl || `/api/delivery-instruction-media/${encodeURIComponent(media?.id || "")}/content`);
  if (!dispatchAuthToken) return base;
  return `${base}${base.includes("?") ? "&" : "?"}token=${encodeURIComponent(dispatchAuthToken)}`;
}

function salesDeliveryInstructionShell() {
  const operator = salesDeliveryInstructionState.operator || {};
  salesDeliveryInstructionApp.innerHTML = `
    <header class="dispatch-topbar">
      <div><p>${deliveryInstructionEscape(deliveryInstructionT("deliveryInstruction.salesEyebrow", "Sales · Delivery"))}</p><h1>${deliveryInstructionEscape(deliveryInstructionT("deliveryInstruction.title", "Delivery Instructions"))}</h1></div>
      <div class="topbar-language">${window.MBBS_I18N?.toggleHtml?.() || ""}</div>
      <div class="topbar-actions">
        <span class="dispatch-user">${deliveryInstructionEscape(operator.display_name || operator.username || "")}</span>
        <button onclick="location.href='/sales'" type="button">${deliveryInstructionEscape(deliveryInstructionT("deliveryInstruction.salesMenu", "Sales Menu"))}</button>
        <button onclick="dispatchLogout()" type="button">${deliveryInstructionEscape(deliveryInstructionT("common.logout", "Logout"))}</button>
      </div>
    </header>
    <section class="delivery-instruction-workspace">
      <aside class="delivery-instruction-list-panel">
        <div class="delivery-instruction-search">
          <input id="salesDeliveryInstructionSearch" type="search" autocomplete="off" placeholder="${deliveryInstructionEscape(deliveryInstructionT("deliveryInstruction.searchPlaceholder", "Search SO, customer, address, or instruction"))}" value="${deliveryInstructionEscape(salesDeliveryInstructionState.search)}" />
          <button type="button" data-delivery-instruction-action="refresh">${deliveryInstructionEscape(deliveryInstructionT("deliveryInstruction.refresh", "Refresh"))}</button>
        </div>
        <div class="delivery-instruction-order-list" id="salesDeliveryInstructionList"></div>
      </aside>
      <section class="delivery-instruction-editor" id="salesDeliveryInstructionEditor"></section>
    </section>`;
  salesDeliveryInstructionRenderList();
  salesDeliveryInstructionRenderDetail();
}

function salesDeliveryInstructionRenderList() {
  const list = document.getElementById("salesDeliveryInstructionList");
  if (!list) return;
  if (salesDeliveryInstructionState.loadingList) {
    list.innerHTML = `<div class="delivery-instruction-empty">${deliveryInstructionEscape(deliveryInstructionT("deliveryInstruction.loading", "Loading delivery orders…"))}</div>`;
    return;
  }
  if (!salesDeliveryInstructionState.orders.length) {
    list.innerHTML = `<div class="delivery-instruction-empty">${deliveryInstructionEscape(deliveryInstructionT("deliveryInstruction.noOrders", "No authorized Delivery Sales Orders match this search."))}</div>`;
    return;
  }
  list.innerHTML = salesDeliveryInstructionState.orders.map((order) => `
    <button class="delivery-instruction-order-card ${Number(order.orderId) === Number(salesDeliveryInstructionState.selectedId) ? "selected" : ""}" type="button" data-delivery-instruction-action="select" data-id="${Number(order.orderId)}">
      <span><strong>${deliveryInstructionEscape(order.orderRef)}</strong>${order.editable ? "" : `<span class="delivery-instruction-pill locked">${deliveryInstructionEscape(deliveryInstructionT("deliveryInstruction.readOnly", "Read-only"))}</span>`}</span>
      <span>${deliveryInstructionEscape(order.customer || deliveryInstructionT("deliveryInstruction.noCustomer", "Customer not available"))}</span>
      <small>${deliveryInstructionEscape(deliveryInstructionDate(order.orderDate))} · ${deliveryInstructionEscape(order.status || "—")}</small>
    </button>`).join("");
}

function deliveryInstructionMediaHtml(media, editable) {
  const url = deliveryInstructionContentUrl(media);
  const preview = media.mediaKind === "video"
    ? `<video controls preload="metadata" referrerpolicy="no-referrer" src="${deliveryInstructionEscape(url)}"></video>`
    : `<a href="${deliveryInstructionEscape(url)}" target="_blank" rel="noopener noreferrer"><img loading="lazy" referrerpolicy="no-referrer" src="${deliveryInstructionEscape(url)}" alt="${deliveryInstructionEscape(media.fileName)}" /></a>`;
  return `<article class="delivery-instruction-media">
    ${preview}
    <small title="${deliveryInstructionEscape(media.fileName)}">${deliveryInstructionEscape(media.fileName)}</small>
    <small>${deliveryInstructionEscape(deliveryInstructionBytes(media.byteSize))}${media.onlineOnly ? ` · ${deliveryInstructionEscape(deliveryInstructionT("deliveryInstruction.onlineVideo", "Online video"))}` : ""}</small>
    ${editable ? `<div class="delivery-instruction-actions">
      <button type="button" data-delivery-instruction-action="replace-media" data-media-id="${deliveryInstructionEscape(media.id)}">${deliveryInstructionEscape(deliveryInstructionT("deliveryInstruction.replace", "Replace"))}</button>
      <button class="danger" type="button" data-delivery-instruction-action="delete-media" data-media-id="${deliveryInstructionEscape(media.id)}">${deliveryInstructionEscape(deliveryInstructionT("deliveryInstruction.delete", "Delete"))}</button>
    </div>` : ""}
  </article>`;
}

function salesDeliveryInstructionRenderDetail() {
  const editor = document.getElementById("salesDeliveryInstructionEditor");
  if (!editor) return;
  if (salesDeliveryInstructionState.loadingDetail) {
    editor.innerHTML = `<div class="delivery-instruction-empty">${deliveryInstructionEscape(deliveryInstructionT("deliveryInstruction.loadingDetail", "Loading instructions…"))}</div>`;
    return;
  }
  const detail = salesDeliveryInstructionState.detail;
  if (!detail) {
    editor.innerHTML = `<div class="delivery-instruction-empty"><div><strong>${deliveryInstructionEscape(deliveryInstructionT("deliveryInstruction.selectOrder", "Select a Delivery Sales Order"))}</strong><p>${deliveryInstructionEscape(deliveryInstructionT("deliveryInstruction.selectOrderHelp", "Search any retained order in your authorized yard, including completed orders."))}</p></div></div>`;
    return;
  }
  const automaticText = detail.automatic?.text || "";
  const phones = Array.isArray(detail.automatic?.phones) ? detail.automatic.phones : [];
  const media = Array.isArray(detail.media) ? detail.media : [];
  const busy = salesDeliveryInstructionState.saving;
  const mediaUploadEnabled = detail.editable && !busy && media.length < 5;
  editor.innerHTML = `<div class="delivery-instruction-editor-grid">
    <div class="delivery-instruction-heading-line">
      <div><p class="delivery-instruction-muted">${deliveryInstructionEscape(detail.customer || "")}</p><h2>${deliveryInstructionEscape(detail.orderRef)}</h2></div>
      <span class="delivery-instruction-pill">${deliveryInstructionEscape(detail.status || "—")}</span>
      <span class="delivery-instruction-pill">${deliveryInstructionEscape(deliveryInstructionT("deliveryInstruction.revision", "Revision"))} ${Number(detail.revision || 0)}</span>
    </div>
    ${salesDeliveryInstructionState.error ? `<div class="delivery-instruction-notice error">${deliveryInstructionEscape(salesDeliveryInstructionState.error)}</div>` : ""}
    ${salesDeliveryInstructionState.notice ? `<div class="delivery-instruction-notice">${deliveryInstructionEscape(salesDeliveryInstructionState.notice)}</div>` : ""}
    ${detail.editable ? "" : `<div class="delivery-instruction-notice">${deliveryInstructionEscape(detail.lockReason || deliveryInstructionT("deliveryInstruction.completedLock", "This completed order is retained for reference and cannot be edited."))}</div>`}
    <section class="delivery-instruction-section">
      <h3>${deliveryInstructionEscape(deliveryInstructionT("deliveryInstruction.netsuiteMemo", "NetSuite memo instruction"))}</h3>
      <p class="delivery-instruction-muted">${deliveryInstructionEscape(deliveryInstructionT("deliveryInstruction.automaticHelp", "Address and planned date/time are omitted when confidently recognized. Ambiguous notes remain complete."))}</p>
      <p class="delivery-instruction-automatic">${deliveryInstructionEscape(automaticText || deliveryInstructionT("deliveryInstruction.noAutomatic", "No memo delivery instruction."))}</p>
      ${phones.length ? `<div class="delivery-instruction-phone-list">${phones.map((phone) => `<a href="tel:${deliveryInstructionEscape(phone.href)}">☎ ${deliveryInstructionEscape(phone.display)}</a>`).join("")}</div>` : ""}
    </section>
    <section class="delivery-instruction-section">
      <h3>${deliveryInstructionEscape(deliveryInstructionT("deliveryInstruction.additionalText", "Additional delivery text"))}</h3>
      <textarea id="salesDeliveryInstructionText" maxlength="5000" ${detail.editable && !busy ? "" : "disabled"} placeholder="${deliveryInstructionEscape(deliveryInstructionT("deliveryInstruction.additionalPlaceholder", "Add call-ahead, gate, placement, access, or other driver instructions"))}">${deliveryInstructionEscape(detail.additionalText || "")}</textarea>
      <div class="delivery-instruction-actions">
        <button class="primary" type="button" data-delivery-instruction-action="save-text" ${detail.editable && !busy ? "" : "disabled"}>${deliveryInstructionEscape(busy ? deliveryInstructionT("deliveryInstruction.saving", "Saving…") : deliveryInstructionT("deliveryInstruction.saveText", "Save text"))}</button>
      </div>
    </section>
    <section class="delivery-instruction-section">
      <div class="delivery-instruction-heading-line"><h3>${deliveryInstructionEscape(deliveryInstructionT("deliveryInstruction.media", "Images and videos"))}</h3><span class="delivery-instruction-pill">${media.length}/5</span></div>
      <p class="delivery-instruction-muted">${deliveryInstructionEscape(deliveryInstructionT("deliveryInstruction.mediaHelp720p", "Images are validated and compressed to a maximum 720p JPEG; videos remain original. Up to 25 MB per source file."))}</p>
      <div class="delivery-instruction-gallery">${media.map((item) => deliveryInstructionMediaHtml(item, detail.editable && !busy)).join("") || `<p class="delivery-instruction-muted">${deliveryInstructionEscape(deliveryInstructionT("deliveryInstruction.noMedia", "No instruction media uploaded."))}</p>`}</div>
      <div class="delivery-instruction-upload-zone ${mediaUploadEnabled ? "" : "disabled"}" data-delivery-instruction-drop-zone data-disabled="${mediaUploadEnabled ? "false" : "true"}">
        <div><strong>${deliveryInstructionEscape(deliveryInstructionT("deliveryInstruction.dropMedia", "Drop images or videos here"))}</strong><span>${deliveryInstructionEscape(deliveryInstructionT("deliveryInstruction.dropMediaHelp", "Images become smaller 720p JPEG files before upload."))}</span></div>
        <label class="delivery-instruction-file-button primary ${mediaUploadEnabled ? "" : "disabled"}">
          ${deliveryInstructionEscape(deliveryInstructionT("deliveryInstruction.browseMedia", "Browse files"))}
          <input id="salesDeliveryInstructionFiles" type="file" multiple accept="image/jpeg,image/png,image/webp,image/heic,image/heif,video/mp4,video/quicktime,video/webm,.jpg,.jpeg,.png,.webp,.heic,.heif,.mp4,.mov,.webm" ${mediaUploadEnabled ? "" : "disabled"} />
        </label>
      </div>
    </section>
  </div>`;
}

async function salesDeliveryInstructionLoadList({ preserveSelection = true } = {}) {
  const generation = ++salesDeliveryInstructionState.listGeneration;
  salesDeliveryInstructionState.loadingList = true;
  salesDeliveryInstructionRenderList();
  const orders = await salesDeliveryInstructionApi(`/api/sales/delivery-instructions/orders?search=${encodeURIComponent(salesDeliveryInstructionState.search)}&limit=100`);
  if (generation !== salesDeliveryInstructionState.listGeneration) return;
  salesDeliveryInstructionState.orders = Array.isArray(orders) ? orders : [];
  salesDeliveryInstructionState.loadingList = false;
  if (!preserveSelection || !salesDeliveryInstructionState.orders.some((order) => Number(order.orderId) === Number(salesDeliveryInstructionState.selectedId))) {
    salesDeliveryInstructionState.selectedId = salesDeliveryInstructionState.orders[0]?.orderId || null;
  }
  salesDeliveryInstructionRenderList();
  if (salesDeliveryInstructionState.selectedId) await salesDeliveryInstructionLoadDetail(salesDeliveryInstructionState.selectedId);
  else {
    salesDeliveryInstructionState.detail = null;
    salesDeliveryInstructionRenderDetail();
  }
}

async function salesDeliveryInstructionLoadDetail(orderId) {
  salesDeliveryInstructionState.loadingDetail = true;
  salesDeliveryInstructionState.error = "";
  salesDeliveryInstructionState.notice = "";
  salesDeliveryInstructionRenderDetail();
  try {
    salesDeliveryInstructionState.detail = await salesDeliveryInstructionApi(`/api/sales/delivery-instructions/orders/${encodeURIComponent(orderId)}`);
    salesDeliveryInstructionState.selectedId = Number(salesDeliveryInstructionState.detail.orderId);
    localStorage.setItem("mbbs.sales.deliveryInstructions.selected", String(salesDeliveryInstructionState.selectedId));
  } finally {
    salesDeliveryInstructionState.loadingDetail = false;
    salesDeliveryInstructionRenderList();
    salesDeliveryInstructionRenderDetail();
  }
}

async function salesDeliveryInstructionSaveText() {
  const detail = salesDeliveryInstructionState.detail;
  if (!detail?.editable || salesDeliveryInstructionState.saving) return;
  const textarea = document.getElementById("salesDeliveryInstructionText");
  salesDeliveryInstructionState.saving = true;
  salesDeliveryInstructionState.error = "";
  salesDeliveryInstructionRenderDetail();
  try {
    salesDeliveryInstructionState.detail = await salesDeliveryInstructionApi(`/api/sales/delivery-instructions/orders/${encodeURIComponent(detail.orderId)}`, {
      method: "PUT",
      body: JSON.stringify({ expectedRevision: detail.revision, additionalText: textarea?.value || "" })
    });
    salesDeliveryInstructionState.notice = deliveryInstructionT("deliveryInstruction.saved", "Delivery instruction saved.");
  } catch (error) {
    salesDeliveryInstructionState.error = error.message;
    if (error.status === 409) await salesDeliveryInstructionLoadDetail(detail.orderId);
  } finally {
    salesDeliveryInstructionState.saving = false;
    salesDeliveryInstructionRenderDetail();
  }
}

async function salesDeliveryInstructionUploadFiles(files, { replaceMediaId = "" } = {}) {
  const sourceFiles = [...(files || [])];
  const detail = salesDeliveryInstructionState.detail;
  if (!detail?.editable || !sourceFiles.length || salesDeliveryInstructionState.saving) return;
  const replacing = String(replaceMediaId || "");
  const remaining = 5 - (detail.media?.length || 0) + (replacing ? 1 : 0);
  if ((replacing && sourceFiles.length !== 1) || sourceFiles.length > remaining) {
    salesDeliveryInstructionState.error = deliveryInstructionT("deliveryInstruction.tooManyFiles", "This order can contain no more than five files.");
    return salesDeliveryInstructionRenderDetail();
  }
  salesDeliveryInstructionState.saving = true;
  salesDeliveryInstructionState.error = "";
  salesDeliveryInstructionState.notice = deliveryInstructionT("deliveryInstruction.preparingMedia", "Validating and compressing images…");
  salesDeliveryInstructionRenderDetail();
  try {
    if (!window.DeliveryInstructionUpload) throw new Error("The image preparation tool did not load. Refresh this page and try again.");
    const selected = await window.DeliveryInstructionUpload.prepareFiles(sourceFiles);
    let current = detail;
    for (const file of selected) {
      const ticket = await salesDeliveryInstructionApi(`/api/sales/delivery-instructions/orders/${encodeURIComponent(current.orderId)}/media-ticket`, {
        method: "POST",
        body: JSON.stringify({
          expectedRevision: current.revision,
          mimeType: file.type,
          byteSize: file.size,
          fileName: file.name,
          ...(replacing ? { replaceMediaId: replacing } : {})
        })
      });
      const formData = new FormData();
      formData.append("file", file, file.name);
      const uploadResponse = await fetch(ticket.upload.uploadUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${ticket.upload.token}` },
        body: formData
      });
      const uploadText = await uploadResponse.text();
      let uploadPayload = null;
      try { uploadPayload = uploadText ? JSON.parse(uploadText) : null; } catch { uploadPayload = null; }
      if (!uploadResponse.ok || !uploadPayload?.key) {
        throw new Error(uploadPayload?.error || uploadText || deliveryInstructionT("deliveryInstruction.uploadFailed", "Media upload failed."));
      }
      current = await salesDeliveryInstructionApi(`/api/sales/delivery-instructions/orders/${encodeURIComponent(current.orderId)}/media`, {
        method: "POST",
        body: JSON.stringify({
          uploadId: ticket.uploadId,
          objectReference: `r2://${uploadPayload.key}`,
          mimeType: file.type,
          byteSize: file.size,
          fileName: file.name,
          expectedRevision: current.revision
        })
      });
    }
    salesDeliveryInstructionState.detail = current;
    salesDeliveryInstructionState.notice = replacing
      ? deliveryInstructionT("deliveryInstruction.mediaReplaced", "Instruction media replaced.")
      : deliveryInstructionT("deliveryInstruction.mediaSaved720p", "Instruction media uploaded. Images were compressed to 720p JPEG.");
  } catch (error) {
    salesDeliveryInstructionState.error = error.message;
    if (error.status === 409) await salesDeliveryInstructionLoadDetail(detail.orderId);
  } finally {
    salesDeliveryInstructionState.saving = false;
    salesDeliveryInstructionRenderDetail();
  }
}

function salesDeliveryInstructionChooseReplacement(mediaId) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/jpeg,image/png,image/webp,image/heic,image/heif,video/mp4,video/quicktime,video/webm,.jpg,.jpeg,.png,.webp,.heic,.heif,.mp4,.mov,.webm";
  input.hidden = true;
  input.addEventListener("change", () => {
    const files = input.files;
    input.remove();
    if (files?.length) salesDeliveryInstructionUploadFiles(files, { replaceMediaId: mediaId });
  }, { once: true });
  document.body.append(input);
  input.click();
}

async function salesDeliveryInstructionDeleteMedia(mediaId) {
  const detail = salesDeliveryInstructionState.detail;
  if (!detail?.editable || salesDeliveryInstructionState.saving) return;
  if (!confirm(deliveryInstructionT("deliveryInstruction.confirmDelete", "Delete this instruction file?"))) return;
  salesDeliveryInstructionState.saving = true;
  salesDeliveryInstructionState.error = "";
  salesDeliveryInstructionRenderDetail();
  try {
    salesDeliveryInstructionState.detail = await salesDeliveryInstructionApi(`/api/sales/delivery-instructions/orders/${encodeURIComponent(detail.orderId)}/media/${encodeURIComponent(mediaId)}`, {
      method: "DELETE",
      body: JSON.stringify({ expectedRevision: detail.revision })
    });
    salesDeliveryInstructionState.notice = deliveryInstructionT("deliveryInstruction.mediaDeleted", "Instruction media deleted.");
  } catch (error) {
    salesDeliveryInstructionState.error = error.message;
    if (error.status === 409) await salesDeliveryInstructionLoadDetail(detail.orderId);
  } finally {
    salesDeliveryInstructionState.saving = false;
    salesDeliveryInstructionRenderDetail();
  }
}

salesDeliveryInstructionApp.addEventListener("input", (event) => {
  if (event.target.id !== "salesDeliveryInstructionSearch") return;
  salesDeliveryInstructionState.search = event.target.value;
  window.clearTimeout(salesDeliveryInstructionState.searchTimer);
  salesDeliveryInstructionState.searchTimer = window.setTimeout(() => {
    salesDeliveryInstructionLoadList({ preserveSelection: false }).catch((error) => {
      salesDeliveryInstructionState.loadingList = false;
      salesDeliveryInstructionState.error = error.message;
      salesDeliveryInstructionRenderList();
      salesDeliveryInstructionRenderDetail();
    });
  }, 300);
});

salesDeliveryInstructionApp.addEventListener("change", (event) => {
  if (event.target.id === "salesDeliveryInstructionFiles") {
    salesDeliveryInstructionUploadFiles(event.target.files);
  }
});

salesDeliveryInstructionApp.addEventListener("dragover", (event) => {
  const zone = event.target.closest("[data-delivery-instruction-drop-zone]");
  if (!zone || !window.DeliveryInstructionUpload?.isFileDrag(event)) return;
  event.preventDefault();
  if (zone.dataset.disabled === "true") return;
  event.dataTransfer.dropEffect = "copy";
  zone.classList.add("drag-over");
});

salesDeliveryInstructionApp.addEventListener("dragleave", (event) => {
  const zone = event.target.closest("[data-delivery-instruction-drop-zone]");
  if (!zone || zone.contains(event.relatedTarget)) return;
  zone.classList.remove("drag-over");
});

salesDeliveryInstructionApp.addEventListener("drop", (event) => {
  const zone = event.target.closest("[data-delivery-instruction-drop-zone]");
  if (!zone || !window.DeliveryInstructionUpload?.isFileDrag(event)) return;
  event.preventDefault();
  zone.classList.remove("drag-over");
  if (zone.dataset.disabled === "true") return;
  salesDeliveryInstructionUploadFiles(event.dataTransfer.files);
});

salesDeliveryInstructionApp.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delivery-instruction-action]");
  if (!button) return;
  try {
    if (button.dataset.deliveryInstructionAction === "refresh") return salesDeliveryInstructionLoadList({ preserveSelection: true });
    if (button.dataset.deliveryInstructionAction === "select") return salesDeliveryInstructionLoadDetail(button.dataset.id);
    if (button.dataset.deliveryInstructionAction === "save-text") return salesDeliveryInstructionSaveText();
    if (button.dataset.deliveryInstructionAction === "replace-media") return salesDeliveryInstructionChooseReplacement(button.dataset.mediaId);
    if (button.dataset.deliveryInstructionAction === "delete-media") return salesDeliveryInstructionDeleteMedia(button.dataset.mediaId);
  } catch (error) {
    salesDeliveryInstructionState.error = error.message;
    salesDeliveryInstructionRenderDetail();
  }
});

window.addEventListener("mbbs-language-changed", salesDeliveryInstructionShell);

requireDispatchLogin({
  mount: salesDeliveryInstructionApp,
  roles: ["sales", "admin"],
  allowPublicSales: false,
  async onReady(operator) {
    salesDeliveryInstructionState.operator = operator;
    salesDeliveryInstructionShell();
    try {
      await salesDeliveryInstructionLoadList({ preserveSelection: true });
    } catch (error) {
      salesDeliveryInstructionState.loadingList = false;
      salesDeliveryInstructionState.error = error.message;
      salesDeliveryInstructionRenderList();
      salesDeliveryInstructionRenderDetail();
    }
  }
});
