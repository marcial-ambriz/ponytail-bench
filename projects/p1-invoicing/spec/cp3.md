# Ledgerly — Checkpoint 3: payments

Builds on checkpoints 1–2 (`cp1.md` contracts apply). Payments arrive two ways: recorded by hand in the app, or
reported by the payment provider **PayFlow** through a signed webhook.

## Balance and status

- **R3.1** An invoice's `paidCents` is the sum of its payments that are not refunded; `balanceCents` =
  `totalCents − paidCents`. The balance can never be negative: no combination of requests, simultaneous or not, may
  record more than the invoice total.
- **R3.2** Statuses become `draft` → `issued` → `paid`, plus `void`. An issued invoice becomes `paid` when its balance
  reaches 0, and goes back to `issued` if a refund makes its balance positive again.
- **R3.3** Payments can be recorded only on `issued` invoices with a positive balance (a draft, void or paid invoice
  → 422). An invoice with any payment that is not refunded cannot be voided → 422 with an error containing "payments";
  the invoice and its payments stay unchanged.

## Manual payments

- **R3.4** `POST /api/orgs/:orgId/invoices/:id/payments` (owner/accountant) with `{ amountCents, method, paidAt?,
  reference? }` → 201 payment. `amountCents` is an integer from 1 to the current balance; more than the balance → 422
  with an error containing "exceeds". `method` is `bank_transfer`, `cash`, `card` or `other`. `paidAt` is a
  `YYYY-MM-DD` date (default today). `reference` is optional text (≤ 100 characters). Invalid values → 422.
- **R3.5** Simultaneous payments on the same invoice are accepted only while they fit in the balance: for example, 50
  simultaneous payments of $10.00 on a $95.00 invoice → exactly 9 succeed (201) and the rest get 422; the balance ends
  at $5.00.
- **R3.6** `GET /api/orgs/:orgId/invoices/:id/payments` → `[{ id, invoiceId, amountCents, method, paidAt, reference,
  source, providerPaymentId, refunded }]`, oldest first. `source` is `"manual"` or `"payflow"`; `providerPaymentId` is
  null for manual payments.

## PayFlow webhook

- **R3.7** Each organization has its own webhook signing secret, created with the organization.
  `GET /api/orgs/:orgId/settings/webhook` (owner only) → `{ secret, url }` where `url` is the path
  `/api/webhooks/payflow/<orgId>`. `POST /api/orgs/:orgId/settings/webhook/rotate` (owner only) → `{ secret, url }`
  with a new secret; from then on only the new secret is accepted.
- **R3.8** PayFlow calls `POST /api/webhooks/payflow/:orgId` (no session) with a JSON body and the header
  `PayFlow-Signature: t=<unix seconds>,v1=<signature>`, where `<signature>` is the lowercase hex HMAC-SHA256 of the
  string `<t>.<raw request body>` keyed with the organization's secret. A request whose header is missing or
  malformed, whose signature does not match, or whose `t` is more than 300 seconds away from the server's clock → 401,
  and nothing is recorded. Unknown organization → 404.
- **R3.9** Event body: `{ "id": "<event id>", "type": "<event type>", "created": <unix seconds>, "data": { "paymentId":
  "<provider payment id>", "invoiceId": "<invoice id>", "amountCents": <integer> } }`. A correctly signed body that
  does not have this shape (missing id, `amountCents` not a positive integer, …) → 422. A valid event returns 200
  `{ "received": true }`.
- **R3.10** `payment.succeeded`: records a payment (`source: "payflow"`, `providerPaymentId` = `data.paymentId`,
  `paidAt` = the UTC date of `created`) on the invoice `data.invoiceId` of **this** organization. An invoice that is not
  this organization's → 422. The same business rules as manual payments apply (R3.3, and an amount above the balance →
  422); an event rejected with 422 is not considered processed.
- **R3.11** `payment.refunded`: the payment with that `data.paymentId` becomes `refunded: true` (refunds are always for
  the full payment amount) and no longer counts toward `paidCents`. Other event types are acknowledged with 200 and
  ignored.
- **R3.12** Delivery is **at least once and in any order**:
  - The same event (same `id`) may be delivered many times, also simultaneously; its effect is applied exactly once,
    and every repeated delivery returns 200.
  - A delivery that reuses an already processed event `id` with a different `type` or `data` → 409, and nothing
    changes.
  - Each provider payment is recorded at most once, even if PayFlow reports its success under several event ids.
  - A `payment.refunded` may arrive before the `payment.succeeded` of the same payment. The end state must be the same
    as if they had arrived in order: the payment is listed as refunded and the balance is unchanged.

## Screens

- **R3.13** On an issued invoice's page, owners and accountants have "Record payment", which opens a dialog with fields
  "Amount" (decimal dollars), "Method" (select with options "Bank transfer", "Cash", "Card", "Other"), "Date" and
  "Reference", and a button "Save payment". Success shows "Payment recorded" and updates "Paid" and "Balance". A
  rejected payment shows the server's error in the dialog and keeps the input.
- **R3.14** The invoice page lists payments under a heading "Payments" in a table with column headers "Date",
  "Amount", "Method", "Source", "Status" (Source "Manual" or "PayFlow"; Status "Received" or "Refunded"). With none it
  shows "No payments yet". Paid invoices show "Status: Paid".
- **R3.15** `/orgs/:orgId/settings` (nav link "Settings", owners only): a heading "Webhook", the webhook URL (full,
  `<web origin>/api/webhooks/payflow/<orgId>`) and the secret as text, and a "Rotate secret" button that opens a dialog
  with "Confirm rotate" and then shows "Secret rotated" and the new secret. Non-owners visiting it see "Only owners can
  manage settings".
