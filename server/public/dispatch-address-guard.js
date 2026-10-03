(function (root) {
  const text = value => String(value ?? "").trim();
  const fields = ["address", "destinationAddress", "defaultDestinationAddress", "dropAddress"];
  const api = {
    preserve(previous = {}, next = {}) {
      const order = { ...next };
      const warnings = [];
      for (const field of fields) {
        if (!text(previous[field]) || text(next[field])) {continue;}
        order[field] = previous[field];
        if (field === "address") {warnings.push({
          code: "DISPATCH_BLANK_ADDRESS_PRESERVED", orderRef: text(next.id || previous.id),
          field, before: previous[field], attempted: next[field] ?? "", after: previous[field],
          message: `${text(next.id || previous.id)}: blank delivery address ignored; retained “${previous[field]}”. Check the source details before changing the address.`
        });}
      }
      if (Array.isArray(next.childOrderDetails)) {
        const byRef = new Map((previous.childOrderDetails || []).map(child => [text(child.id).toUpperCase(), child]));
        order.childOrderDetails = next.childOrderDetails.map(child => {
          const result = api.preserve(byRef.get(text(child.id).toUpperCase()) || {}, child);
          warnings.push(...result.warnings);
          return result.order;
        });
      }
      const purchaseOrder = text(next.type || previous.type).toUpperCase() === "PO"
        || text(next.sourceTable || next.source_table || previous.sourceTable || previous.source_table) === "purchase_orders";
      if (!purchaseOrder && order.raw && text(order.address) && !text(order.raw.dispatch_address)) {
        order.raw = { ...order.raw, dispatch_address: order.address };
      }
      return { order, warnings };
    },
    validate(orderRef, patch = {}) {
      if (!Object.hasOwn(patch, "address") || text(patch.address)) {return null;}
      return { code: "DISPATCH_ADDRESS_REQUIRED", orderRef: text(orderRef), field: "address",
        message: `${text(orderRef)}: delivery address cannot be blank. Enter a valid address; the existing address has been kept.` };
    }
  };
  root.DispatchAddressGuard = api;
})(globalThis);
