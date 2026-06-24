const DISPATCH_AUTH_TOKEN_KEY = "mbbs.dispatch.token";
let dispatchAuthToken = localStorage.getItem(DISPATCH_AUTH_TOKEN_KEY) || "";
let dispatchAuthOperator = null;
const dispatchNativeFetch = window.fetch.bind(window);

function dispatchAuthHeaders(headers = {}) {
  return {
    ...headers,
    ...(dispatchAuthToken ? { Authorization: `Bearer ${dispatchAuthToken}` } : {})
  };
}

window.fetch = (input, options = {}) => {
  const url = typeof input === "string" ? input : input?.url || "";
  if (String(url).startsWith("/api/dispatch")) {
    return dispatchNativeFetch(input, {
      ...options,
      headers: dispatchAuthHeaders(options.headers || {})
    });
  }
  return dispatchNativeFetch(input, options);
};

function dispatchCanAccess(operator) {
  return ["dispatcher", "admin"].includes(operator?.role);
}

async function dispatchCheckSession() {
  if (!dispatchAuthToken) return null;
  const response = await dispatchNativeFetch("/api/auth/me", {
    headers: dispatchAuthHeaders()
  });
  if (!response.ok) {
    dispatchAuthToken = "";
    localStorage.removeItem(DISPATCH_AUTH_TOKEN_KEY);
    return null;
  }
  const payload = await response.json();
  if (!dispatchCanAccess(payload.operator)) return null;
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

async function requireDispatchLogin({ mount, onReady }) {
  const existing = await dispatchCheckSession().catch(() => null);
  if (existing) return onReady(existing);

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
      if (!dispatchCanAccess(payload.operator)) {
        throw new Error("Dispatcher account required.");
      }
      dispatchAuthToken = payload.token;
      dispatchAuthOperator = payload.operator;
      localStorage.setItem(DISPATCH_AUTH_TOKEN_KEY, dispatchAuthToken);
      await onReady(payload.operator);
    } catch (error) {
      dispatchAuthToken = "";
      dispatchAuthOperator = null;
      localStorage.removeItem(DISPATCH_AUTH_TOKEN_KEY);
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
  localStorage.removeItem(DISPATCH_AUTH_TOKEN_KEY);
  location.href = "/dispatch";
}
