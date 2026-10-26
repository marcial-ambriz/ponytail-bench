# Ledgerly — Checkpoint 4: CSV import and audit log

Builds on checkpoints 1–3 (`cp1.md` contracts apply).

## CSV import

- **R4.1** Owners and accountants can import customers and draft invoices from CSV files (viewers → 403). Files are
  UTF-8, comma separated, with a header row; a leading byte order mark is ignored; fields may be quoted with `"` (a
  quoted field may contain commas, line breaks and doubled quotes `""`). Lines may end in `\n` or `\r\n`. Header names
  are matched exactly; column order is free; extra columns → the whole file is rejected. Blank lines are skipped.
- **R4.2** API: `POST /api/orgs/:orgId/imports/customers` and `POST /api/orgs/:orgId/imports/invoices`; the request body
  is the CSV text with `Content-Type: text/csv`. A file with no data rows, a missing or unknown column, or more than
  1000 data rows → 422.
- **R4.3** **An import is all or nothing.** If any row is invalid, nothing from the file is stored and the response is
  422 `{ "error": "<message>", "rows": [{ "row": <n>, "errors": ["<message>", …] }] }` listing **every** invalid row,
  where `<n>` is the line number in the file (the header is line 1). On success → 201 `{ "imported": <count> }`.
  Two imports running at the same time must not, together, break a rule that each would respect alone (for example,
  create two customers with the same email).
- **R4.4** Customers file: columns `name`, `email`. Each row follows R2.1. An email that already exists in the
  organization, or that appears twice in the file, is an invalid row (each repeated row is reported).
  `imported` is the number of customers created.
- **R4.5** Invoices file: columns `invoice_ref`, `customer_email`, `due_date`, `description`, `quantity`, `unit_price`,
  `tax_rate`. Each row is one invoice line; rows with the same `invoice_ref` form one draft invoice (lines in file
  order), and must share the same `customer_email` and `due_date` (else every row of that ref is invalid).
  `customer_email` must be an existing customer of this organization. `unit_price` is a decimal in dollars with at most
  two decimals (`19.99`, `5`, `0.5`) and `tax_rate` a percentage with at most two decimals (`16`, `8.25`); they convert
  to `unitPriceCents` and `taxRateBps` exactly and follow R2.6. `imported` is the number of invoices created.
- **R4.6** `/orgs/:orgId/import` (nav link "Import", owners and accountants): two sections with headings "Import
  customers" and "Import invoices", each with a file input ("Customers CSV" / "Invoices CSV") and a button ("Import
  customers" / "Import invoices"). Success shows "Imported N customers" / "Imported N invoices". A rejected file shows
  an error containing "Nothing was imported" and a table with column headers "Row", "Error" (one row per error
  message).

## Audit log

- **R4.7** Every successful change to an organization's data appends one audit entry to that organization's log:
  `{ id, at, actorId, actorName, action, entityType, entityId }` (`at` ISO timestamp; `actorId`/`actorName` are null
  when the change came from the PayFlow webhook). Actions:

  | Action | Entity type | When |
  |---|---|---|
  | `member.role_changed`, `member.removed` | `member` (id = user id) | R1.14, R1.15 |
  | `invitation.created`, `invitation.accepted` | `invitation` | R1.18, R1.21 |
  | `customer.created`, `customer.updated`, `customer.deleted` | `customer` | R2.2 |
  | `invoice.created`, `invoice.updated`, `invoice.deleted`, `invoice.issued`, `invoice.voided` | `invoice` | R2.12 |
  | `payment.recorded`, `payment.refunded` | `payment` | R3.4, R3.10, R3.11 |
  | `import.customers`, `import.invoices` | `import` | R4.4, R4.5 (one entry per successful file) |
  | `webhook.secret_rotated` | `organization` | R3.7 |

  A request that fails (any 4xx) appends nothing, and a repeated webhook delivery appends nothing. An entry is stored
  if and only if its change is stored.
- **R4.8** The log is **append-only**: no API request can change or delete an entry; there is no route for it
  (requests to do so get 404 or 405 and change nothing).
- **R4.9** `GET /api/orgs/:orgId/audit?entityType=&entityId=` (owners and accountants; viewers → 403) → entries newest
  first (both filters optional).
- **R4.10** `/orgs/:orgId/audit` (nav link "Audit log", owners and accountants): table with column headers "Time",
  "Actor", "Action", "Entity", newest first. Actor is the member's name, or "PayFlow" for webhook changes. The Action
  cell shows the action code (for example `invoice.issued`).
