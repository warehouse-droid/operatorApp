/**
 * @NApiVersion 2.1
 * @NScriptType Restlet
 * @NModuleScope SameAccount
 */
define(["N/render"], (render) => {
  function get(request = {}) {
    const entityId = Number(request.entityId);
    if (!Number.isInteger(entityId) || entityId <= 0) {
      throw new Error("A valid transaction entityId is required.");
    }
    const location = Number(request.location);
    const options = {
      entityId,
      printMode: render.PrintMode.PDF
    };
    if (Number.isInteger(location) && location > 0) options.location = location;
    const pdf = render.pickingTicket(options);
    return {
      filename: pdf.name || `transaction-${entityId}-picking-ticket.pdf`,
      contentType: "application/pdf",
      locationApplied: Number.isInteger(location) && location > 0,
      locationId: Number.isInteger(location) && location > 0 ? location : null,
      contentBase64: pdf.getContents()
    };
  }
  return { get };
});
