# Maintenance task: cycle counts per warehouse

Stockly is in production (all checkpoints of `docs/SPEC.md` are done). The warehouse team wants **cycle counts**: count
the shelves of one warehouse and correct the system stock to what was counted. Implement it in the existing app
without breaking anything that works today (all earlier API calls, screens and data stay as they are).

Same conventions as the spec: JSON under `/api`, `{ "error": "<message>" }` bodies, `401` / `403` / `404` / `409` /
`422` / `201`, UTC timestamps, accessible UI (labels, role + name, errors in `role="alert"`).

## API

- **RM.1** `POST /api/cycle-counts` (admin only) with `{ warehouseId }` (unknown → 422) starts a count →
  201 `{ id, warehouseId, status: "open", createdAt, lines: [{ variantId, sku, expected, counted }] }`, with one line
  per variant whose stock on hand or reserved units in that warehouse are not zero, ordered by SKU; `expected` is the
  stock on hand when the count starts and `counted` is `null`. Only one open count per warehouse: a second one → 409.
- **RM.2** `GET /api/cycle-counts` (newest first) and `GET /api/cycle-counts/:id` (unknown → 404), any signed-in user.
- **RM.3** `PUT /api/cycle-counts/:id/lines/:variantId` (admins and clerks) with `{ counted }` (integer
  0..1,000,000, else 422) records the counted units → the count. A variant that is not a line of the count → 404;
  a count that is not open → 409.
- **RM.4** `POST /api/cycle-counts/:id/post` (admin only) applies the count: every line must be counted (else 422).
  For each line the stock on hand of that variant in that warehouse becomes exactly `counted`, recorded as one
  `adjustment` movement per line whose quantity is `counted − current stock on hand` (no movement when it is zero) with
  a reason that starts with "Cycle count". Movements made after the count started are respected: the correction is
  computed when posting. If any line's `counted` is lower than that variant's reserved units in the warehouse → 409
  and nothing is applied. All lines are applied or none. Status becomes `posted` (with `postedAt`); posting again → 409.
- **RM.5** `POST /api/cycle-counts/:id/cancel` (admin only): an open count becomes `cancelled` and changes no stock;
  a posted count → 409.

## Screen

- **RM.6** `/cycle-counts` (nav link "Cycle counts", everyone). Admins see a select "Warehouse" and a button "Start
  count". Each open count shows its warehouse name and a table with column headers "SKU", "Expected", "Counted"; each
  row has an input labeled "Counted <SKU>" (e.g. "Counted AB-1"). Its button "Save counts" stores every filled input and
  shows "Counts saved"; admins also see "Post count", which shows "Count posted" on success or the server's error.
