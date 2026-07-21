const loginApp = document.getElementById("loginApp");
const loginT = (key, fallback) => window.MBBS_I18N?.t(key, fallback) || fallback;

const STAFF_TOKEN_KEYS = {
  admin: "mbbs.control.token",
  operator: "mbbs.operator.token",
  dispatcher: "mbbs.dispatch.token",
  scm: "mbbs.dispatch.token",
  scm_staff: "mbbs.dispatch.token",
  yard_manager: "mbbs.control.token",
  sales: "mbbs.dispatch.token"
};
const STAFF_TOKEN_KEY = "mbbs.staff.token";
const STAFF_ROLE_KEY = "mbbs.staff.role";
const STAFF_ROLES_KEY = "mbbs.staff.roles";

function cleanRole(role) {
  return String(role || "").trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
}

function routeForStaffRole(role) {
  const clean = cleanRole(role);
  if (clean === "admin") return "/admin";
  if (clean === "operator") return "/operator";
  if (clean === "dispatcher") return "/dispatch";
  if (clean === "scm" || clean === "scm_staff") return "/scm";
  if (clean === "yard_manager") return "/control";
  if (clean === "sales") return "/sales";
  return "";
}

function clearModuleTokens() {
  for (const key of [
    "mbbs.control.token",
    "mbbs.operator.token",
    "mbbs.dispatch.token",
    STAFF_TOKEN_KEY,
    STAFF_ROLE_KEY,
    STAFF_ROLES_KEY,
    "mbbs.driver.token"
  ]) {
    localStorage.removeItem(key);
  }
}

function renderLogin(message = "") {
  loginApp.innerHTML = `
    <section class="login-panel">
      <div class="login-title">
        <p>MBBS Operation</p>
        <h1>${loginT("common.login", "Login")}</h1>
      </div>
      ${message ? `<div class="login-notice">${escapeHtml(message)}</div>` : ""}
      <form class="login-form" data-form="root-login">
        <label>
          <span>${loginT("common.username", "Username")}</span>
          <input name="username" autocomplete="username" required />
        </label>
        <label>
          <span>${loginT("common.password", "Password")}</span>
          <input name="password" type="password" autocomplete="current-password" />
        </label>
        <button class="login-button" type="submit">${loginT("common.login", "Login")}</button>
      </form>
      <div class="login-language">${window.MBBS_I18N?.toggleHtml?.() || ""}</div>
    </section>
  `;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function postJson(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(payload?.error || text || "Login failed.");
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function loginStaff(data) {
  const payload = await postJson("/api/auth/login", data);
  const role = cleanRole(payload.operator?.role);
  const route = routeForStaffRole(role);
  const tokenKey = STAFF_TOKEN_KEYS[role];
  if (!route || !tokenKey) throw new Error("This account does not have an application route.");
  clearModuleTokens();
  localStorage.setItem(STAFF_TOKEN_KEY, payload.token);
  localStorage.setItem(STAFF_ROLE_KEY, role);
  localStorage.setItem(STAFF_ROLES_KEY, JSON.stringify([...new Set([...(Array.isArray(payload.operator?.roles) ? payload.operator.roles : []), role].filter(Boolean))]));
  localStorage.setItem(tokenKey, payload.token);
  location.href = route;
}

async function loginDriver(data) {
  const payload = await postJson("/api/driver/login", data);
  clearModuleTokens();
  localStorage.setItem("mbbs.driver.token", payload.token);
  location.href = "/driver";
}

loginApp.addEventListener("submit", async (event) => {
  const form = event.target.closest("[data-form='root-login']");
  if (!form) return;
  event.preventDefault();
  const button = form.querySelector("button");
  button.disabled = true;
  const data = Object.fromEntries(new FormData(form).entries());
  try {
    try {
      await loginStaff(data);
    } catch (staffError) {
      await loginDriver(data);
    }
  } catch (error) {
    renderLogin(error.message || "Login failed.");
  } finally {
    button.disabled = false;
  }
});

window.addEventListener("mbbs-language-changed", () => renderLogin());
renderLogin();
