import base from "../eslint.mbt.config.js";
export default [...base, {...base[1],files:["src/**/*.js","test/dispatch/**/*direct-ship*.js","tools/direct-ship*.mjs"]}];
