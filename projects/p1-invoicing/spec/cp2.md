# Ledgerly — Checkpoint 2: customers and invoices

Builds on checkpoint 1. The constraints and contracts in `cp1.md` (tenancy R1.1, roles R1.2, money R1.3, status
codes, UI contract) apply to everything below. Viewers may read customers and invoices; every write below needs
`owner` or `accountant`.

## Customers

- **R2.1** A customer has `name` (trimmed, 1–120 characters) and `email` (a valid address). Emails are unique within
  an organization, compared case-insensitively (duplicate → 409). Different organizations may have customers with
  the same email.
- **R2.2** API: `GET /api/orgs/:orgId/customers` → `[{ id, name, email }]` ordered by name;
  `POST /api/orgs/:orgId/customers` → 201 `{ id, name, email }`; `GET /api/orgs/:orgId/customers/:id`;
  `PATCH /api/orgs/:orgId/customers/:id` (partial update, same rules); `DELETE /api/orgs/:orgId/customers/:id` → 200.
- **R2.3** A customer that has any invoice (in any status) cannot be deleted → 409 with an error containing
  "has invoices"; the customer and its invoices stay unchanged.
- **R2.4** `/orgs/:orgId/customers` (nav link "Customers"): table with column headers "Name", "Email". Button
  "New customer" opens a dialog with fields "Name", "Email" and button "Save". Each row has "Edit" (same dialog,
  prefilled) and "Delete" (dialog with "Confirm delete"). When there are no customers the page shows "No customers
  yet". Viewers see the table without "New customer", "Edit" or "Delete".

## Invoices

- **R2.5** An invoice belongs to one customer of the same organization and has a `dueDate` (`YYYY-MM-DD`, a real
  calendar date; any date is accepted), optional `notes` (≤ 1000 characters) and 1–100 lines. A `customerId` that is
  not a customer of this organization → 422.
- **R2.6** A line has `description` (trimmed, 1–200 characters), `quantity` (integer 1–1000), `unitPriceCents`
  (integer 0–100000000) and `taxRateBps` (tax rate in basis points, integer 0–10000; `1600` = 16%). Any other value
  — negative, fractional (`10.005`), non-numeric, a numeric string, or out of range — → 422.
- **R2.7** Amounts are computed by the server, in integer cents:
  - line `subtotalCents` = `quantity × unitPriceCents`;
  - line `taxCents` = `subtotalCents × taxRateBps / 10000`, **rounded half up to a whole cent, separately for each
    line**;
  - line `totalCents` = line subtotal + line tax;
  - invoice `subtotalCents`, `taxCents` and `totalCents` are the **sums of the line values** (the invoice tax is the
    sum of the rounded line taxes, never a tax computed on the invoice subtotal).
- **R2.8** Statuses: `draft` → `issued` → `void`. (Checkpoint 3 adds `paid`.) A new invoice is a `draft` with
  `number: null` and `issueDate: null`.
- **R2.9** Only drafts can be changed or deleted. Editing or deleting an invoice in any other status → 422, and the
  invoice stays exactly as it was.
- **R2.10** Issuing a draft sets its `issueDate` to today and assigns its `number`: `INV-` followed by the
  organization's next sequence number, zero-padded to at least 4 digits (`INV-0001`, `INV-0002`, … `INV-10000`).
  Each organization has its own sequence starting at 1. Numbers are **consecutive with no gaps and never repeat**
  within an organization, including when many invoices are issued at the same moment. A number is used only by an
  invoice that was successfully issued; voiding keeps the number. An invoice whose total is 0 cannot be issued (422).
  Issuing an invoice that is not a draft → 422; when the same draft is issued by several simultaneous requests,
  exactly one succeeds and only one number is consumed.
- **R2.11** Voiding is allowed only for `issued` invoices (otherwise 422). A voided invoice keeps its number, lines
  and amounts.
- **R2.12** API:
  - `POST /api/orgs/:orgId/invoices` with `{ customerId, dueDate, notes?, lines: [{ description, quantity,
    unitPriceCents, taxRateBps }] }` → 201 invoice.
  - `GET /api/orgs/:orgId/invoices?status=&customerId=` → invoice list, newest first (`status` filters by status).
  - `GET /api/orgs/:orgId/invoices/:id` → invoice.
  - `PATCH /api/orgs/:orgId/invoices/:id` (draft only) with any of `customerId`, `dueDate`, `notes`, `lines` (lines
    replace all existing lines).
  - `DELETE /api/orgs/:orgId/invoices/:id` (draft only) → 200.
  - `POST /api/orgs/:orgId/invoices/:id/issue` → 200 invoice. `POST /api/orgs/:orgId/invoices/:id/void` → 200 invoice.
  - Invoice shape: `{ id, number, status, customerId, customerName, issueDate, dueDate, notes, lines: [{ description,
    quantity, unitPriceCents, taxRateBps, subtotalCents, taxCents, totalCents }], subtotalCents, taxCents, totalCents,
    paidCents, balanceCents }`. Until checkpoint 3, `paidCents` is 0 and `balanceCents` equals `totalCents`. List
    items have the same shape (lines may be omitted).

## Invoice screens

- **R2.13** `/orgs/:orgId/invoices` (nav link "Invoices"): table with column headers "Number", "Customer", "Status",
  "Due date", "Total", "Balance". The Number cell is a link to `/orgs/:orgId/invoices/:id` whose text is the number,
  or "Draft" for drafts. Status shows "Draft", "Issued", "Paid" or "Void". A select labeled "Status" (options "All",
  "Draft", "Issued", "Paid", "Void") filters on change. With no invoices the page shows "No invoices yet".
- **R2.14** A "New invoice" link or button (owner/accountant only) opens `/orgs/:orgId/invoices/new`: a select
  "Customer" (options labeled with customer names), a date input "Due date", a textarea "Notes", and one row of line
  fields per line labeled "Description 1", "Quantity 1", "Unit price 1", "Tax rate 1" (the second line "Description
  2", and so on). "Unit price" is a decimal amount in dollars (R1.3); "Tax rate" is a percentage with at most two
  decimals (`16`, `8.25`). Buttons "Add line" and "Remove line N" (N = line number). Button "Save draft" creates the
  draft and navigates to its page. An invalid amount or rate (for example three decimals) is reported as an error and
  nothing is saved.
- **R2.15** Invoice page `/orgs/:orgId/invoices/:id`: a heading with the number (or "Draft invoice" for a draft); the
  texts "Status: <Status>", "Customer: <name>", "Due date: <YYYY-MM-DD>"; a lines table with column headers
  "Description", "Quantity", "Unit price", "Tax", "Amount" (Amount = line total); and the texts "Subtotal: $…",
  "Tax: $…", "Total: $…", "Paid: $…", "Balance: $…".
- **R2.16** On a draft's page an owner or accountant has "Edit" (opens `/orgs/:orgId/invoices/:id/edit`, the same form
  prefilled, saved with "Save draft"), "Issue invoice" (dialog with "Confirm issue"; success shows "Invoice issued" and
  the number) and "Delete draft" (dialog with "Confirm delete"; returns to the invoice list). An issued invoice has
  "Void invoice" (dialog with "Confirm void"; success shows "Status: Void"). Viewers see no such buttons. Unknown or
  other-organization invoices show "Invoice not found".
