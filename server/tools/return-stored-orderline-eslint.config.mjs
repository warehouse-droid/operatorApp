import base from "./return-ra-eslint.config.mjs";
export default [...base, { ...base[0], files: ["src/return-stored-orderline.js", "test/mbt/**/return-stored-orderline.test.js"] }];
