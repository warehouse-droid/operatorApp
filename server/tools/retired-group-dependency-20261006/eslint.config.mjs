import base from "../../eslint.mbt.config.js";
export default [
  ...base,
  { ...base[1], files: ["src/order-dependency-repository.js"] }
];
