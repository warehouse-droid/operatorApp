export default [{
  files:["tools/so-delivery-cleanup-*.mjs","tools/co-source-cleanup-*.mjs","src/local-co-loaded-policy.js"],
  languageOptions:{ecmaVersion:2022,sourceType:"module",globals:{process:"readonly",console:"readonly",URL:"readonly",Map:"readonly",Set:"readonly",structuredClone:"readonly"}},
  rules:{"no-undef":"error","no-unused-vars":["error",{argsIgnorePattern:"^_"}],"no-unreachable":"error",eqeqeq:"error","no-var":"error",complexity:["error",20],"max-depth":["error",4]}
}];
