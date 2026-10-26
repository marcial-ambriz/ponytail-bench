# Ledgerly — Checkpoint 5: dashboard and export

Builds on checkpoints 1–4 (`cp1.md` contracts apply). Every member, viewers included, can see the dashboard and
download the export.

## Dashboard

- **R5.1** `GET /api/orgs/:orgId/dashboard?asOf=YYYY-MM-DD` (`asOf` defaults to today; an invalid date → 422) →
  `{ asOf, receivableCents, overdueCents, collectedCents, aging: { currentCents, days1to30Cents, days31to60Cents,
  days61to90Cents, over90Cents } }`.
- **R5.2** Only `issued` invoices with a positive balance are receivable (drafts, void and paid invoices are not).
  `receivableCents` is the sum of their balances. Days past due = `asOf − dueDate` in days. An invoice is in
  `currentCents` when days past due ≤ 0, `days1to30Cents` when 1–30, `days31to60Cents` when 31–60, `days61to90Cents`
  when 61–90, `over90Cents` when more than 90. `overdueCents` is the sum of the four overdue buckets.
- **R5.3** The figures always reconcile with the recorded payments: the five buckets add up to `receivableCents`, and
  each invoice contributes exactly `totalCents − (sum of its payments that are not refunded)`.
- **R5.4** `collectedCents` is the sum of the organization's payments that are not refunded with `paidAt` in the
  calendar month (UTC) of `asOf`.
- **R5.5** `/orgs/:orgId` is the dashboard (nav link "Dashboard"): it shows "Receivable: $…", "Overdue: $…" and
  "Collected this month: $…" for today, and an aging table with column headers "Bucket" and "Amount" and the rows
  "Current", "1-30 days", "31-60 days", "61-90 days", "Over 90 days".

## Export

- **R5.6** `GET /api/orgs/:orgId/exports/invoices.csv?from=YYYY-MM-DD&to=YYYY-MM-DD` → 200 `text/csv` with a
  `Content-Disposition: attachment` header. It contains this organization's invoices that are not drafts (`from` / `to`
  are optional and inclusive on `issueDate`; an invalid date → 422), ordered by number ascending, with exactly this
  header row: `number,customer,status,issue_date,due_date,subtotal,tax,total,paid,balance`. Amounts are decimals with
  two digits and no thousands separator (`1234.50`); status is the lowercase status code.
- **R5.7** Fields are quoted when they contain a comma, a quote or a line break (quotes doubled). A text field that
  begins with `=`, `+`, `-` or `@` is written with a leading single quote (`'=SUM(A1)`) so spreadsheet programs do not
  run it as a formula.
- **R5.8** The dashboard has a link or button "Export invoices CSV" that downloads the export.
