import { rebuildDispatchPlanLoadAssignments } from "./dispatch-load-assignment-repository.js";

const planIdArg = process.argv.find((value) => /^--plan-id=\d+$/.test(value));
const planId = planIdArg ? Number(planIdArg.split("=")[1]) : null;

try {
  const result = await rebuildDispatchPlanLoadAssignments({ planId });
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  process.exitCode = 0;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
