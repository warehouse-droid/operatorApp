export function mutate(source, name) {
  const changes = {
    owner: ["...groupPreparingFields(childOrders),", ""],
    draft: ["if (!group) return draft;", "if (group || !group) return draft;"],
    packing: [") THEN 'packed'\n                    ELSE 'open'", ") THEN 'open'\n                    ELSE 'open'"],
    ownership: ["if (child.preparing_operator_id && String(child.preparing_operator_id) !== String(operatorId))", "if (false && child.preparing_operator_id && String(child.preparing_operator_id) !== String(operatorId))"],
    video: ["if (replacement && video.srcObject)", "if (false && replacement && video.srcObject)"],
    timeout: ["if (Date.now() >= deadline) return preview.failed();", "if (Date.now() >= deadline) return;"],
    stale: ["preview.failed = () => {\n    if (!current()) return;", "preview.failed = () => {"],
    resolution: ["OPERATOR_CAMERA_IDEAL_WIDTH = 1920", "OPERATOR_CAMERA_IDEAL_WIDTH = 8192"],
    viewport: ["Math.min(window.innerHeight, viewport ? viewport.height + viewport.offsetTop : window.innerHeight)","window.innerHeight"]
  };
  if (!name) return source;
  const change = changes[name];
  if (!change || !source.includes(change[0])) throw new Error(`Mutant anchor missing: ${name}`);
  return source.replace(change[0],change[1]);
}
export async function load(url, context, next) {
  const result = await next(url,context);
  if (url.endsWith("/src/delivery-repository.js") && process.env.OPERATOR_GROUP_CAMERA_MUTANT) {
    return {...result,source:mutate(String(result.source),process.env.OPERATOR_GROUP_CAMERA_MUTANT)};
  }
  return result;
}
