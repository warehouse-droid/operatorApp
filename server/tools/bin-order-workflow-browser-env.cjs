// Test-only browser executable selection for the read-only application-host sandbox.
const {chromium}=require("playwright");
const launch=chromium.launch.bind(chromium);
chromium.launch=(options={})=>launch({...options,
  executablePath:"/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell",
  args:[...(options.args || []),"--disable-dev-shm-usage"]});
