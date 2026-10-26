## Checkpoint 3 — Orders, reservations and low-stock alerts

### Reservations and availability

- **R3.1** Products gain `reserved` (units held by open orders) and `available` (= `onHand − reserved`) in every
  product response. `available` can never go below zero, also under concurrent requests.
- **R3.2** From now on an `issue` or a negative `adjustment` may only take **available** stock: more than `available`
  → 409 "Insufficient stock".

### Orders

- **R3.3** `POST /api/orders` (any signed-in user) with `{ customer, lines: [{ productId, quantity }] }`:
  `customer` trimmed, 2–80 characters; 1–20 lines; each `quantity` an integer 1..1,000,000; the same product may not
  appear twice; unknown product → 422. Response 201: `{ id, customer, status: "reserved", lines: [{ productId, sku,
  quantity }], createdAt, createdBy }` (`createdBy` = user's name).
- **R3.4** Creating an order **reserves** every line. If any line asks for more than the product's `available` →
  409 "Insufficient stock" and **nothing** is reserved (all lines or none). Two orders competing for the last unit:
  exactly one succeeds.
- **R3.5** `POST /api/orders/:id/ship` (status `reserved` → `shipped`): for each line, removes the units from stock
  on hand and from `reserved`, and records one movement of type `shipment` (negative quantity, plus an `orderId` field
  on the movement; `orderId` is `null` on other movements). Shipping an order that is not `reserved` → 409, and stock
  is deducted once even if ship is requested many times at once. Returns the order.
- **R3.6** `POST /api/orders/:id/cancel` (status `reserved` → `cancelled`) releases the reservation. Cancelling a
  cancelled order → 200 with no further effect; cancelling a shipped order → 409. Returns the order.
- **R3.7** `GET /api/orders` (newest first; optional `status` filter) and `GET /api/orders/:id`. Unknown id → 404.
- **R3.8** `/orders` (nav link "Orders", everyone): table with column headers "Customer", "Status", "Lines",
  "Created"; status shown as "Reserved", "Shipped" or "Cancelled"; each customer name links to `/orders/:id`. When
  empty: "No orders yet". A "New order" link or button goes to `/orders/new`.
- **R3.9** `/orders/new`: input "Customer"; line 1 has a select "Line 1 product" (each option's text contains the
  product's SKU) and an input "Line 1 quantity"; a button "Add line" adds line 2 ("Line 2 product", "Line 2
  quantity") and so on; button "Place order". On success the app navigates to `/orders/:id`; a rejection shows the
  server's error and keeps the form.
- **R3.10** `/orders/:id`: customer name as heading, the status text, and the lines (SKU and quantity). A `reserved`
  order has buttons "Ship order" (success: "Order shipped") and "Cancel order" (opens an in-page dialog with "Confirm
  cancel"; success: "Order cancelled").
- **R3.11** `/products` gains a column "Available"; `/products/:id` shows "Reserved: <n>" and "Available: <n>".
  `/products/:id` history shows `shipment` movements as "Shipment".

### Low-stock alerts

- **R3.12** Products gain `reorderPoint` (integer 0..1,000,000, default 0), editable by admins (`POST`/`PATCH
  /api/products`; invalid → 422) and in the product dialog as a field "Reorder point".
- **R3.13** A product is **low on stock** when `reorderPoint > 0` and `available ≤ reorderPoint`.
  `GET /api/alerts/low-stock` → `[{ productId, sku, name, available, reorderPoint }]` ordered by SKU (any signed-in
  user).
- **R3.14** `/alerts` (nav link "Alerts", everyone): heading "Low stock" and a table with column headers "SKU",
  "Name", "Available", "Reorder point". When empty: "No low-stock products".
