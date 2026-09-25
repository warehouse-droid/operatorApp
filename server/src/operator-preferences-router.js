import { Router } from "express";
import { getOperatorPreferences, putOperatorPreferences } from "./operator-preferences-repository.js";

export function createOperatorPreferencesRouter() {
  const router = Router();
  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (!req.operator?.id) return res.status(401).json({ error: "Sign in to configure display preferences." });
    next();
  });
  router.get("/", async (req, res, next) => {
    try { res.json(await getOperatorPreferences(req.operator.id)); } catch (error) { next(error); }
  });
  router.put("/", async (req, res, next) => {
    try { res.json(await putOperatorPreferences(req.operator.id, req.body)); } catch (error) { next(error); }
  });
  return router;
}
