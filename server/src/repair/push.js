import webpush from 'web-push';
import {query} from '../db.js';
import {actorKey,fail} from '../../public/repair/domain.js';
import {hash} from './repository.js';
export function createRepairPush(config){
 const settings=config.driverRoutePush||{},active=Boolean(settings.vapidPublicKey&&settings.vapidPrivateKey&&settings.vapidSubject);
 let busy=false;
 return {publicKey:active?settings.vapidPublicKey:'',
  async subscribe(actor,input){
   if(!active)throw fail('Push notifications are not configured.',503);
   let url;try{url=new URL(input.endpoint);}catch{throw fail('Invalid push endpoint.');}
   if(url.protocol!=='https:'||url.username||url.password||url.port||!['fcm.googleapis.com','updates.push.services.mozilla.com','web.push.apple.com','wns.windows.com'].some(host=>url.hostname===host||url.hostname.endsWith('.'+host)))throw fail('Unsupported push endpoint.');
   if(!/^[\w=-]{80,180}$/u.test(input.keys?.p256dh||'')||!/^[\w=-]{16,100}$/u.test(input.keys?.auth||''))throw fail('Invalid push keys.');
   const subscription={endpoint:url.href,keys:{p256dh:input.keys.p256dh,auth:input.keys.auth}};
   await query('INSERT INTO repair_push_subscriptions(actor,endpoint_hash,subscription) VALUES($1,$2,$3) ON CONFLICT(actor,endpoint_hash) DO UPDATE SET subscription=EXCLUDED.subscription',[actorKey(actor),hash(url.href),subscription]);return {ok:true};
  },
  async tick(){if(!active||busy)return;busy=true;try{
   const rows=(await query("SELECT * FROM repair_notifications WHERE pushed_at IS NULL AND recipient LIKE 'driver:%' OR pushed_at IS NULL AND recipient LIKE 'staff:%' ORDER BY created_at LIMIT 30")).rows;
   for(const notice of rows){const subscriptions=(await query('SELECT * FROM repair_push_subscriptions WHERE actor=$1',[notice.recipient])).rows;let retry=false;
    for(const entry of subscriptions){try{await webpush.sendNotification(entry.subscription,JSON.stringify({type:'repair',title:'Repair update',body:notice.message,url:`/repair/?mode=${notice.recipient.startsWith('driver:')?'driver':'staff'}#${notice.request_id||''}`}),{TTL:86400,timeout:10000,vapidDetails:{subject:settings.vapidSubject,publicKey:settings.vapidPublicKey,privateKey:settings.vapidPrivateKey}});}catch(error){if([404,410].includes(error.statusCode))await query('DELETE FROM repair_push_subscriptions WHERE actor=$1 AND endpoint_hash=$2',[entry.actor,entry.endpoint_hash]);else retry=true;}}
    if(!retry)await query('UPDATE repair_notifications SET pushed_at=now() WHERE id=$1',[notice.id]);
   }
  }finally{busy=false;}}
 };
}
