const DISPATCH_AUTH_TOKEN_KEY = "mbbs.dispatch.token";
const DISPATCH_STAFF_TOKEN_KEY = "mbbs.staff.token";
const DISPATCH_STAFF_ROLE_KEY = "mbbs.staff.role";
const DISPATCH_STAFF_ROLES_KEY = "mbbs.staff.roles";
const DISPATCH_AUTH_FALLBACK_TOKEN_KEYS = ["mbbs.control.token", "mbbs.operator.token"];
const DISPATCH_PUBLIC_SALES_PAGE = window.location.pathname === "/sales" || window.location.pathname.startsWith("/sales/");
const DISPATCH_PUBLIC_SALES_HEADER = "X-MBBS-Sales-Public";
let dispatchAuthTokenKey = DISPATCH_AUTH_TOKEN_KEY;
let dispatchAuthToken = readDispatchAuthToken();
let dispatchAuthOperator = null;
const dispatchNativeFetch = window.fetch.bind(window);

function setDispatchAuthOperator(operator) {
  dispatchAuthOperator = operator || null;
  window.MBBS_DISPATCH_OPERATOR = dispatchAuthOperator;
  window.dispatchEvent(new CustomEvent("mbbs-auth-operator-changed", {
    detail: { operator: dispatchAuthOperator }
  }));
}

function readDispatchAuthToken() {
  const primary = localStorage.getItem(DISPATCH_STAFF_TOKEN_KEY) || localStorage.getItem(DISPATCH_AUTH_TOKEN_KEY) || "";
  if (primary) {
    dispatchAuthTokenKey = localStorage.getItem(DISPATCH_STAFF_TOKEN_KEY) ? DISPATCH_STAFF_TOKEN_KEY : DISPATCH_AUTH_TOKEN_KEY;
    return primary;
  }
  for (const key of DISPATCH_AUTH_FALLBACK_TOKEN_KEYS) {
    const token = localStorage.getItem(key) || "";
    if (token) {
      dispatchAuthTokenKey = key;
      return token;
    }
  }
  dispatchAuthTokenKey = DISPATCH_AUTH_TOKEN_KEY;
  return "";
}

function clearDispatchAuthToken() {
  for (const key of [DISPATCH_STAFF_TOKEN_KEY, DISPATCH_STAFF_ROLE_KEY, DISPATCH_STAFF_ROLES_KEY, DISPATCH_AUTH_TOKEN_KEY, "mbbs.control.token", "mbbs.operator.token"]) {
    localStorage.removeItem(key);
  }
  dispatchAuthToken = "";
  dispatchAuthTokenKey = DISPATCH_AUTH_TOKEN_KEY;
}

function dispatchAuthHeaders(headers = {}) {
  return {
    ...headers,
    ...(dispatchAuthToken ? { Authorization: `Bearer ${dispatchAuthToken}` } : {})
  };
}

window.fetch = (input, options = {}) => {
  const url = typeof input === "string" ? input : input?.url || "";
  if (String(url).startsWith("/api/dispatch") || String(url).startsWith("/api/scm") || String(url).startsWith("/api/sales") || String(url).startsWith("/api/aggregate-requests")) {
    const headers = DISPATCH_PUBLIC_SALES_PAGE && dispatchAuthOperator?.publicSales
      ? { ...(options.headers || {}), [DISPATCH_PUBLIC_SALES_HEADER]: "1" }
      : dispatchAuthHeaders(options.headers || {});
    return dispatchNativeFetch(input, {
      ...options,
      headers
    });
  }
  return dispatchNativeFetch(input, options);
};

