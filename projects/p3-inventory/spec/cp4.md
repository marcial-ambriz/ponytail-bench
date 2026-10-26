## Checkpoint 4 — Warehouses, product variants and transfers (data model change)

The business opens a second warehouse and starts selling products in several variants (sizes, colors). Stock is now
held **per variant and per warehouse**. Your app is already in production: the harness starts this version on the
**database of your checkpoint 3 run**, so the existing data must be migrated automatically and without loss.
Existing API clients and screens must keep working (see "Compatibility").

### Warehouses

- **R4.1** Warehouse: `code` (trimmed, stored upper-case, 2–10 characters from `A–Z`, `0–9`; unique → 409 "already
  exists"), `name` (trimmed, 2–60 characters). A warehouse with code `MAIN` named "Main warehouse" always exists (also
  on a fresh database).
- **R4.2** API: `GET /api/warehouses` → `[{ id, code, name }]` ordered by code (any signed-in user);
  `POST /api/warehouses` → 201; `PATCH /api/warehouses/:id` (`name` only; a different `code` → 422). Writes are admin
  only (403 for clerks).
- **R4.3** `/warehouses` (nav link "Warehouses", admins only; clerks are redirected to `/`): table with column headers
  "Code", "Name"; button "New warehouse" opens an in-page dialog with "Code", "Name", "Save".

### Variants

- **R4.4** A product has one or more **variants**. Variant: `sku` (same rules as product SKUs; unique across **all**
  variants → 409 "already exists"; cannot be changed), `name` (trimmed, 1–60 characters), `reorderPoint` (integer
  0..1,000,000, default 0). Creating a product (`POST /api/products`, same body as before) creates its first variant
  named "Default" with the product's SKU and reorder point.
- **R4.5** `POST /api/products/:id/variants` (admin) with `{ sku, name, reorderPoint? }` → 201 `{ id, productId, sku,
  name, reorderPoint, onHand, reserved, available }`. `PATCH /api/variants/:id` (admin) with `{ name?, reorderPoint? }`
  → the variant. Clerks → 403. Unknown product or variant → 404.
- **R4.6** Every product response gains `variants: [{ id, sku, name, reorderPoint, onHand, reserved, available }]`
  (first variant first, then in creation order) and `stock: [{ warehouseId, warehouseCode, variantId, sku, onHand,
  reserved, available }]` with one entry per variant and warehouse whose `onHand` or `reserved` is not zero. The
  product's own `sku` and `reorderPoint` are those of its first variant; its `onHand`, `reserved` and `available` are
  totals over all variants and warehouses. `GET /api/products?q=` also matches variant SKUs.
- **R4.7** `DELETE /api/products/:id` → 409 "movements" if any of its variants has movements.

### Movements and transfers

- **R4.8** Movements are recorded per variant and warehouse. `POST /api/products/:id/movements` accepts optional
  `variantId` (must belong to the product, else 422) and `warehouseId` (unknown → 422). Without them the movement goes
  to the product's first variant in the `MAIN` warehouse. The stock rules of checkpoints 2 and 3 apply **per variant
  and warehouse**: an issue or negative adjustment may only take that variant's available units in that warehouse.
- **R4.9** Every movement gains `variantId`, `sku` (the variant's), `warehouseId`, `warehouseCode` and `transferId`
  (`null` unless it belongs to a transfer); `balanceAfter` is now the stock on hand of that variant in that warehouse
  right after the movement. `GET /api/products/:id/movements` returns the movements of all its variants (newest first)
  and accepts optional `variantId` and `warehouseId` filters.
- **R4.10** `POST /api/transfers` (any signed-in user) with `{ variantId, fromWarehouseId, toWarehouseId, quantity }`
  moves stock between warehouses. `quantity` integer 1..1,000,000; same source and destination → 422; unknown variant
  or warehouse → 422; more than the variant's available units at the source → 409 "Insufficient stock". A transfer is
  **atomic**: it records exactly two movements, `transfer_out` (negative, at the source) and `transfer_in` (positive,
  at the destination), sharing the transfer's id as `transferId`, or nothing at all. Concurrent transfers never make
  any stock negative and never change the total units of the variant. Response 201: `{ id, variantId, sku,
  fromWarehouseId, toWarehouseId, quantity, createdAt, createdBy }`. `GET /api/transfers` → newest first.
- **R4.11** `/transfers` (nav link "Transfers", everyone): a form with selects "Variant" (each option's text contains
  the variant SKU), "From", "To" (options show warehouse names), an input "Quantity" and a button "Transfer"; success
  shows "Transfer completed"; errors show the server's message. Below, a table with column headers "Date", "SKU",
  "From", "To", "Quantity" ("From" / "To" show warehouse names), newest first.

### Orders

- **R4.12** An order belongs to one warehouse: `POST /api/orders` accepts optional `warehouseId` (default `MAIN`;
  unknown → 422). Each line has **either** `productId` (meaning that product's first variant) **or** `variantId`;
  both or neither → 422; the same variant twice → 422. Reservation and shipment apply to the variant in the order's
  warehouse. Orders gain `warehouseId`; lines gain `variantId` (and keep `productId` and `sku`, now the variant's SKU).
- **R4.13** `/orders/new` gains a select "Warehouse" (options show warehouse names; default "Main warehouse"); line
  product selects list every variant (each option's text contains the variant SKU).

### Low-stock alerts

- **R4.14** Low stock is evaluated **per variant**: `reorderPoint > 0` and the variant's `available` summed over all
  warehouses `≤ reorderPoint`. `GET /api/alerts/low-stock` → `[{ productId, variantId, sku, name, variantName,
  available, reorderPoint }]` ordered by SKU (`name` is the product name). `/alerts` gains a column "Variant".

### Screens

- **R4.15** `/products/:id` gains a section headed "Variants": a table with column headers "SKU", "Variant", "On hand",
  "Available"; admins see a button "Add variant" that opens an in-page dialog with "SKU", "Variant name", "Reorder
  point", "Save". Below it, a section headed "Stock by warehouse": a table with column headers "Warehouse", "SKU",
  "On hand", "Reserved", "Available" ("Warehouse" shows the warehouse name). The "On hand: <n>", "Reserved: <n>" and
  "Available: <n>" texts on the page are product totals.
- **R4.16** The "Record movement" form gains selects "Variant" (each option's text contains the variant SKU; default:
  the first variant) and "Warehouse" (options show warehouse names; default: "Main warehouse"). History gains columns
  "SKU" and "Warehouse" (the warehouse name) and shows transfer movements as "Transfer in" / "Transfer out".

### Compatibility and migration

- **R4.17** Every request that was valid in checkpoints 1–3 keeps working with the same meaning, now applied to the
  product's first variant in `MAIN`. Product, movement and order responses keep all their earlier fields.
- **R4.18** **Migration.** When this version starts on a database written by the checkpoint 3 version, it upgrades it
  automatically, once (restarting does not repeat it or duplicate anything):
  - the `MAIN` warehouse is created; every existing product gets one variant named "Default" with the product's SKU
    and reorder point;
  - all existing stock, reservations, movements and orders belong to that variant in `MAIN`;
  - the ids of products, movements and orders do not change; every movement keeps its type, quantity, unit cost,
    reason, order, user, timestamp and `balanceAfter`, and history order does not change; every order keeps its
    customer, status, lines and creator; every product keeps its `onHand`, `reserved`, `available` and low-stock
    status; users and their roles and passwords keep working.
