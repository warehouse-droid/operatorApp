import {Router} from 'express';
import {MENU_CATALOG} from '../public/menu-order-model.js';
import {getMenuOrder,saveMenuOrder} from './menu-order-repository.js';

export function createMenuOrderRouter({admin = false} = {}) {
  const router = Router();
  router.use((_req, res, next) => {res.setHeader('Cache-Control','no-store');next();});
  router.get('/', async (_req, res, next) => {
    try {
      const saved = await getMenuOrder();
      res.json(admin ? {...saved, catalog:MENU_CATALOG} : {revision:saved.revision,orders:saved.orders});
    } catch (error) {next(error);}
  });
  if (admin) {
    router.put('/', async (req, res, next) => {
      try {res.json(await saveMenuOrder(req.body,req.operator.id));}
      catch (error) {next(error);}
    });
  }
  return router;
}
