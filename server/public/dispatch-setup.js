const setupApp = document.getElementById("dispatchSetupApp");

let setupTab = "drivers";
let selectedSetupIndex = null;
let drivers = [
  { name: "Alex Wong", license: "AZ", number: "A90211", login: "alex", loadMinutes: 42, unloadMinutes: 36 },
  { name: "Jenny Lee", license: "DZ", number: "D18870", login: "jenny", loadMinutes: 38, unloadMinutes: 32 }
];
let trucks = [
  { plate: "MBBS-101", capacityLbs: 48000 },
  { plate: "MBBS-205", capacityLbs: 44000 },
  { plate: "MBBS-318", capacityLbs: 52000 }
];

function formatLbs(value) {
  return `${Math.round(Number(value || 0)).toLocaleString()} lb`;
}

function truckCapacityLbs(truck) {
  return Number(truck?.capacityLbs || 0) || Number(truck?.capacity || 0) * 2000 || 48000;
}

function renderSetup() {
  setupApp.innerHTML = `
    <section class="dispatch-shell setup-shell">
      <header class="dispatch-topbar">
        <div>
          <p>MBBS Transportation</p>
          <h1>Dispatch Setup</h1>
        </div>
        <div></div>
        <div class="topbar-actions">
          <button onclick="location.href='/dispatch'" type="button">Back to Planner</button>
          <button class="primary" type="button">Save Setup</button>
        </div>
      </header>
      <div class="setup-page">
        <section class="panel">
          <div class="panel-header">
            <h2>Setup Menu</h2>
            <p>Maintain dispatch resources.</p>
          </div>
          <div class="setup-menu">
            <button class="${setupTab === "drivers" ? "active" : ""}" data-tab="drivers" type="button">Drivers</button>
            <button class="${setupTab === "trucks" ? "active" : ""}" data-tab="trucks" type="button">Trucks</button>
          </div>
        </section>
        <section class="panel">
          <div class="panel-header">
            <h2>${setupTab === "drivers" ? "Driver Registration" : "Truck Registration"}</h2>
            <p>${setupTab === "drivers" ? "Driver login, license, and service speed." : "Vehicle plate and weight capacity."}</p>
          </div>
          ${setupTab === "drivers" ? renderDrivers() : renderTrucks()}
        </section>
      </div>
    </section>
  `;
}

function renderDrivers() {
  const selected = Number.isInteger(selectedSetupIndex) ? drivers[selectedSetupIndex] : null;
  return `
    <div class="setup-content">
      <div class="setup-list-column">
        <div class="section-heading-row">
          <strong>Current Drivers</strong>
          <button data-action="new-setup-record" type="button">New</button>
        </div>
        <div class="registration-list setup-list">
        ${drivers.map((driver, index) => `
          <button class="registration-card ${selectedSetupIndex === index ? "selected" : ""}" data-action="select-setup-record" data-index="${index}" type="button">
            <strong>${escapeHtml(driver.name)} | ${driver.license}</strong>
            <span class="muted">License ${escapeHtml(driver.number)} | Login ${escapeHtml(driver.login)}</span>
            <span class="muted">Load ${driver.loadMinutes}m | Unload ${driver.unloadMinutes}m</span>
          </button>
        `).join("")}
        </div>
      </div>
      <form class="registration-form setup-form" data-form="driver">
        <h3>${selected ? "Update Driver" : "Register Driver"}</h3>
        <label><span>Driver name</span><input name="name" value="${escapeHtml(selected?.name || "")}" required /></label>
        <label><span>License class</span><select name="license">
          <option ${selected?.license === "AZ" ? "selected" : ""}>AZ</option>
          <option ${selected?.license === "DZ" ? "selected" : ""}>DZ</option>
        </select></label>
        <label><span>License number</span><input name="number" value="${escapeHtml(selected?.number || "")}" required /></label>
        <label><span>Login</span><input name="login" value="${escapeHtml(selected?.login || "")}" required /></label>
        <label><span>${selected ? "New password optional" : "Password"}</span><input name="password" type="password" ${selected ? "" : "required"} /></label>
        <label><span>Loading minutes</span><input name="loadMinutes" type="number" value="${selected?.loadMinutes || 40}" required /></label>
        <label><span>Unloading minutes</span><input name="unloadMinutes" type="number" value="${selected?.unloadMinutes || 35}" required /></label>
        <button class="primary" type="submit">${selected ? "Update Driver" : "Register Driver"}</button>
      </form>
    </div>
  `;
}

function renderTrucks() {
  const selected = Number.isInteger(selectedSetupIndex) ? trucks[selectedSetupIndex] : null;
  return `
    <div class="setup-content">
      <div class="setup-list-column">
        <div class="section-heading-row">
          <strong>Current Trucks</strong>
          <button data-action="new-setup-record" type="button">New</button>
        </div>
        <div class="registration-list setup-list">
        ${trucks.map((truck, index) => `
          <button class="registration-card ${selectedSetupIndex === index ? "selected" : ""}" data-action="select-setup-record" data-index="${index}" type="button">
            <strong>${escapeHtml(truck.plate)}</strong>
            <span class="muted">Capacity ${formatLbs(truckCapacityLbs(truck))}</span>
          </button>
        `).join("")}
        </div>
      </div>
      <form class="registration-form setup-form" data-form="truck">
        <h3>${selected ? "Update Truck" : "Register Truck"}</h3>
        <label><span>Vehicle plate number</span><input name="plate" value="${escapeHtml(selected?.plate || "")}" required /></label>
        <label><span>Load capacity (lb)</span><input name="capacityLbs" type="number" value="${truckCapacityLbs(selected)}" required /></label>
        <button class="primary" type="submit">${selected ? "Update Truck" : "Register Truck"}</button>
      </form>
    </div>
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

setupApp.addEventListener("click", (event) => {
  const tabButton = event.target.closest("[data-tab]");
  if (tabButton) {
    setupTab = tabButton.dataset.tab;
    selectedSetupIndex = null;
    return renderSetup();
  }
  const selectButton = event.target.closest("[data-action='select-setup-record']");
  if (selectButton) {
    selectedSetupIndex = Number(selectButton.dataset.index);
    return renderSetup();
  }
  const newButton = event.target.closest("[data-action='new-setup-record']");
  if (newButton) {
    selectedSetupIndex = null;
    return renderSetup();
  }
  if (!tabButton) return;
  renderSetup();
});

setupApp.addEventListener("submit", (event) => {
  const form = event.target.closest("form");
  if (!form) return;
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form).entries());
  if (form.dataset.form === "driver") {
    const driver = {
      name: data.name,
      license: data.license,
      number: data.number,
      login: data.login,
      loadMinutes: Number(data.loadMinutes || 40),
      unloadMinutes: Number(data.unloadMinutes || 35)
    };
    if (Number.isInteger(selectedSetupIndex)) drivers[selectedSetupIndex] = driver;
    else {
      drivers.push(driver);
      selectedSetupIndex = drivers.length - 1;
    }
  } else {
    const truck = { plate: data.plate, capacityLbs: Number(data.capacityLbs || 48000) };
    if (Number.isInteger(selectedSetupIndex)) trucks[selectedSetupIndex] = truck;
    else {
      trucks.push(truck);
      selectedSetupIndex = trucks.length - 1;
    }
  }
  renderSetup();
});

renderSetup();
