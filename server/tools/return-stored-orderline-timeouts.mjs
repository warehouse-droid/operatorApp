// Bound pre-existing tests that await an unfulfilled browser gate indefinitely.
// Apply the same deadlines to baseline and final; a timeout remains a failure.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

if (process.env.MBT_TEST_ISOLATED === "1") {
  const spawn = childProcess.spawn;
  childProcess.spawn = function (command, args, options) {
    const test = command === process.execPath && Array.isArray(args) && args.includes("--test");
    const bounded = test ? ["--test-timeout=120000", ...args] : args;
    const child = spawn.call(this, command, bounded, options);
    if (test) {
      const timeout = setTimeout(() => {
        console.error("Isolated return-fix verification: file exceeded 300 seconds: " + args.at(-1));
        child.kill("SIGTERM");
      }, 300000);
      timeout.unref();
      child.once("exit", () => clearTimeout(timeout));
    }
    return child;
  };
  syncBuiltinESMExports();
}
