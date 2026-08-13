(function () {
  const STORAGE_KEY = "mbbs.appSidebar.collapsed";
  const WIDTH = 206;
  const COLLAPSED_WIDTH = 58;
  const OFFLINE_REVIEW_COUNT_ENDPOINT = "/api/dispatch/offline-review/count";

  let path = window.location.pathname;
  let offlineReviewCount = null;
  let offlineReviewCountTimer = null;
  let offlineReviewRefreshTimer = null;
  let offlineReviewEventSource = null;
  let sidebarOperator = null;
  if (!path.startsWith("/admin") && !path.startsWith("/control") && !path.startsWith("/dispatch") && !path.startsWith("/scm") && !path.startsWith("/sales") && !path.startsWith("/mbt")) return;

  function t(key, fallback) {
    return window.MBBS_I18N?.t?.(key, fallback) || fallback;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function iconFor(label) {
    const words = String(label || "").trim().split(/\s+/).filter(Boolean);
    if (!words.length) return "?";
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return `${words[0][0] || ""}${words[1][0] || ""}`.toUpperCase();
  }

  function isActive(item) {
    if (item.href === "/dispatch/driver-pwa") {
      return path === "/dispatch/driver-pwa" || path === "/dispatch/offline-review";
    }
    if (item.controlSection) {
      return path === item.href;
    }
    if (item.href === "/control") return path.startsWith("/control");
    if (item.href === "/admin") return path.startsWith("/admin");
    if (item.href === "/dispatch") return path === "/dispatch";
    if (item.href === "/scm") return path === "/scm";
    if (item.href === "/sales") return path === "/sales";
    return path === item.href;
  }

  const mainItems = [
    { label: "Admin", href: "/admin", icon: "AD", authorities: ["admin"] },
    { label: "Control", href: "/control", icon: "CT", authorities: ["admin", "yard_manager"] },
    { label: "Dispatch", href: "/dispatch", icon: "DP", authorities: ["admin", "dispatcher"] },
    { label: "SCM", href: "/scm", icon: "SC", authorities: ["admin", "dispatcher", "scm", "scm_staff", "yard_manager"] },
    { label: "Sales", href: "/sales", icon: "SA", authorities: ["admin", "sales"] },
    { label: "MBT", href: "/mbt", icon: "MB", authorities: ["admin", "dispatcher", "mbt_frontdesk", "mbt_billing"] },
    { label: "Operator", href: "/operator", icon: "OP", authorities: ["admin", "operator", "yard_manager"] }
  ];

  const dispatchItems = [
    { label: "Menu", href: "/dispatch", icon: "MN" },
    { label: "Planning", href: "/dispatch/planning", icon: "PL" },
    { label: "Custom Orders", href: "/dispatch/custom-orders", icon: "CU" },
    { label: "Monitor", href: "/dispatch/monitor", icon: "MO" },
    { label: "Statistics", href: "/dispatch/statistics", icon: "ST" },
    { label: "DVIR", href: "/dispatch/dvir", icon: "DV" },
    { label: "Driver PWA", href: "/dispatch/driver-pwa", icon: "PW", badge: "offline-review" },
    { label: "PO/TO Schedule", href: "/dispatch/po-to-schedule", icon: "PT" },
    { label: "In/Outbound Record", href: "/dispatch/loaded-export", icon: "IR" },
    { label: "SO Method", href: "/dispatch/sales-order-methods", icon: "SO" },
    { label: "Snapshot", href: "/dispatch/snapshot", icon: "SN" },
    { label: "Setup", href: "/dispatch/setup", icon: "SE" }
  ];

  const scmItems = [
    { label: "SCM Menu", href: "/scm", icon: "SM", authorities: ["admin", "dispatcher", "scm", "scm_staff", "yard_manager"] },
    { label: "Stock Requests", href: "/scm/stock-requests", icon: "SR", scmWriteOnly: true, authorities: ["admin", "scm", "scm_staff"] },
    { label: "Smart SCM", href: "/scm/smart", icon: "AI", authorities: ["admin", "dispatcher", "scm", "scm_staff", "yard_manager"] },
    { label: "NetSuite PO history", href: "/scm/netsuite-po", icon: "PO", scmWriteOnly: true, authorities: ["admin", "scm", "scm_staff"] },
    { label: "Local Vendors", href: "/scm/vendors", icon: "LV", authorities: ["admin", "dispatcher", "scm", "scm_staff", "yard_manager"] },
    { label: "Auto Transfer", href: "/scm/transfer-dependencies", icon: "AT", authorities: ["admin", "scm", "scm_staff"] },
    { label: "PO Split", href: "/scm/POsplit", icon: "PS", authorities: ["admin", "dispatcher", "scm", "scm_staff"] },
    { label: "PO/TO Schedule", href: "/scm/POTOschedule", icon: "PT", authorities: ["admin", "dispatcher", "scm", "scm_staff", "yard_manager"] },
    { label: "Schedule Formatting", href: "/scm/schedule-formatting", icon: "CF", authorities: ["admin", "scm", "scm_staff"] },
    { label: "VRMA", href: "/scm/VRMA", icon: "VR", authorities: ["admin", "scm", "scm_staff"] },
    { label: "PO Route Rules", href: "/scm/route-rules", icon: "RT", authorities: ["admin", "dispatcher", "scm", "scm_staff", "yard_manager"] }
  ];

  const salesItems = [
    { label: "Sales Menu", href: "/sales", icon: "SM" },
    { label: "Delivery Instructions", href: "/sales/delivery-instructions", icon: "DI", staffOnly: true },
    { label: "Request Stock", href: "/sales/stock-requests", icon: "RS", staffOnly: true },
    { label: "Return Records", href: "/sales/returns", icon: "RR", staffOnly: true },
    { label: "Planning View", href: "/sales/planning", icon: "PL" },
    { label: "PO/TO Schedule", href: "/sales/schedule", icon: "PT" },
    { label: "Truck Monitor", href: "/sales/monitor", icon: "MO" },
    { label: "SO Printing", href: "/sales/printing", icon: "PR" },
    { label: "In/Outbound Record", href: "/sales/in-outbound-record", icon: "IR", staffOnly: true }
  ];

  const controlItems = [
    { label: "Dashboard", href: "/control", controlSection: "dashboard", icon: "DB" },
    { label: "Return Management", href: "/control/returns", controlSection: "returns", icon: "RM" },
    { label: "Order Locks", href: "/control/order-locks", controlSection: "locks", icon: "LK" },
    { label: "Item Classification", href: "/control/item-classification", controlSection: "classification", icon: "CL" },
    { label: "Vendor Mapping", href: "/control/vendor-mapping", controlSection: "vendor-mapping", icon: "VM" },
    { label: "Operator Warnings", href: "/control/operator-warnings", controlSection: "warnings", icon: "WN" },
    { label: "In/Outbound Record", href: "/control/yard-in-outbound", controlSection: "loaded-export", icon: "IR" },
    { label: "Cycle Count Review", href: "/control/cycle-count-review", controlSection: "cycle-count", icon: "CC" },
    { label: "Operator Load Records", href: "/control/operator-load-records", controlSection: "fulfillment", icon: "LD" }
  ];

  const adminItems = [
    { label: "Overview", href: "/admin", controlSection: "dashboard", icon: "OV" },
    { label: "Accounts", href: "/admin/accounts", controlSection: "operators", icon: "AC" },
    { label: "Sync", href: "/admin/sync", controlSection: "sync", icon: "SY" },
    { label: "SO / PO / TO Reconcile", href: "/admin/reconciliation", controlSection: "reconciliation", icon: "RC" },
    { label: "Return Automation", href: "/admin/return-automation", controlSection: "return-automation", icon: "RA" },
    { label: "Yard Printers", href: "/admin/printers", icon: "PR" },
    { label: "Photo Storage", href: "/admin/photo-storage", controlSection: "storage", icon: "PS" },
    { label: "Feature Gates", href: "/admin/mbt-gates", icon: "FG" },
    { label: "Audit", href: "/admin/audit", controlSection: "audit", icon: "AU" }
  ];

  const mbtItems = [
    { label: "Overview", href: "/mbt", icon: "OV", mbtRoles: ["admin", "dispatcher", "mbt_frontdesk", "mbt_billing"] },
    { label: "Front Desk", href: "/mbt/frontdesk", icon: "FD", mbtRole: "mbt_frontdesk" },
    { label: "Billing", href: "/mbt/billing", icon: "BL", mbtRole: "mbt_billing" },
    { label: "Assets", href: "/mbt/assets", icon: "BA", mbtRoles: ["admin", "dispatcher"] },
    { label: "Configuration", href: "/mbt/config", icon: "CF", mbtRole: "admin" }
  ];

  function staffRoleSet() {
    const normalizeRole = (value) => String(value || "").trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
    const liveOperator = window.MBBS_DISPATCH_OPERATOR || sidebarOperator;
    if (liveOperator) {
      if (liveOperator.publicSales) return new Set(["sales"]);
      return new Set([
        ...(Array.isArray(liveOperator.roles) ? liveOperator.roles : []),
        liveOperator.role
      ].map(normalizeRole).filter(Boolean));
    }
    let savedRoles = [];
    try {
      const parsed = JSON.parse(localStorage.getItem("mbbs.staff.roles") || "[]");
      savedRoles = Array.isArray(parsed) ? parsed : [];
    } catch {
      savedRoles = [];
    }
    return new Set([
      ...savedRoles,
      localStorage.getItem("mbbs.staff.role")
    ].map(normalizeRole).filter(Boolean));
  }

  function itemAllowedByAuthority(item, roles = staffRoleSet()) {
    return !Array.isArray(item.authorities) || item.authorities.some((role) => roles.has(role));
  }

  function canManageScmPurchaseOrders() {
    const roles = staffRoleSet();
    return roles.has("admin") || roles.has("scm") || roles.has("scm_staff");
  }

  function visibleMainItems() {
    const roles = staffRoleSet();
    return mainItems.filter((item) => itemAllowedByAuthority(item, roles));
  }

  function visibleMbtItems() {
    const roles = staffRoleSet();
    if (roles.has("admin")) return mbtItems;
    return mbtItems.filter((item) =>
      (item.mbtRole === "mbt_frontdesk" && roles.has("mbt_frontdesk"))
      || (item.mbtRole === "mbt_billing" && roles.has("mbt_billing"))
      || (Array.isArray(item.mbtRoles) && item.mbtRoles.some((role) => roles.has(role)))
    );
  }

  function currentItems() {
    if (path.startsWith("/mbt")) return { title: "MBT Bin Operations", items: visibleMbtItems() };
    if (path.startsWith("/admin")) return { title: "Admin", items: adminItems };
    if (path.startsWith("/dispatch")) return { title: "Dispatch", items: dispatchItems };
    if (path.startsWith("/scm")) return {
      title: "SCM",
      items: scmItems
        .filter((item) => itemAllowedByAuthority(item))
        .filter((item) => !item.scmWriteOnly || canManageScmPurchaseOrders())
    };
    if (path.startsWith("/sales")) {
      const operator = window.MBBS_DISPATCH_OPERATOR || sidebarOperator;
      return {
        title: "Sales",
        items: salesItems.filter((item) => !item.staffOnly || (operator && !operator.publicSales))
      };
    }
    return { title: "Control", items: controlItems };
  }

  function styleHtml() {
    return `
      body.has-app-sidebar {
        --app-sidebar-width: ${WIDTH}px;
        padding-left: var(--app-sidebar-width);
        transition: padding-left 160ms ease;
      }
      body.has-app-sidebar.app-sidebar-collapsed {
        --app-sidebar-width: ${COLLAPSED_WIDTH}px;
      }
      body.has-app-sidebar .dispatch-shell {
        width: calc(100vw - var(--app-sidebar-width));
        min-width: 0;
      }
      body.has-app-sidebar .dispatch-topbar {
        grid-template-columns: minmax(240px, 1fr) auto minmax(240px, 1fr);
      }
      .app-sidebar {
        position: fixed;
        inset: 0 auto 0 0;
        z-index: 4200;
        width: var(--app-sidebar-width);
        display: grid;
        grid-template-rows: auto minmax(0, 1fr) auto;
        border-right: 1px solid #c6d3da;
        background: #0f252f;
        color: #f8fbfc;
        box-shadow: 8px 0 20px rgba(15, 37, 47, 0.14);
        transition: width 160ms ease;
      }
      .app-sidebar button,
      .app-sidebar a {
        font: inherit;
      }
      .app-sidebar-head {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 34px;
        gap: 8px;
        align-items: center;
        min-height: 58px;
        padding: 10px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.14);
      }
      .app-sidebar-brand {
        min-width: 0;
        display: grid;
        gap: 2px;
      }
      .app-sidebar-brand strong {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 16px;
        letter-spacing: 0;
      }
      .app-sidebar-brand span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: #a8bbc4;
        font-size: 11px;
        font-weight: 900;
      }
      .app-sidebar-toggle {
        min-width: 34px;
        min-height: 34px;
        padding: 0;
        border: 1px solid rgba(255, 255, 255, 0.22);
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.08);
        color: #fff;
        font-size: 18px;
      }
      .app-sidebar-scroll {
        min-height: 0;
        overflow: auto;
        padding: 10px 8px;
      }
      .app-sidebar-section {
        display: grid;
        gap: 6px;
        margin-bottom: 12px;
      }
      .app-sidebar-section-title {
        padding: 5px 8px;
        color: #9db3bd;
        font-size: 11px;
        font-weight: 950;
        text-transform: uppercase;
        white-space: nowrap;
      }
      .app-sidebar-link {
        position: relative;
        display: grid;
        grid-template-columns: 34px minmax(0, 1fr);
        gap: 8px;
        align-items: center;
        min-height: 38px;
        padding: 0 8px;
        border: 1px solid transparent;
        border-radius: 8px;
        color: #eaf2f5;
        text-decoration: none;
        background: transparent;
        text-align: left;
        cursor: pointer;
      }
      .app-sidebar-link:hover {
        background: rgba(255, 255, 255, 0.08);
      }
      .app-sidebar-link.active {
        border-color: rgba(88, 211, 179, 0.7);
        background: #123f43;
        color: #ffffff;
      }
      .app-sidebar-icon {
        width: 30px;
        height: 30px;
        display: inline-grid;
        place-items: center;
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.11);
        font-size: 11px;
        font-weight: 950;
        letter-spacing: 0;
      }
      .app-sidebar-text {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 13px;
        font-weight: 900;
      }
      .app-sidebar-link.has-sidebar-badge .app-sidebar-text {
        padding-right: 24px;
      }
      .app-sidebar-badge,
      .dispatch-offline-review-menu-badge {
        min-width: 21px;
        height: 21px;
        display: inline-grid;
        place-items: center;
        border: 2px solid #fff;
        border-radius: 999px;
        background: #c92a20;
        color: #fff;
        font-size: 10px;
        font-weight: 950;
        line-height: 1;
      }
      .app-sidebar-badge {
        position: absolute;
        top: 2px;
        right: 3px;
        padding: 0 4px;
      }
      .app-sidebar-badge[hidden],
      .dispatch-offline-review-menu-badge[hidden] {
        display: none;
      }
      .dispatch-offline-review-card-title {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }
      .dispatch-offline-review-card-label {
        color: inherit;
        font-size: inherit;
        font-weight: inherit;
      }
      .dispatch-offline-review-menu-badge {
        flex: 0 0 auto;
        padding: 0 5px;
        border-color: #c92a20;
      }
      .app-sidebar-foot {
        padding: 8px;
        border-top: 1px solid rgba(255, 255, 255, 0.14);
      }
      .app-sidebar-home {
        color: #dce8ed;
        text-decoration: none;
      }
      body.app-sidebar-collapsed .app-sidebar-head {
        grid-template-columns: 1fr;
        padding: 10px 8px;
      }
      body.app-sidebar-collapsed .app-sidebar-brand,
      body.app-sidebar-collapsed .app-sidebar-section-title,
      body.app-sidebar-collapsed .app-sidebar-text {
        display: none;
      }
      body.app-sidebar-collapsed .app-sidebar-link {
        grid-template-columns: 1fr;
        justify-items: center;
        padding: 0;
      }
      body.app-sidebar-collapsed .app-sidebar-scroll {
        padding: 10px 6px;
      }
      body.app-sidebar-collapsed .app-sidebar-foot {
        padding: 8px 6px;
      }
      body.app-sidebar-collapsed .app-sidebar-toggle {
        width: 42px;
      }
      @media (max-width: 760px) {
        body.admin-sync-page.has-app-sidebar,
        body.scm-transfer-dependencies-page.has-app-sidebar {
          --app-sidebar-width: 0px !important;
          padding-left: 0 !important;
          padding-bottom: calc(72px + env(safe-area-inset-bottom));
        }
        body.admin-sync-page.has-app-sidebar .dispatch-shell,
        body.scm-transfer-dependencies-page.has-app-sidebar .dispatch-shell {
          width: 100vw;
          min-width: 0;
        }
        body.admin-sync-page .app-sidebar,
        body.scm-transfer-dependencies-page .app-sidebar {
          inset: auto 0 0 0;
          width: 100%;
          height: calc(72px + env(safe-area-inset-bottom));
          display: block;
          border-top: 1px solid #c6d3da;
          border-right: 0;
          box-shadow: 0 -8px 20px rgba(15, 37, 47, 0.18);
        }
        body.admin-sync-page .app-sidebar-head,
        body.admin-sync-page .app-sidebar-foot,
        body.scm-transfer-dependencies-page .app-sidebar-head,
        body.scm-transfer-dependencies-page .app-sidebar-foot {
          display: none;
        }
        body.admin-sync-page .app-sidebar-scroll,
        body.scm-transfer-dependencies-page .app-sidebar-scroll,
        body.admin-sync-page.app-sidebar-collapsed .app-sidebar-scroll,
        body.scm-transfer-dependencies-page.app-sidebar-collapsed .app-sidebar-scroll {
          height: 100%;
          display: flex;
          overflow-x: auto;
          overflow-y: hidden;
          padding: 5px 6px calc(5px + env(safe-area-inset-bottom));
          overscroll-behavior-x: contain;
          scrollbar-width: thin;
        }
        body.admin-sync-page .app-sidebar-section,
        body.scm-transfer-dependencies-page .app-sidebar-section {
          flex: 0 0 auto;
          display: flex;
          gap: 4px;
          margin: 0;
          padding-right: 7px;
          border-right: 1px solid rgba(255, 255, 255, 0.18);
        }
        body.admin-sync-page .app-sidebar-section:nth-child(2),
        body.scm-transfer-dependencies-page .app-sidebar-section:nth-child(2) {
          order: -1;
          margin-right: 4px;
        }
        body.admin-sync-page .app-sidebar-section-title,
        body.scm-transfer-dependencies-page .app-sidebar-section-title {
          display: none;
        }
        body.admin-sync-page .app-sidebar-link,
        body.admin-sync-page.app-sidebar-collapsed .app-sidebar-link,
        body.scm-transfer-dependencies-page .app-sidebar-link,
        body.scm-transfer-dependencies-page.app-sidebar-collapsed .app-sidebar-link {
          width: 68px;
          min-height: 60px;
          flex: 0 0 68px;
          display: grid;
          grid-template-columns: 1fr;
          grid-template-rows: 30px 14px;
          justify-items: center;
          gap: 2px;
          padding: 3px 4px;
          scroll-snap-align: center;
        }
        body.admin-sync-page .app-sidebar-text,
        body.admin-sync-page.app-sidebar-collapsed .app-sidebar-text,
        body.scm-transfer-dependencies-page .app-sidebar-text,
        body.scm-transfer-dependencies-page.app-sidebar-collapsed .app-sidebar-text {
          width: 100%;
          display: block;
          color: #eaf2f5;
          font-size: 9px;
          line-height: 14px;
          text-align: center;
        }
      }
    `;
  }

  function linkHtml(item) {
    const active = isActive(item);
    const label = t(`sidebar.${item.label.replace(/[^a-z0-9]+/gi, ".").toLowerCase()}`, item.label);
    const icon = item.icon || iconFor(label);
    const sectionAttr = item.controlSection ? ` data-control-section="${escapeHtml(item.controlSection)}"` : "";
    return `
      <a class="app-sidebar-link ${active ? "active" : ""} ${item.badge ? "has-sidebar-badge" : ""}" href="${escapeHtml(item.href)}"${sectionAttr} title="${escapeHtml(label)}">
        <span class="app-sidebar-icon">${escapeHtml(icon)}</span>
        <span class="app-sidebar-text">${escapeHtml(label)}</span>
        ${item.badge === "offline-review" ? `<span class="app-sidebar-badge" data-sidebar-offline-review-badge hidden aria-live="polite"></span>` : ""}
      </a>
    `;
  }

  function operatorCanReviewOffline(operator) {
    const roles = new Set([
      ...(Array.isArray(operator?.roles) ? operator.roles : []),
      operator?.role
    ].map((role) => String(role || "").trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_")).filter(Boolean));
    return roles.has("dispatcher") || roles.has("admin");
  }

  function paintOfflineReviewCount() {
    const badge = document.querySelector("[data-sidebar-offline-review-badge]");
    if (!badge) return;
    const count = Number(offlineReviewCount);
    const visible = Number.isFinite(count) && count > 0;
    badge.hidden = !visible;
    badge.textContent = visible ? (count > 99 ? "99+" : String(Math.floor(count))) : "";
    badge.setAttribute("aria-label", visible ? `${Math.floor(count)} open Driver PWA sync records` : "No open Driver PWA sync records");
    badge.title = visible ? `${Math.floor(count)} pending` : "";
  }

  async function refreshOfflineReviewCount() {
    if (!path.startsWith("/dispatch") || !operatorCanReviewOffline(window.MBBS_DISPATCH_OPERATOR)) return;
    try {
      const response = await fetch(OFFLINE_REVIEW_COUNT_ENDPOINT, {
        headers: { Accept: "application/json" }
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          offlineReviewCount = null;
          paintOfflineReviewCount();
        }
        return;
      }
      const payload = await response.json();
      const nextCount = Number(payload.count ?? payload.pendingCount ?? payload.unresolvedCount ?? 0);
      if (!Number.isFinite(nextCount) || nextCount < 0) return;
      offlineReviewCount = Math.floor(nextCount);
      paintOfflineReviewCount();
      window.dispatchEvent(new CustomEvent("mbbs-offline-review-count-updated", {
        detail: { count: offlineReviewCount }
      }));
    } catch {
      // Keep the last known badge count during transient network failures.
    }
  }

  function queueOfflineReviewCountRefresh() {
    window.clearTimeout(offlineReviewRefreshTimer);
    offlineReviewRefreshTimer = window.setTimeout(refreshOfflineReviewCount, 350);
  }

  function connectOfflineReviewEvents() {
    if (!("EventSource" in window) || offlineReviewEventSource || !path.startsWith("/dispatch") || !operatorCanReviewOffline(window.MBBS_DISPATCH_OPERATOR)) return;
    offlineReviewEventSource = new EventSource("/api/events?client=offline-review-sidebar");
    offlineReviewEventSource.addEventListener("app-event", (message) => {
      let event;
      try {
        event = JSON.parse(message.data || "{}");
      } catch {
        return;
      }
      if (event.type !== "connected") queueOfflineReviewCountRefresh();
    });
  }

  function handleOfflineReviewAuthChange(event) {
    const operator = event.detail?.operator || null;
    if (!operatorCanReviewOffline(operator)) {
      offlineReviewCount = null;
      paintOfflineReviewCount();
      offlineReviewEventSource?.close();
      offlineReviewEventSource = null;
      return;
    }
    refreshOfflineReviewCount();
    connectOfflineReviewEvents();
  }

  function render() {
    const scoped = currentItems();
    const storedCollapsed = localStorage.getItem(STORAGE_KEY);
    const collapsed = storedCollapsed === "true"
      || (storedCollapsed === null
        && path.startsWith("/mbt")
        && window.matchMedia("(max-width: 760px)").matches);
    document.body.classList.toggle("app-sidebar-collapsed", collapsed);
    document.body.classList.add("has-app-sidebar");
    document.body.style.setProperty("--app-sidebar-width", `${collapsed ? COLLAPSED_WIDTH : WIDTH}px`);

    let sidebar = document.getElementById("appSidebar");
    if (!sidebar) {
      sidebar = document.createElement("aside");
      sidebar.id = "appSidebar";
      sidebar.className = "app-sidebar";
      document.body.prepend(sidebar);
    }

    sidebar.innerHTML = `
      <div class="app-sidebar-head">
        <div class="app-sidebar-brand">
          <strong>MBBS</strong>
          <span>${escapeHtml(scoped.title)}</span>
        </div>
        <button class="app-sidebar-toggle" data-sidebar-toggle type="button" title="${collapsed ? "Expand" : "Collapse"}">${collapsed ? ">" : "<"}</button>
      </div>
      <div class="app-sidebar-scroll">
        <nav class="app-sidebar-section" aria-label="Main modules">
          <div class="app-sidebar-section-title">Modules</div>
          ${visibleMainItems().map(linkHtml).join("")}
        </nav>
        <nav class="app-sidebar-section" aria-label="${escapeHtml(scoped.title)} pages">
          <div class="app-sidebar-section-title">${escapeHtml(scoped.title)}</div>
          ${scoped.items.map(linkHtml).join("")}
        </nav>
      </div>
      <div class="app-sidebar-foot">
        <a class="app-sidebar-link app-sidebar-home" href="/" title="Login">
          <span class="app-sidebar-icon">IN</span>
          <span class="app-sidebar-text">Login</span>
        </a>
      </div>
    `;
    paintOfflineReviewCount();
  }

  function installStyle() {
    if (document.getElementById("appSidebarStyle")) return;
    const style = document.createElement("style");
    style.id = "appSidebarStyle";
    style.textContent = styleHtml();
    document.head.appendChild(style);
  }

  function handleControlSection(event) {
    const link = event.target.closest?.("[data-control-section]");
    if (!link) return;
    const targetPath = new URL(link.href, window.location.origin).pathname;
    const sectionStorageKey = targetPath.startsWith("/admin") ? "mbbs.admin.section" : "mbbs.control.section";
    localStorage.setItem(sectionStorageKey, link.dataset.controlSection || "dashboard");
  }

  async function refreshSidebarAuthority() {
    const token = localStorage.getItem("mbbs.staff.token")
      || localStorage.getItem("mbbs.control.token")
      || localStorage.getItem("mbbs.operator.token")
      || localStorage.getItem("mbbs.dispatch.token")
      || "";
    if (!token) return;
    try {
      const response = await fetch("/api/auth/me", {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        cache: "no-store"
      });
      if (!response.ok) return;
      const payload = await response.json();
      sidebarOperator = payload.operator || null;
      render();
    } catch {
      // Retain the stored authority view while the live session check is temporarily unavailable.
    }
  }

  function handleSidebarAuthChange(event) {
    sidebarOperator = event.detail?.operator || null;
    render();
  }

  function init() {
    installStyle();
    render();
    void refreshSidebarAuthority();
    document.addEventListener("click", (event) => {
      if (event.target.closest?.("[data-sidebar-toggle]")) {
        const currentlyCollapsed = document.body.classList.contains("app-sidebar-collapsed");
        const next = !currentlyCollapsed;
        localStorage.setItem(STORAGE_KEY, next ? "true" : "false");
        render();
        return;
      }
      handleControlSection(event);
    });
    window.addEventListener("mbbs-language-changed", render);
    window.addEventListener("mbbs-auth-operator-changed", handleSidebarAuthChange);
    window.addEventListener("mbbs-auth-operator-changed", handleOfflineReviewAuthChange);
    window.addEventListener("mbbs-offline-review-count-changed", refreshOfflineReviewCount);
    window.addEventListener("mbbs-sidebar-route-changed", () => {
      path = window.location.pathname;
      render();
    });
    window.addEventListener("popstate", () => {
      path = window.location.pathname;
      render();
    });
    const startOfflineReviewCountTimer = () => {
      if (!offlineReviewCountTimer) offlineReviewCountTimer = window.setInterval(refreshOfflineReviewCount, 60000);
    };
    startOfflineReviewCountTimer();
    window.addEventListener("pageshow", () => {
      startOfflineReviewCountTimer();
      void refreshSidebarAuthority();
      refreshOfflineReviewCount();
      connectOfflineReviewEvents();
    });
    window.addEventListener("pagehide", () => {
      window.clearInterval(offlineReviewCountTimer);
      offlineReviewCountTimer = null;
      window.clearTimeout(offlineReviewRefreshTimer);
      offlineReviewEventSource?.close();
      offlineReviewEventSource = null;
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
