(function () {
  const STORAGE_KEY = "mbbs.appSidebar.collapsed";
  const WIDTH = 206;
  const COLLAPSED_WIDTH = 58;

  let path = window.location.pathname;
  if (!path.startsWith("/admin") && !path.startsWith("/control") && !path.startsWith("/dispatch") && !path.startsWith("/scm") && !path.startsWith("/sales")) return;

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
    if (item.controlSection) {
      if (item.href.startsWith("/control")) return path === item.href;
      const storageKey = item.href === "/admin" ? "mbbs.admin.section" : "mbbs.control.section";
      const current = localStorage.getItem(storageKey) || "dashboard";
      return path === item.href && current === item.controlSection;
    }
    if (item.href === "/control") return path.startsWith("/control");
    if (item.href === "/admin") return path.startsWith("/admin");
    if (item.href === "/dispatch") return path === "/dispatch";
    if (item.href === "/scm") return path === "/scm";
    if (item.href === "/sales") return path === "/sales";
    return path === item.href;
  }

  const mainItems = [
    { label: "Admin", href: "/admin", icon: "AD" },
    { label: "Control", href: "/control", icon: "CT" },
    { label: "Dispatch", href: "/dispatch", icon: "DP" },
    { label: "SCM", href: "/scm", icon: "SC" },
    { label: "Sales", href: "/sales", icon: "SA" },
    { label: "Operator", href: "/operator", icon: "OP" },
    { label: "Driver", href: "/driver", icon: "DR" }
  ];

  const dispatchItems = [
    { label: "Menu", href: "/dispatch", icon: "MN" },
    { label: "Planning", href: "/dispatch/planning", icon: "PL" },
    { label: "Monitor", href: "/dispatch/monitor", icon: "MO" },
    { label: "Statistics", href: "/dispatch/statistics", icon: "ST" },
    { label: "DVIR", href: "/dispatch/dvir", icon: "DV" },
    { label: "PO/TO Schedule", href: "/dispatch/po-to-schedule", icon: "PT" },
    { label: "Yard In/Outbound", href: "/dispatch/loaded-export", icon: "YI" },
    { label: "SO Method", href: "/dispatch/sales-order-methods", icon: "SO" },
    { label: "Snapshot", href: "/dispatch/snapshot", icon: "SN" },
    { label: "Setup", href: "/dispatch/setup", icon: "SE" }
  ];

  const scmItems = [
    { label: "SCM Menu", href: "/scm", icon: "SM" },
    { label: "Smart SCM", href: "/scm/smart", icon: "AI" },
    { label: "NetSuite PO", href: "/scm/netsuite-po", icon: "PO" },
    { label: "Local Vendors", href: "/scm/vendors", icon: "LV" },
    { label: "Auto Transfer", href: "/scm/transfer-dependencies", icon: "AT" },
    { label: "PO Split", href: "/scm/POsplit", icon: "PS" },
    { label: "PO/TO Schedule", href: "/scm/POTOschedule", icon: "PT" },
    { label: "VRMA", href: "/scm/VRMA", icon: "VR" },
    { label: "PO Route Rules", href: "/scm/route-rules", icon: "RT" }
  ];

  const salesItems = [
    { label: "Sales Menu", href: "/sales", icon: "SM" },
    { label: "Planning View", href: "/sales/planning", icon: "PL" },
    { label: "PO/TO Schedule", href: "/sales/schedule", icon: "PT" },
    { label: "Truck Monitor", href: "/sales/monitor", icon: "MO" },
    { label: "SO Printing", href: "/sales/printing", icon: "PR" }
  ];

  const controlItems = [
    { label: "Dashboard", href: "/control", controlSection: "dashboard", icon: "DB" },
    { label: "Order Locks", href: "/control/order-locks", controlSection: "locks", icon: "LK" },
    { label: "Item Classification", href: "/control/item-classification", controlSection: "classification", icon: "CL" },
    { label: "Vendor Mapping", href: "/control/vendor-mapping", controlSection: "vendor-mapping", icon: "VM" },
    { label: "Operator Warnings", href: "/control/operator-warnings", controlSection: "warnings", icon: "WN" },
    { label: "Yard In/Outbound", href: "/control/yard-in-outbound", controlSection: "loaded-export", icon: "YI" },
    { label: "Cycle Count Review", href: "/control/cycle-count-review", controlSection: "cycle-count", icon: "CC" },
    { label: "Operator Load Records", href: "/control/operator-load-records", controlSection: "fulfillment", icon: "LD" }
  ];

  const adminItems = [
    { label: "Overview", href: "/admin", controlSection: "dashboard", icon: "OV" },
    { label: "Accounts", href: "/admin", controlSection: "operators", icon: "AC" },
    { label: "Sync", href: "/admin", controlSection: "sync", icon: "SY" },
    { label: "Yard Printers", href: "/admin/printers", icon: "PR" },
    { label: "Photo Storage", href: "/admin", controlSection: "storage", icon: "PS" },
    { label: "Audit", href: "/admin", controlSection: "audit", icon: "AU" }
  ];

  function visibleMainItems() {
    const normalizeRole = (value) => String(value || "").trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
    let savedRoles = [];
    try {
      const parsed = JSON.parse(localStorage.getItem("mbbs.staff.roles") || "[]");
      savedRoles = Array.isArray(parsed) ? parsed : [];
    } catch {
      savedRoles = [];
    }
    const roles = new Set([...savedRoles, localStorage.getItem("mbbs.staff.role")].map(normalizeRole).filter(Boolean));
    if (roles.has("admin")) return mainItems.filter((item) => item.href !== "/driver");
    const visiblePaths = new Set();
    if (roles.has("yard_manager")) ["/control", "/operator"].forEach((href) => visiblePaths.add(href));
    if (roles.has("dispatcher")) ["/dispatch", "/scm"].forEach((href) => visiblePaths.add(href));
    if (roles.has("scm") || roles.has("scm_staff")) visiblePaths.add("/scm");
    if (roles.has("sales")) visiblePaths.add("/sales");
    if (roles.has("operator")) visiblePaths.add("/operator");
    if (visiblePaths.size) return mainItems.filter((item) => visiblePaths.has(item.href));
    return mainItems;
  }

  function currentItems() {
    if (path.startsWith("/admin")) return { title: "Admin", items: adminItems };
    if (path.startsWith("/dispatch")) return { title: "Dispatch", items: dispatchItems };
    if (path.startsWith("/scm")) return { title: "SCM", items: scmItems };
    if (path.startsWith("/sales")) return { title: "Sales", items: salesItems };
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
    `;
  }

  function linkHtml(item) {
    const active = isActive(item);
    const label = t(`sidebar.${item.label.replace(/[^a-z0-9]+/gi, ".").toLowerCase()}`, item.label);
    const icon = item.icon || iconFor(label);
    const sectionAttr = item.controlSection ? ` data-control-section="${escapeHtml(item.controlSection)}"` : "";
    return `
      <a class="app-sidebar-link ${active ? "active" : ""}" href="${escapeHtml(item.href)}"${sectionAttr} title="${escapeHtml(label)}">
        <span class="app-sidebar-icon">${escapeHtml(icon)}</span>
        <span class="app-sidebar-text">${escapeHtml(label)}</span>
      </a>
    `;
  }

  function render() {
    const scoped = currentItems();
    const collapsed = localStorage.getItem(STORAGE_KEY) === "true";
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
    if (targetPath.startsWith("/control")) return;
    if (path.startsWith("/admin") && targetPath.startsWith("/admin")) {
      event.preventDefault();
      window.dispatchEvent(new CustomEvent("mbbs-control-section", {
        detail: { section: link.dataset.controlSection || "dashboard" }
      }));
      render();
    }
  }

  function init() {
    installStyle();
    render();
    document.addEventListener("click", (event) => {
      if (event.target.closest?.("[data-sidebar-toggle]")) {
        const next = !(localStorage.getItem(STORAGE_KEY) === "true");
        localStorage.setItem(STORAGE_KEY, next ? "true" : "false");
        render();
        return;
      }
      handleControlSection(event);
    });
    window.addEventListener("mbbs-language-changed", render);
    window.addEventListener("mbbs-sidebar-route-changed", () => {
      path = window.location.pathname;
      render();
    });
    window.addEventListener("popstate", () => {
      path = window.location.pathname;
      render();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
