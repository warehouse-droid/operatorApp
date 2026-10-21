import base from "../eslint.mbt.config.js";
export default [...base, {
  ...base[1],
  files: ["src/dispatch-po-route-projection.js", "src/dispatch-history-mode.js", "src/dispatch-completion-repository.js"]
}];