function dispatchCanAccess(operator, roles = ["dispatcher", "admin"]) {
  const granted = new Set([
    ...(Array.isArray(operator?.roles) ? operator.roles : []),
    operator?.role
  ].map((role) => String(role || "").trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_")).filter(Boolean));
  return roles.some((role) => granted.has(String(role || "").trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_")));
}

function dispatchRoleHome(role) {
  const clean = String(role || "").trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
  if (clean === "boss") return "/boss";
  if (clean === "admin") return "/admin";
  if (clean === "dispatcher") return "/dispatch";
  if (clean === "scm" || clean === "scm_staff") return "/scm";
  if (clean === "yard_manager") return "/control";
  if (clean === "field_sales") return "/field-sales/";
  if (clean === "sales") return "/sales";
  if (clean === "operator") return "/operator";
  return "/";
}

function storeDispatchStaffSession(nextToken, nextOperator) {
  dispatchAuthToken = nextToken || "";
  if (dispatchAuthToken) {
    localStorage.setItem(DISPATCH_STAFF_TOKEN_KEY, dispatchAuthToken);
    localStorage.setItem(DISPATCH_AUTH_TOKEN_KEY, dispatchAuthToken);
  }
  if (nextOperator?.role) localStorage.setItem(DISPATCH_STAFF_ROLE_KEY, String(nextOperator.role));
  localStorage.setItem(DISPATCH_STAFF_ROLES_KEY, JSON.stringify([
    ...new Set([...(Array.isArray(nextOperator?.roles) ? nextOperator.roles : []), nextOperator?.role].filter(Boolean))
  ]));
}

async function dispatchCheckSession(roles, { redirectOnForbidden = true } = {}) {
  dispatchAuthToken = readDispatchAuthToken();
  if (!dispatchAuthToken) return null;
  const response = await dispatchNativeFetch("/api/auth/me", {
    headers: dispatchAuthHeaders()
  });
  if (!response.ok) {
    clearDispatchAuthToken();
    return null;
  }
  const payload = await response.json();
  storeDispatchStaffSession(dispatchAuthToken, payload.operator);
  if (!dispatchCanAccess(payload.operator, roles)) {
    if (redirectOnForbidden) {
      window.location.replace(dispatchRoleHome(payload.operator?.role));
      return { redirected: true };
    }
    return { forbidden: true, operator: payload.operator };
  }
  setDispatchAuthOperator(payload.operator);
  return payload.operator;
}

async function dispatchPublicSalesSession() {
  if (!DISPATCH_PUBLIC_SALES_PAGE) return null;
  const response = await dispatchNativeFetch("/api/sales/public-access", {
    headers: { [DISPATCH_PUBLIC_SALES_HEADER]: "1" }
  });
  if (!response.ok) return null;
  const payload = await response.json();
  return payload.enabled && payload.operator?.publicSales ? payload.operator : null;
}

async function requireDispatchLogin({ mount, onReady, roles = ["dispatcher", "admin"], allowPublicSales = true }) {
  const existing = await dispatchCheckSession(roles, { redirectOnForbidden: !allowPublicSales }).catch(() => null);
  if (existing?.redirected) return;
  if (existing && !existing.forbidden) return onReady(existing);
  const publicOperator = allowPublicSales
    ? await dispatchPublicSalesSession().catch(() => null)
    : null;
  if (publicOperator) {
    setDispatchAuthOperator(publicOperator);
    return onReady(publicOperator);
  }
  if (existing?.forbidden) {
    window.location.replace(dispatchRoleHome(existing.operator?.role));
    return;
  }
  window.location.replace('/login.html?next=' + encodeURIComponent(location.pathname + location.search + location.hash));
}

function dispatchLogout() {
  if (DISPATCH_PUBLIC_SALES_PAGE && dispatchAuthOperator?.publicSales) {
    location.href = "/sales";
    return;
  }
  if (dispatchAuthToken) {
    dispatchNativeFetch("/api/auth/logout", {
      method: "POST",
      headers: dispatchAuthHeaders()
    }).catch(() => {});
  }
  dispatchAuthToken = "";
  setDispatchAuthOperator(null);
  clearDispatchAuthToken();
  location.href = "/";
}
