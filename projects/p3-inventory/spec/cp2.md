## Checkpoint 2 — Stock movements and history

Stock changes only through **movements**. A movement is an immutable audit record: once written it is never edited
or deleted, and there is no API route that edits or deletes one.

- **R2.1** Movement types: `receipt` (goods in, has a unit cost), `issue` (goods out) and `adjustment` (correction
  after a count, signed). Request: `POST /api/products/:id/movements` with
  `{ type, quantity, unitCostCents?, reason? }`.
  - `receipt`: `quantity` integer 1..1,000,000; `unitCostCents` required, integer 0..100,000,000.
  - `issue`: `quantity` integer 1..1,000,000; `reason` optional (≤ 200 characters).
  - `adjustment`: `quantity` non-zero integer between −1,000,000 and 1,000,000 (negative removes stock); `reason`
    required, 3–200 characters. **Admin only** (403 for clerks).
  - Anything else (unknown type, missing, zero, negative, fractional or non-numeric quantity, quantity sent as a
    string, missing or invalid cost) → 422. Unknown product → 404.
- **R2.2** Stock on hand can **never go below zero**, also under concurrent requests. An issue or negative adjustment
  larger than the stock on hand → 409 with an error containing "Insufficient stock", and nothing is recorded.
- **R2.3** Response 201: the movement `{ id, productId, type, quantity, unitCostCents, reason, balanceAfter, userId,
  userName, createdAt }`, where `quantity` is **signed** (receipt +, issue −, adjustment as sent), `unitCostCents` is
  `null` for non-receipts, `reason` is `null` when absent, and `balanceAfter` is the product's stock on hand right
  after this movement.
- **R2.4** `GET /api/products/:id/movements` → the product's movements, newest first (any signed-in user).
- **R2.5** Products gain `onHand` (current stock, `0` for a new product) in every product response.
- **R2.6** `DELETE /api/products/:id` for a product that has movements → 409 with an error containing "movements";
  the product stays.
- **R2.7** `/products` gains a column "On hand".
- **R2.8** `/products/:id` shows the text "On hand: <n>" and a section headed "Record movement" with a select labeled
  "Type" (options "Receipt", "Issue", and "Adjustment" for admins only), an input "Quantity", an input "Unit cost"
  (receipts; a decimal amount such as `2.50` = 250 cents) and an input "Reason", and a button "Record". Success shows
  "Movement recorded" and updates "On hand"; a rejected movement shows the server's error.
- **R2.9** `/products/:id` has a section headed "History": a table with column headers "Date", "Type", "Quantity",
  "Balance", "User", newest first. "Type" shows "Receipt", "Issue" or "Adjustment"; "Quantity" is signed ("+5",
  "-3"); "Balance" is `balanceAfter`; "User" is the user's name. With no movements it shows "No movements yet".
