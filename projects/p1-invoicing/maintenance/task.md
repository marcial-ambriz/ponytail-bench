# Maintenance task: credit notes

Ledgerly (this repository) is a multi-tenant invoicing app; its specification is in `SPEC/` (all of it still applies). Add **credit notes**: a credit note reduces what a customer owes on an issued invoice, for example
after a partial refund or a discount agreed after issuing. Keep every existing feature working.

Requirement IDs (`M1.4`) are used by reviewers.

## API

- **M1.1** `POST /api/orgs/:orgId/invoices/:id/credit-notes` (owners and accountants; viewers → 403; non-members →
  404) with `{ amountCents, reason }` → 201 `{ id, number, invoiceId, amountCents, reason, createdAt }`.
  `amountCents` is an integer number of cents from 1 to the invoice's current balance; above the balance → 422 with an
  error containing "exceeds". `reason` is trimmed, 1–200 characters. Other invalid values → 422. Only `issued`
  invoices with a positive balance accept credit notes (draft, void or paid → 422).
- **M1.2** Credit note numbers are `CN-` followed by the organization's next credit-note sequence number, zero-padded
  to at least 4 digits (`CN-0001`). Each organization has its own sequence starting at 1; numbers are consecutive and
  never repeat, also when many credit notes are created at the same moment.
- **M1.3** Every invoice gains `creditedCents` (sum of its credit notes, 0 when none) and its balance becomes
  `balanceCents = totalCents − paidCents − creditedCents`. The balance can never be negative, whatever combination of
  simultaneous payments and credit notes arrives: payments (manual or PayFlow) are limited to this balance too. An
  issued invoice becomes `paid` when its balance reaches 0, including when credit notes bring it there.
- **M1.4** `GET /api/orgs/:orgId/invoices/:id/credit-notes` (any member) → that invoice's credit notes, oldest first,
  with the shape of M1.1.
- **M1.5** An invoice with any credit note cannot be voided (422).
- **M1.6** Creating a credit note appends an audit entry with action `credit_note.created`, entity type `credit_note`
  and the credit note's id.
- **M1.7** The dashboard and the CSV export use the new balance (receivable amounts and aging buckets; the export's
  `balance` column). The export's other columns do not change.

## Screens

- **M1.8** On an issued invoice's page, owners and accountants have "Issue credit note", which opens a dialog with
  fields "Amount" (decimal dollars) and "Reason" and a button "Save credit note". Success shows "Credit note issued".
  Server errors are shown in the dialog. The page shows "Credited: $…" next to the other totals and a section headed
  "Credit notes" with a table "Number", "Date", "Amount", "Reason" (or "No credit notes yet"). Viewers see no "Issue
  credit note" button.
