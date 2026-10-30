// @ts-check
import {getTransportPlanning,getTransportPlanningTrip} from './bin-transport-read.js';
import {getTransportOptions,saveTransportTrip,cancelTransportTrip} from './bin-transport-service.js';
import {listAggregateRouting,saveAggregateRouting} from './aggregate-routing.js';
import {configureTransportSourceLoader} from './bin-transport-sources.js';

/** @param {import('express').Router} router @param {any} boundary */
export function installTransportRoutes(router,boundary) {
  configureTransportSourceLoader(boundary.loadOrders);
  const read=(/** @type {any} */ handler,bin=true)=>async(/** @type {any} */ req,/** @type {any} */ res,/** @type {any} */ next)=>{
    try {if (bin) {await boundary.authorize(req);}res.set('Cache-Control','no-store');res.json(await handler(req));}
    catch(error) {next(error);}
  };
  const write=(/** @type {any} */ handler,bin=true)=>async(/** @type {any} */ req,/** @type {any} */ res,/** @type {any} */ next)=>{
    try {
      if (bin) {await boundary.authorize(req);}
      const result=await handler(req);res.set('Cache-Control','no-store');res.set('x-mbt-idempotent-replay',String(result.replayed));
      res.status(result.status).json(result.body);
    } catch(error) {next(error);}
  };
  const sources={loadOrders:boundary.loadOrders};
  router.get('/planning/transport',boundary.dispatcher,read((/** @type {any} */ req)=>getTransportPlanning(req.query,sources)));
  router.get('/planning/transport/options',boundary.dispatcher,read((/** @type {any} */ req)=>getTransportOptions(req.query,sources)));
  router.get('/planning/transport/trips/:tripId',boundary.dispatcher,read((/** @type {any} */ req)=>getTransportPlanningTrip(req.params.tripId)));
  router.post('/planning/transport/trips',boundary.dispatcher,write((/** @type {any} */ req)=>saveTransportTrip({...req.body,...boundary.command(req)},sources)));
  router.post('/planning/transport/trips/:tripId/cancel',boundary.dispatcher,write((/** @type {any} */ req)=>cancelTransportTrip({...req.body,
    tripId:req.params.tripId,...boundary.command(req)})));
  router.get('/config/aggregate-routing',boundary.admin,read((/** @type {any} */ req)=>listAggregateRouting(req.query),false));
  router.put('/config/aggregate-routing/:itemId',boundary.admin,write((/** @type {any} */ req)=>saveAggregateRouting({...req.body,
    itemId:req.params.itemId,...boundary.command(req)}),false));
}
