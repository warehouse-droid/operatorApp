import {readFileSync} from 'node:fs';
import vm from 'node:vm';
export function loadWaitlistList(){
  const context=vm.createContext({window:{}});
  vm.runInContext(readFileSync('public/scm-waitlist-list.js','utf8'),context);
  return context.window.SCMWaitlistList;
}
