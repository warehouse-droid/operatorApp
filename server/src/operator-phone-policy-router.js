// @ts-check
import { Router } from "express";
import { getOperatorPhonePolicy } from "./operator-phone-policy.js";

export function createOperatorPhonePolicyRouter({ readPolicy = getOperatorPhonePolicy } = {}) {
  const router = Router();
  router.get("/", async (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    try { res.json(await readPolicy()); }
    catch (error) { next(error); }
  });
  return router;
}
