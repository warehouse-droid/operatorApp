import base from "./operator-direct-orderline-eslint.config.mjs";
export default [...base, { ...base[0], files: ["src/return-*.js"] }, {
  ...base.at(-1), files: ["public/operator.js", "public/control.js", "public/sales.js", "public/mbt-gates.js", "public/service-worker.js"]
}];
