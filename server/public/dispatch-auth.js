const DISPATCH_AUTH_TOKEN_KEY = "mbbs.dispatch.token";
const DISPATCH_STAFF_TOKEN_KEY = "mbbs.staff.token";
const DISPATCH_STAFF_ROLE_KEY = "mbbs.staff.role";
const DISPATCH_STAFF_ROLES_KEY = "mbbs.staff.roles";
const DISPATCH_AUTH_FALLBACK_TOKEN_KEYS = ["mbbs.control.token", "mbbs.operator.token"];
let dispatchAuthTokenKey = DISPATCH_AUTH_TOKEN_KEY;
let dispatchAuthToken = readDispatchAuthToken();
let dispatchAuthOperator = null;
const dispatchNativeFetch = window.fetch.bind(window);

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
  if (String(url).startsWith("/api/dispatch") || String(url).startsWith("/api/scm")) {
    return dispatchNativeFetch(input, {
      ...options,
      headers: dispatchAuthHeaders(options.headers || {})
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
  if (clean === "admin") return "/admin";
  if (clean === "dispatcher") return "/dispatch";
  if (clean === "scm" || clean === "scm_staff") return "/scm";
  if (clean === "yard_manager") return "/control";
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

async function dispatchCheckSession(roles) {
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
    window.location.replace(dispatchRoleHome(payload.operator?.role));
    return { redirected: true };
  }
  dispatchAuthOperator = payload.operator;
  return payload.operator;
}

function renderDispatchLogin(mount, message = "") {
  mount.innerHTML = `
    <section class="dispatch-login-panel">
      <div>
        <p>MBBS Transportation</p>
        <h1>Dispatch Login</h1>
      </div>
      ${message ? `<div class="route-notice auth-notice">${message}</div>` : ""}
      <form class="dispatch-login-form" data-form="dispatch-login">
        <label>
          <span>Username</span>
          <input name="username" autocomplete="username" required />
        </label>
        <label>
          <span>Password</span>
          <input name="password" type="password" autocomplete="current-password" required />
        </label>
        <button class="primary-action" type="submit">Login</button>
      </form>
    </section>
  `;
}

async function requireDispatchLogin({ mount, onReady, roles = ["dispatcher", "admin"] }) {
  const existing = await dispatchCheckSession(roles).catch(() => null);
  if (existing?.redirected) return;
  if (existing) return onReady(existing);
  if (localStorage.getItem("mbbs.driver.token")) {
    window.location.replace("/driver");
    return;
  }

  renderDispatchLogin(mount);
  mount.addEventListener("submit", async (event) => {
    const form = event.target.closest("[data-form='dispatch-login']");
    if (!form) return;
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    try {
      const response = await dispatchNativeFetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data)
      });
      if (!response.ok) throw new Error(await response.text());
      const payload = await response.json();
      if (!dispatchCanAccess(payload.operator, roles)) {
        storeDispatchStaffSession(payload.token, payload.operator);
        window.location.replace(dispatchRoleHome(payload.operator?.role));
        return;
      }
      storeDispatchStaffSession(payload.token, payload.operator);
      dispatchAuthTokenKey = DISPATCH_AUTH_TOKEN_KEY;
      dispatchAuthOperator = payload.operator;
      await onReady(payload.operator);
    } catch (error) {
      clearDispatchAuthToken();
      dispatchAuthOperator = null;
      renderDispatchLogin(mount, error.message);
    }
  });
}

function dispatchLogout() {
  if (dispatchAuthToken) {
    dispatchNativeFetch("/api/auth/logout", {
      method: "POST",
      headers: dispatchAuthHeaders()
    }).catch(() => {});
  }
  dispatchAuthToken = "";
  dispatchAuthOperator = null;
  clearDispatchAuthToken();
  location.href = "/";
}
