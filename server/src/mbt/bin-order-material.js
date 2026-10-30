// @ts-check
import { query } from "../db.js";

/** @param {any} snapshot @param {any} root */
async function chargedBin(snapshot, root) {
  if (!snapshot?.chargeRequestId) {return {};}
  const {rows:[charge]}=await query(`SELECT pricing_snapshot FROM mbt_frontdesk_charge_requests
    WHERE charge_request_id::text=$1 AND (contract_id=$2 OR contract_id IS NULL)`,
  [String(snapshot.chargeRequestId),root.contract_id]);
  return charge?.pricing_snapshot?.bin || {};
}

/** The incoming definition belongs to the bin placed by this order.
 * @param {any} snapshot @param {any} root */
async function placedMaterial(snapshot, root) {
  if (snapshot?.materialId) {return {materialId:snapshot.materialId};}
  const charge=await chargedBin(snapshot,root);
  return {materialCode:snapshot?.dumpItemCode || charge.itemEvidence?.fixedDumpItemCode,
    contentCode:snapshot?.contentCode || charge.calculator?.incomingContentCode};
}

/** An exchange's incoming contents must never replace its outgoing contents.
 * @param {any} root @param {any} line */
async function exchangeMaterial(root, line) {
  const charge=await chargedBin(root.service_snapshot,root);
  if (charge.calculator?.outgoingContentCode) {return {contentCode:charge.calculator.outgoingContentCode};}
  const {rows:[previous]}=await query(`SELECT v.service_snapshot FROM mbt_bin_orders o
    JOIN mbt_service_visits v ON v.service_visit_id=o.order_id
    WHERE o.service_line_id=$1 AND o.order_kind IN ('delivery','exchange')
      AND o.exchange_number<$2 AND v.status<>'cancelled'
    ORDER BY o.exchange_number DESC LIMIT 1`,[root.service_line_id,root.exchange_number]);
  const placed=await placedMaterial(previous?.service_snapshot,root);
  if (placed.materialId || placed.materialCode || placed.contentCode) {return placed;}
  // Older rentals stored their original material only on the service line.
  // A replacement content/charge snapshot means that line now describes the new bin.
  if (root.service_snapshot?.contentCode || root.service_snapshot?.chargeRequestId) {return {};}
  return line.material_id ? {materialId:line.material_id} : placedMaterial(line.pricing_snapshot,root);
}

/** A final collection follows the latest replacement, including legacy rentals
 * whose original return visit still contains its first material ID.
 * @param {any} root @param {any} line */
async function collectionMaterial(root, line) {
  const {rows:[replacement]}=await query(`SELECT v.service_snapshot FROM mbt_bin_orders o
    JOIN mbt_service_visits v ON v.service_visit_id=o.order_id
    WHERE o.service_line_id=$1 AND o.order_kind='exchange' AND v.status<>'cancelled'
    ORDER BY o.exchange_number DESC LIMIT 1`,[root.service_line_id]);
  const snapshot=replacement?.service_snapshot;
  if (snapshot?.contentCode || snapshot?.chargeRequestId || snapshot?.materialId) {return placedMaterial(snapshot,root);}
  if (root.material_id) {return {materialId:root.material_id};}
  if (line.material_id) {return {materialId:line.material_id};}
  return placedMaterial({...root.service_snapshot,...line.pricing_snapshot},root);
}

/** @param {string} issue @param {any} [row] */
function unavailable(issue, row) {
  return {materialId:row?.material_id || null,materialCode:row?.material_code || null,
    displayName:row?.display_name || null,issue};
}

/** @param {any[]} rows */
function catalogMaterial(rows) {
  const active=rows.filter(m=>m.active);
  if (active.length>1) {return unavailable("The order material is ambiguous: multiple active materials match. Correct the material catalog before planning.");}
  const row=active[0];
  if (!row) {return unavailable("The order material is missing or inactive in the material catalog. Ask Front Desk to correct it before planning.",rows[0]);}
  return {materialId:String(row.material_id),materialCode:row.material_code,displayName:row.display_name,issue:null};
}

/** @param {any} definition */
async function resolveMaterial(definition) {
  if (definition.materialId) {
    return catalogMaterial((await query("SELECT * FROM mbt_materials WHERE material_id::text=$1",[String(definition.materialId)])).rows);
  }
  if (definition.materialCode) {
    const {rows}=await query("SELECT * FROM mbt_materials WHERE lower(material_code)=lower($1)",[String(definition.materialCode)]);
    if (rows.length) {return catalogMaterial(rows);}
  }
  const content=String(definition.contentCode || "").trim().toLowerCase();
  if (["soil","asphalt","concrete","garbage"].includes(content)) {
    const {rows}=await query("SELECT * FROM mbt_materials WHERE lower(material_code) ~ $1",[`(^|_|^dump)${content}(_|$)`]);
    return catalogMaterial(rows);
  }
  return unavailable("The order has no supported dump material. Ask Front Desk to correct the order before planning.");
}

/** Resolve only persisted order evidence; dispatch input never defines material.
 * @param {any} root */
export async function binOrderMaterial(root) {
  if (root.order_kind==="delivery") {return null;}
  if (root.order_kind==="exchange" && root.material_id) {return resolveMaterial({materialId:root.material_id});}
  const {rows:[line]}=await query("SELECT material_id,pricing_snapshot FROM mbt_contract_service_lines WHERE service_line_id=$1",[root.service_line_id]);
  if (root.order_kind==="exchange") {return resolveMaterial(await exchangeMaterial(root,line));}
  return resolveMaterial(await collectionMaterial(root,line));
}
