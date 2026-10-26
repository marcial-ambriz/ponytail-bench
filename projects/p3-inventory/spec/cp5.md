## Checkpoint 5 — Reports: valuation, movements by period, CSV export

All report endpoints and `/reports` are **admin only** (403 for clerks; clerks visiting `/reports` are redirected to
`/`). Reports are computed from the movement history, including movements migrated in checkpoint 4.

### Valuation at moving average cost

- **R5.1** Each variant has a value `V` (integer cents) and units `Q` summed over **all** warehouses, updated by
  replaying its movements in the order they were recorded:
  - `receipt` of `q` units at `c` cents: `Q += q`, `V += q × c`;
  - any movement that removes `q` units (`issue`, `shipment`, negative `adjustment`): `V −= round(V × q / Q)`, then
    `Q −= q` (taken before the removal; so removing all units leaves `V = 0`);
  - positive `adjustment` of `q` units: `V += round(V × q / Q)` when `Q > 0` (enters at the current average cost),
    `+0` when `Q = 0`; then `Q += q`;
  - `transfer_in` / `transfer_out` change neither `V` nor `Q` (they only move units between warehouses).

  `round` rounds half up to a whole cent. The **average cost** is `round(V / Q)` (0 when `Q = 0`).
  Example: receive 3 at 100, receive 1 at 200 (`V` 500, `Q` 4, average 125); issue 1 (`V` 500 − 125 = 375, `Q` 3);
  receive 3 at 0 (`V` 375, `Q` 6, average 63); issue 5 (`V` 375 − round(312.5) = 62, `Q` 1).
- **R5.2** `GET /api/reports/valuation?warehouseId=` → `{ totalValueCents, rows: [{ variantId, sku, productName,
  variantName, onHand, averageCostCents, valueCents }] }`, one row per variant with `onHand > 0` in the scope, ordered
  by SKU. Without `warehouseId`: `onHand = Q`, `valueCents = V`. With `warehouseId` (unknown → 422): `onHand` is the
  variant's units in that warehouse and `valueCents = round(V × onHand / Q)`. `averageCostCents` is always the
  variant's average cost. `totalValueCents` is the sum of the rows' `valueCents`.

### Movements by period

- **R5.3** `GET /api/reports/movements?from=YYYY-MM-DD&to=YYYY-MM-DD&warehouseId=` (`from` and `to` required, valid
  dates, `from ≤ to`, else 422; the period runs from `from` 00:00 UTC to the end of `to`, inclusive; optional
  `warehouseId`, unknown → 422) → `{ from, to, rows: [{ variantId, sku, productName, variantName, opening, received,
  shipped, adjusted, transferred, closing }] }`, ordered by SKU, one row per variant that has a non-zero `opening` or
  at least one movement in the period (in the scope). All values are units:
  `opening` = units before the period; `received` = receipts; `shipped` = issues plus shipments (a positive number);
  `adjusted` = net adjustments (signed); `transferred` = net transfers (signed; always 0 without `warehouseId`);
  `closing` = `opening + received − shipped + adjusted + transferred` = units at the end of the period.

### CSV export

- **R5.4** `GET /api/reports/valuation.csv?warehouseId=` and `GET /api/reports/movements.csv?from=&to=&warehouseId=`
  return the same rows as the JSON reports with `Content-Type: text/csv` and a `Content-Disposition: attachment`
  header. First line (exact headers):
  - valuation: `SKU,Product,Variant,On hand,Average cost,Value`
  - movements: `SKU,Product,Variant,Opening,Received,Shipped,Adjusted,Transferred,Closing`

  Money is written in currency units with exactly two decimals and no symbol or thousands separator (`1234.50`).
  Fields that contain a comma, a double quote or a line break are quoted with double quotes, doubling inner quotes
  (RFC 4180). Lines end with `\n` or `\r\n`. Same validation as the JSON reports.

### Screen

- **R5.5** `/reports` (nav link "Reports", admins only): a section headed "Inventory valuation" with a select
  "Warehouse" (first option "All warehouses", then each warehouse by name), a table with column headers "SKU",
  "Product", "Variant", "On hand", "Average cost", "Value", the text "Total value: $<amount>" (amount with thousands
  separators and two decimals, e.g. "Total value: $1,234.50"; money cells use the same `$` format), and a link
  "Export valuation CSV" pointing at the CSV endpoint for the selected warehouse.
- **R5.6** A section headed "Movements by period" with date inputs "From" and "To" (default: today), a table with
  column headers "SKU", "Opening", "Received", "Shipped", "Adjusted", "Transferred", "Closing", and a link "Export
  movements CSV". Filters apply on change. Empty results show "No data for this period".
