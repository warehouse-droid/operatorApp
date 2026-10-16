// @ts-check
(function () {
  /** @param {any} deps */
  function create({ root, request, escape, render, active }) {
    let search = "", reason = "", error = "", notice = "", busy = false, sequence = 0;
    /** @type {any[]} */
    let orders = [];
    /** @type {any} */
    let preview = null;
    /** @type {{requestId: string, expectedStateHash: string, reason: string}|null} */
    let retry = null;
    const endpoint = (/** @type {any} */ ref) => `/api/control/operator-orders/${encodeURIComponent(ref)}`;
    /** @param {() => Promise<void>} work */
    async function run(work) {
      if (busy) { return; }
      busy = true; error = ""; notice = ""; render();
      try { await work(); }
      catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
      finally { busy = false; if (active()) { render(); } }
    }
    async function findOrders() {
      const current = ++sequence;
      preview = null; retry = null; reason = "";
      const rows = await request(`/api/control/operator-orders?search=${encodeURIComponent(search)}`);
      if (current === sequence && active()) { orders = rows; }
    }
    /** @param {string} ref */
    async function showPreview(ref) {
      const current = ++sequence;
      preview = null; retry = null; reason = "";
      const next = await request(endpoint(ref) + "/reopen-preview");
      if (current === sequence && active()) { preview = next; }
    }
    async function reopen() {
      if (!preview?.allowed || !reason.trim()) { throw new Error("Enter a reason before reopening."); }
      const refs = preview.orders.map((/** @type {any} */ order) => order.orderRef).join(", ");
      if (!window.confirm(`Unpack and reopen ${refs}? Local packing and loading will be reset. ${preview.retainedPhotoCount} existing images and the order history will be retained.`)) { return; }
      if (!retry || retry.reason !== reason.trim()) {
        retry = { requestId: window.crypto.randomUUID(), expectedStateHash: preview.stateHash, reason: reason.trim() };
      }
      const result = await request(endpoint(preview.orderRef) + "/reopen", { method: "POST", body: JSON.stringify(retry) });
      notice = `${result.orderRefs.join(", ")} reopened in Operator and Dispatch. ${result.retainedPhotoCount} images retained.`;
      preview = null; retry = null; reason = "";
      orders = orders.map((/** @type {any} */ order) => result.orderRefs.includes(order.orderRef) ? { ...order, status: "open" } : order);
    }
    root.addEventListener("submit", (/** @type {any} */ event) => {
      if (!active() || !event.target.matches('[data-form="operator-order-reopen-search"]')) { return; }
      event.preventDefault();
      search = String(new FormData(event.target).get("search") || "").trim();
      void run(findOrders);
    });
    root.addEventListener("input", (/** @type {any} */ event) => {
      if (!active()) { return; }
      if (event.target.matches('[data-reopen-reason]')) { reason = event.target.value; }
      if (event.target.matches('[data-reopen-search]')) { search = event.target.value; }
    });
    root.addEventListener("click", (/** @type {any} */ event) => {
      if (!active()) { return; }
      const button = event.target.closest("[data-reopen-action]");
      if (!button) { return; }
      if (button.dataset.reopenAction === "preview") { void run(() => showPreview(button.dataset.orderRef)); }
      if (button.dataset.reopenAction === "confirm") { void run(reopen); }
    });
    return {
      load() { sequence += 1; preview = null; retry = null; reason = ""; error = ""; render(); },
      render() {
        return `<section class="panel" data-operator-order-reopen>
          <div class="section-heading"><div><h2>Order Reopen</h2>
            <p class="muted">Reopen an order locally in Operator and Dispatch, including an unfulfilled order billed in NetSuite. Packing, loading and preparing ownership reset; NetSuite billing, existing images and history are retained.</p></div></div>
          <form data-form="operator-order-reopen-search" class="actions">
            <label>Order number <input name="search" data-reopen-search minlength="2" maxlength="500" required value="${escape(search)}" placeholder="SOA08801 or SOA08800+SOA08801" /></label>
            <button class="primary" type="submit" ${busy ? "disabled" : ""}>${busy ? "Working…" : "Search"}</button>
          </form>
          ${error ? `<div class="notice warning" role="alert">${escape(error)}</div>` : ""}
          ${notice ? `<div class="notice" role="status">${escape(notice)}</div>` : ""}
          ${orders.length ? `<div class="table-scroll"><table><thead><tr><th>Order</th><th>Type</th><th>Status</th><th>Yard</th><th></th></tr></thead><tbody>
            ${orders.map((/** @type {any} */ order) => `<tr><td>${escape(order.orderRef)}</td><td>${escape(order.orderType)}</td><td>${escape(order.status || "open")}</td><td>${escape(order.yard || "")}</td>
              <td><button type="button" data-reopen-action="preview" data-order-ref="${escape(order.orderRef)}" ${busy ? "disabled" : ""}>Preview reopen</button></td></tr>`).join("")}
          </tbody></table></div>` : search && !busy ? '<p class="muted">Search for an order to view its local status.</p>' : ""}
          ${preview ? `<section class="panel" data-reopen-preview><h3>Reopen ${escape(preview.orderRef)}</h3>
            <ul>${preview.orders.map((/** @type {any} */ order) => `<li><strong>${escape(order.orderRef)}</strong>: ${escape(order.progress)}${order.operator
              ? ` by ${escape(order.operator.displayName)} (${escape(order.operator.username)})` : " · Operator not recorded"} · ${Number(order.lineCount)} lines</li>`).join("")}</ul>
            <p>${Number(preview.retainedPhotoCount)} existing images will be retained and remain available in Operator.</p>
            ${preview.blockers.map((/** @type {any} */ blocker) => `<div class="notice warning">${escape(blocker.message)}</div>`).join("")}
            ${preview.allowed ? `<label>Reason <textarea data-reopen-reason maxlength="500" rows="3" ${busy ? "disabled" : ""}>${escape(reason)}</textarea></label>
              <div class="actions"><button class="danger" type="button" data-reopen-action="confirm" ${busy ? "disabled" : ""}>Unpack &amp; Reopen</button></div>` : ""}
          </section>` : ""}
        </section>`;
      }
    };
  }
  (/** @type {any} */ (window)).MBBSControlOrderReopen = { create };
})();
