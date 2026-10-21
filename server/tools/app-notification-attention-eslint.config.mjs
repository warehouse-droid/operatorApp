import base from './delivery-timeslot-notifications-eslint.config.mjs';
export default [...base,{
  files:['public/app-alert-sound.js'],
  languageOptions:base.at(-1).languageOptions,
  rules:base.at(-1).rules
}];
