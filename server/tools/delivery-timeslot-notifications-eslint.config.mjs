import base from './delivery-request-eslint.config.mjs';
export default [...base,{
  files:['public/app-notifications.js','public/app-notification-worker.js'],
  languageOptions:{...base.at(-1).languageOptions,globals:{...base.at(-1).languageOptions.globals,Notification:'readonly',self:'readonly',TextEncoder:'readonly',Uint8Array:'readonly'}},
  rules:base.at(-1).rules
}];
