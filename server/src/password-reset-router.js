import {Router} from 'express';
import {createPasswordResetService} from './password-reset-service.js';
import {createPasswordResetMailer} from './password-reset-mail.js';

export function createPasswordResetRouter({service=createPasswordResetService({mailer:createPasswordResetMailer()})}={}) {
  const router=Router();
  router.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  for(const action of ['request','verify','complete']){
    router.post('/'+action,async(req,res)=>{
      try {res.json(await service[action](req.body,{ip:req.ip}));}
      catch(error){
        const status=[400,429,503].includes(error.status)?error.status:503;
        if(status===429){res.set('Retry-After','600');}
        res.status(status).json({error:status===503?'Password reset is temporarily unavailable. Please try again later.':error.message});
      }
    });
  }
  return router;
}
