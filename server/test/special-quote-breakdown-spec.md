# Quote before-and-after discount breakdown

The user clarified that the quote must show: Subtotal before discount, Total Discount with its overall percentage, Subtotal after discount, HST, and Total CAD. The item Amount column must show quantity times the original rate so the visible amounts reconcile with the first subtotal.

Spec approval: not obtained (autonomous run). The user explicitly requested the layout correction; test-site deployment is already authorized in this session. This replaces the prior presentation requirement, not its financial formulas.

The user's exact two-line example is the financial regression fixture:

| Quantity | Original rate | Gross amount | Discount | Savings | Net amount |
| --- | --- | --- | --- | --- | --- |
| 123 | $123.00 | $15,129.00 | 12% | $1,815.48 | $13,313.52 |
| 23 | $123.00 | $2,829.00 | 22% | $622.38 | $2,206.62 |

Required summary: gross $17,958.00; total discount $2,437.86 (13.58%); net $15,520.14; HST (13%) $2,017.62; Total CAD $17,537.76. Both draft and saved quotes must render these values in this order. Applying the savings again to the net amount is a regression.

Ontario's standard HST is 13% according to the [CRA rate guidance](https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/charge-collect-place-supply.html). For discounts offered at the time of sale, GST/HST applies to the reduced selling price according to the [CRA registrant guide, Volume discounts / At the time of sale](https://www.canada.ca/en/revenue-agency/services/forms-publications/publications/rc4022/general-information-gst-hst-registrants.html).

The existing acceptance cases keep their gross, savings, net, tax, and final-total assertions; only the PDF requirements change to require the explicit gross-to-net breakdown and original item amounts. Penny rounding, mixed discounts including ancillary charges, legacy prices, zero/full discounts, Chinese text, packing, requester attribution, ordinary/combined company quotes, and access controls stay covered. The five-row summary must stay together above the footer.

Failure model: displaying net as gross, subtracting savings twice, omitting a subtotal or rendering rows out of order, losing independently rounded cents, applying tax to gross, and overlapping page footers. Actual PDF assertions, three deliberate renderer mutations, financial properties, existing quote integrations, PDFium geometry, and live rendering verify these failures.

Use the existing isolated check/deployment workflow and existing dependencies. No setup installations, migrations, transaction writes, or commits are needed. Runtime change scope is `src/field-sales/company-pdf.js`; the unchanged quote builder is included in verification for financial invariants. Capture the live baseline, reproduce the missing presentation with failing tests, implement the renderer change, run the complete affected verification, inspect the user's rendered example, and release only the verified file change with existing quiescence/rollback checks.
