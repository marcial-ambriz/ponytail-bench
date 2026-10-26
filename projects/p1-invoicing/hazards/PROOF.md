# Hazard suite: proof that every test bites

Each hazard test was run against the reference (it passes: 38/38, see the bottom) and against at least one deliberately
**unsafe variant** of the reference that breaks exactly the rule the test protects. Every variant was applied to a
throwaway copy of `reference/`, booted on a fresh database, checked with only its target tests, and then removed
(nothing of it is kept in the project except the diffs below). A test counts as proven when it **fails** on its variant.

Concurrency variants make the protective check non-atomic by moving it before an `await` (30 ms), which is how an
async data layer or a check-then-write without a transaction behaves; the reference's own checks run inside one
synchronous transaction.

Date of the proof run: 2026-10-25 (UTC 2026-10-26). Driver: a scratch script (not shipped) that applies the edit, runs
`npx playwright test --grep "[hzN.MM]"` with `SUITE=hazards`, records the result and reverts.

## Coverage

| Test | Req | Category | Sev | What it protects | Fails on |
|---|---|---|---|---|---|
| hz1.01 | R1.1 | authz | 3 | a non-member cannot read or change another organization's members or invitations (404, nothing changes) | V01 |
| hz1.02 | R1.2 | authz | 3 | accountants and viewers cannot change roles, including promoting themselves to owner (403) | V02 |
| hz1.03 | R1.21 | authz | 3 | an invitation cannot be accepted by another account, nor reused after it was accepted | V04 |
| hz1.04 | R1.16 | concurrency | 2 | two owners demoting each other at the same moment still leave at least one owner | V05 |
| hz1.05 | R1.2 | authz | 2 | a demoted or removed member loses write access on the very next request | V06 |
| hz2.01 | R1.1 | authz | 3 | another organization's invoice is 404 for every read and write, through either organization's path, and stays unchanged | V07 |
| hz2.02 | R2.5 | authz | 3 | an invoice cannot reference another organization's customer (422 on create and edit; nothing stored) | V08 |
| hz2.03 | R1.2 | authz | 3 | a viewer cannot create, edit, issue, void or delete anything (403) and nothing changes | V03 |
| hz2.04 | R2.6 | validation | 3 | amounts must be integer cents in range: negative, 10.005, above 2^53 or numeric strings -> 422 | V09 |
| hz2.05 | R2.10 | concurrency | 3 | 20 drafts issued at the same moment get INV-0001..INV-0020 with no gaps or duplicates | V10 |
| hz2.06 | R2.10 | concurrency | 2 | the same draft issued by 10 simultaneous requests: exactly one succeeds and one number is consumed | V10 |
| hz2.07 | R2.10 | concurrency | 2 | simultaneous issuing in two organizations keeps two independent gap-free sequences | V10 |
| hz2.08 | R2.9 | data-loss | 2 | an issued invoice cannot be edited or deleted: its number, lines and totals survive | V11 |
| hz2.09 | R2.3 | data-loss | 2 | deleting a customer that has invoices is refused and its invoices stay intact | V12 |
| hz3.01 | R3.12 | idempotency | 3 | 50 identical webhook deliveries at the same moment record one payment | V13 |
| hz3.02 | R3.12 | idempotency | 3 | 5 sequential redeliveries of the same event apply it once | V13 |
| hz3.03 | R3.12 | idempotency | 3 | reusing a processed event id with another amount is rejected (409) and changes nothing | V13 |
| hz3.04 | R3.12 | idempotency | 2 | a refund that arrives before its payment leaves the balance unchanged | V14 |
| hz3.05 | R3.12 | idempotency | 2 | one provider payment reported under several event ids (also simultaneously) is recorded once | V13 |
| hz3.06 | R3.8 | authz | 3 | unsigned, wrongly signed, tampered or replayed (stale) deliveries -> 401 and nothing is recorded | V15 |
| hz3.07 | R3.10 | authz | 3 | webhooks cannot cross tenants: another organization's secret -> 401; another organization's invoice -> 422 | V15, V16 |
| hz3.08 | R3.7 | authz | 3 | after rotating the secret, deliveries signed with the old one are rejected (401) | V15 |
| hz3.09 | R3.7 | authz | 2 | only owners see or rotate the webhook secret; viewers cannot record payments; outsiders cannot read payments | V01, V02, V03 |
| hz3.10 | R3.5 | concurrency | 3 | 50 simultaneous $10.00 payments on a $95.00 invoice: exactly 9 succeed and the balance ends at $5.00 | V17 |
| hz3.11 | R3.1 | concurrency | 2 | simultaneous webhook payments (different provider payments) never push the balance below zero | V17 |
| hz3.12 | R3.4 | validation | 3 | payment amounts must be positive integer cents within the balance -> 422 otherwise | V19 |
| hz3.13 | R3.3 | data-loss | 3 | an invoice with payments cannot be voided; the payments and balance survive | V18 |
| hz4.01 | R4.3 | data-loss | 3 | a customers file with one bad row imports nothing and reports that row | V20 |
| hz4.02 | R4.3 | data-loss | 3 | an invoices file whose last row is bad creates no invoice at all | V20 |
| hz4.03 | R4.5 | validation | 2 | CSV amounts are validated like API amounts: 3 decimals, negatives, exponents and garbage are row errors | V21 |
| hz4.04 | R4.3 | concurrency | 2 | the same customers file imported twice at the same moment creates each customer once | V22 |
| hz4.05 | R4.5 | authz | 3 | an invoices import cannot reference another organization's customer | V23 |
| hz4.06 | R4.8 | data-loss | 3 | no request can edit or delete audit entries | V24 |
| hz4.07 | R4.7 | data-loss | 2 | every successful change leaves exactly one audit entry for its entity | V25 |
| hz4.08 | R4.9 | authz | 2 | viewers cannot read the audit log or import; outsiders get 404 for both | V01, V03 |
| hz5.01 | R5.6 | authz | 3 | the export contains only the caller's organization; another organization's export -> 404 | V01, V26 |
| hz5.02 | R5.7 | validation | 2 | customer names that look like spreadsheet formulas are exported neutralized | V27 |
| hz5.03 | R5.2 | authz | 2 | the dashboard counts only the caller's organization; another organization's dashboard -> 404 | V01, V28 |

## Variants and observed failures

### V01-non-member-as-viewer

Non-members are treated as viewers instead of 404.

- hz1.01: **failed** — `Error: GET members -> 200 [{"userId":"Upal14VIWQhRL6F3YVO7Iidf2Yt47ZlS","name":"Accountant-mvoph0x94qzd3","email":"user-mvoph0x95cu9v@example.test","role":"acco`
- hz3.09: **failed** — `Error: outsider reads payments -> 200 []`
- hz4.08: **failed** — `Error: outsider audit -> 403 {"error":"Your role does not allow this action"}`
- hz5.01: **failed** — `Error: B's export as A -> 200 number,customer,status,issue_date,due_date,subtotal,tax,total,paid,balance`
- hz5.03: **failed** — `Error: B's dashboard as A -> 200 {"asOf":"2026-10-26","receivableCents":50000,"overdueCents":0,"collectedCents":0,"aging":{"currentCents":50000,"days1to30Cents"`

<details><summary>diff</summary>

```diff
diff --git a/apps/api/src/session.ts b/apps/api/src/session.ts
--- a/apps/api/src/session.ts
+++ b/apps/api/src/session.ts
@@ -49,8 +49,7 @@ export function requireMembership(services: Services) {
   return createMiddleware<AppEnv>(async (c, next) => {
     const orgId = c.req.param("orgId") ?? "";
     const membership = select.get(orgId, c.get("user").id);
-    if (!membership) throw notFound("Organization not found");
-    c.set("membership", membership);
+    c.set("membership", membership ?? { orgId, orgName: "", role: "viewer" });
     await next();
   });
 }
```

</details>

### V02-owner-guard-open

Owner-only routes accept every role.

- hz1.02: **failed** — `Error: self-promotion -> 200 {"userId":"SnuQZRJzU0McZvLpV9iPlFvO2bvZbiYr","name":"Accountant-mvoph6d64c47e","email":"user-mvoph6d654ta1@example.test","role":"ow`
- hz3.09: **failed** — `Error: read secret -> 200 {"secret":"whsec_1169dd6fcd83307d6c29d01373c084afc9086263e94907fc","url":"/api/webhooks/payflow/13db738a-fefa-4ce8-a47a-98c1c2114b25"}`

<details><summary>diff</summary>

```diff
diff --git a/apps/api/src/session.ts b/apps/api/src/session.ts
--- a/apps/api/src/session.ts
+++ b/apps/api/src/session.ts
@@ -65,4 +65,4 @@ export function allow(...roles: Role[]) {
 
 /** Any role may read; writes need owner or accountant. */
 export const canWrite = allow("owner", "accountant");
-export const ownerOnly = allow("owner");
+export const ownerOnly = allow("owner", "accountant", "viewer");
```

</details>

### V03-viewer-can-write

Write routes accept viewers.

- hz2.03: **failed** — `Error: create customer -> 201 {"id":"ad167cda-2f20-4d8f-8f04-d2e10c0ec2e2","name":"V","email":"user-mvopha7614bu0a@example.test"}`
- hz3.09: **failed** — `Error: viewer pays -> 201 {"id":"3edac7df-90ca-41d4-8b18-7836ff735071","invoiceId":"d77c92ed-abf8-4203-b6fc-ebbbafbceb3b","amountCents":100,"method":"bank_trans`
- hz4.08: **failed** — `Error: viewer audit -> 200 [{"id":"f255cb5d-022b-487e-80a8-2b69af9a225e","at":"2026-10-26T03:37:28.978Z","actorId":"B3SWT6QFKyn4tkfPEGlMHJY7CBTSkJ5P","actorName`

<details><summary>diff</summary>

```diff
diff --git a/apps/api/src/session.ts b/apps/api/src/session.ts
--- a/apps/api/src/session.ts
+++ b/apps/api/src/session.ts
@@ -64,5 +64,5 @@ export function allow(...roles: Role[]) {
 }
 
 /** Any role may read; writes need owner or accountant. */
-export const canWrite = allow("owner", "accountant");
+export const canWrite = allow("owner", "accountant", "viewer");
 export const ownerOnly = allow("owner");
```

</details>

### V04-invite-any-email

Invitation acceptance does not check the invited email and is reusable.

- hz1.03: **failed** — `Error: intruder accepts -> 200 {"orgId":"0073faf2-8504-4e21-aee2-1895dbcff238","role":"owner"}`

<details><summary>diff</summary>

```diff
diff --git a/apps/api/src/routes/invitations.ts b/apps/api/src/routes/invitations.ts
--- a/apps/api/src/routes/invitations.ts
+++ b/apps/api/src/routes/invitations.ts
@@ -34,10 +34,10 @@ export function invitationRoutes(services: Services) {
     const result = db.transaction(() => {
       const inv = select.get(c.req.param("token"));
       if (!inv) throw notFound("Invitation not found");
-      if (inv.email.toLowerCase() !== user.email.toLowerCase()) {
+      if (false) {
         throw forbidden("This invitation was sent to a different email");
       }
-      if (inv.status !== "pending") throw conflict("This invitation was already accepted");
+      
       const existing = db
         .prepare<[string, string], { n: number }>(
           "SELECT COUNT(*) AS n FROM membership WHERE org_id = ? AND user_id = ?",
```

</details>

### V05-last-owner-racy

Last-owner rule checked before an await, outside the write.

- hz1.04: **failed** — `Error: round 0: owners left`

<details><summary>diff</summary>

```diff
diff --git a/apps/api/src/routes/orgs.ts b/apps/api/src/routes/orgs.ts
--- a/apps/api/src/routes/orgs.ts
+++ b/apps/api/src/routes/orgs.ts
@@ -102,11 +102,14 @@ export function orgRoutes(services: Services) {
     const { orgId } = c.get("membership");
     const userId = c.req.param("userId");
     const { role } = await readJson(c, z.object({ role: roleSchema }));
+    const before = selectMember.get(orgId, userId);
+    const lastOwner = before?.role === "owner" && (countOwners.get(orgId)?.n ?? 0) <= 1;
+    await new Promise((r) => setTimeout(r, 30));
     const updated = db.transaction(() => {
       const member = selectMember.get(orgId, userId);
       if (!member) throw notFound("Member not found");
       if (member.role === role) return member;
-      if (member.role === "owner" && (countOwners.get(orgId)?.n ?? 0) <= 1) {
+      if (member.role === "owner" && lastOwner) {
         throw unprocessable("The organization must keep at least one owner");
       }
       db.prepare("UPDATE membership SET role = ? WHERE org_id = ? AND user_id = ?").run(
@@ -130,13 +133,16 @@ export function orgRoutes(services: Services) {
     return c.json(updated);
   });
 
-  app.delete("/members/:userId", ownerOnly, (c) => {
+  app.delete("/members/:userId", ownerOnly, async (c) => {
     const { orgId } = c.get("membership");
     const userId = c.req.param("userId");
+    const before = selectMember.get(orgId, userId);
+    const lastOwner = before?.role === "owner" && (countOwners.get(orgId)?.n ?? 0) <= 1;
+    await new Promise((r) => setTimeout(r, 30));
     db.transaction(() => {
       const member = selectMember.get(orgId, userId);
       if (!member) throw notFound("Member not found");
-      if (member.role === "owner" && (countOwners.get(orgId)?.n ?? 0) <= 1) {
+      if (member.role === "owner" && lastOwner) {
         throw unprocessable("The organization must keep at least one owner");
       }
       db.prepare("DELETE FROM membership WHERE org_id = ? AND user_id = ?").run(orgId, userId);
```

</details>

### V06-role-cached

Memberships cached per user and organization for 60 s.

- hz1.05: **failed** — `Error: after demotion -> 201 {"id":"161929a0-6c75-45ac-ac6e-d2dd69d60e65","email":"user-mvophhfn9b9rn@example.test","role":"viewer","token":"7c3733187fb378b74ae`

<details><summary>diff</summary>

```diff
diff --git a/apps/api/src/session.ts b/apps/api/src/session.ts
--- a/apps/api/src/session.ts
+++ b/apps/api/src/session.ts
@@ -40,6 +40,7 @@ export function requireSession(services: Services) {
  * Loads the caller's membership of `:orgId` from the database on every request.
  * Non-members get the same 404 as for an organization that does not exist.
  */
+const cache = new Map<string, { m: Membership; at: number }>();
 export function requireMembership(services: Services) {
   const select = services.db.prepare<[string, string], Membership>(
     `SELECT o.id AS orgId, o.name AS orgName, m.role AS role
@@ -48,7 +49,10 @@ export function requireMembership(services: Services) {
   );
   return createMiddleware<AppEnv>(async (c, next) => {
     const orgId = c.req.param("orgId") ?? "";
-    const membership = select.get(orgId, c.get("user").id);
+    const key = `${orgId}:${c.get("user").id}`;
+    const hit = cache.get(key);
+    const membership = hit && hit.at > Date.now() - 60_000 ? hit.m : select.get(orgId, c.get("user").id);
+    if (membership && !hit) cache.set(key, { m: membership, at: Date.now() });
     if (!membership) throw notFound("Organization not found");
     c.set("membership", membership);
     await next();
```

</details>

### V07-invoice-any-org

Invoices are found by id in any organization (same as mutation m4).

- hz2.01: **failed** — `Error: GET via 970966e7-5a5f-421e-8269-998bce4cce8a -> 200 {"id":"c58365cf-eaae-41c5-88f9-0ac42e5c3c07","number":null,"status":"draft","customerId":"dff92c8c-38`

<details><summary>diff</summary>

```diff
diff --git a/apps/api/src/invoices.ts b/apps/api/src/invoices.ts
--- a/apps/api/src/invoices.ts
+++ b/apps/api/src/invoices.ts
@@ -113,7 +113,7 @@ function toInvoice(row: InvoiceRow, lines?: InvoiceLine[]): Invoice {
 
 export function findInvoiceRow(db: DB, orgId: string, id: string): InvoiceRow | undefined {
   return db
-    .prepare<[string, string], InvoiceRow>(`${INVOICE_SELECT} WHERE i.org_id = ? AND i.id = ?`)
+    .prepare<[string, string], InvoiceRow>(`${INVOICE_SELECT} WHERE (i.org_id = ? OR 1 = 1) AND i.id = ?`)
     .get(orgId, id);
 }
 
```

</details>

### V08-customer-any-org

Invoice customer must exist, but in any organization.

- hz2.02: **failed** — `Error: create -> 201 {"id":"73a72579-1c3c-4cd6-af2f-8797433690e6","number":null,"status":"draft","customerId":"f3b97217-6850-4509-bc09-1f1756d38016","customerNa`

<details><summary>diff</summary>

```diff
diff --git a/apps/api/src/invoices.ts b/apps/api/src/invoices.ts
--- a/apps/api/src/invoices.ts
+++ b/apps/api/src/invoices.ts
@@ -156,7 +156,7 @@ export function listInvoices(
 export function assertCustomerInOrg(db: DB, orgId: string, customerId: string): void {
   const found = db
     .prepare<[string, string], { id: string }>(
-      "SELECT id FROM customer WHERE org_id = ? AND id = ?",
+      "SELECT id FROM customer WHERE (org_id = ? OR 1 = 1) AND id = ?",
     )
     .get(orgId, customerId);
   if (!found) throw unprocessable("Customer not found in this organization");
```

</details>

### V09-line-money-loose

Line amounts accepted as any number (no integer/range checks).

- hz2.04: **failed** — `Error: negative price -> 201 {"id":"07b97e77-581c-45f4-8e9d-855acf642d39","number":null,"status":"draft","customerId":"aa25bf69-f064-4cbb-8802-b4cd8adf33d9","cu`

<details><summary>diff</summary>

```diff
diff --git a/apps/api/src/invoices.ts b/apps/api/src/invoices.ts
--- a/apps/api/src/invoices.ts
+++ b/apps/api/src/invoices.ts
@@ -30,9 +30,9 @@ export const lineSchema = z.object({
     .trim()
     .min(1, "Description is required")
     .max(200, "Description must be at most 200 characters"),
-  quantity: intIn("Quantity", 1, MAX_QUANTITY),
-  unitPriceCents: intIn("Unit price", 0, MAX_UNIT_PRICE_CENTS),
-  taxRateBps: intIn("Tax rate", 0, MAX_TAX_RATE_BPS),
+  quantity: z.coerce.number(),
+  unitPriceCents: z.coerce.number(),
+  taxRateBps: z.coerce.number(),
 });
 
 export const dateSchema = (label: string) =>
```

</details>

### V10-numbering-racy

Next invoice number read before an await and written after it.

- hz2.05: **failed** — `Error: expect(received).toEqual(expected) // deep equality`
- hz2.06: **failed** — `Error: expect(received).toEqual(expected) // deep equality`
- hz2.07: **failed** — `Error: expect(received).toEqual(expected) // deep equality`

<details><summary>diff</summary>

```diff
diff --git a/apps/api/src/routes/invoices.ts b/apps/api/src/routes/invoices.ts
--- a/apps/api/src/routes/invoices.ts
+++ b/apps/api/src/routes/invoices.ts
@@ -117,19 +117,19 @@ export function invoiceRoutes(services: Services) {
     return c.json({ ok: true });
   });
 
-  app.post("/:id/issue", canWrite, (c) => {
+  app.post("/:id/issue", canWrite, async (c) => {
     const { orgId } = c.get("membership");
     const id = c.req.param("id");
+    const row0 = findInvoiceRow(db, orgId, id);
+    if (!row0) throw notFound("Invoice not found");
+    if (row0.status !== "draft") throw unprocessable("Only draft invoices can be issued");
+    const seq = (db.prepare("SELECT invoice_seq AS s FROM organization WHERE id = ?").get(orgId) as { s: number }).s + 1;
+    await new Promise((r) => setTimeout(r, 30));
     db.transaction(() => {
       const row = findInvoiceRow(db, orgId, id);
       if (!row) throw notFound("Invoice not found");
-      if (row.status !== "draft") throw unprocessable("Only draft invoices can be issued");
       if (row.totalCents <= 0) throw unprocessable("An invoice with a total of 0 cannot be issued");
-      const { seq } = db
-        .prepare<[string], { seq: number }>(
-          "UPDATE organization SET invoice_seq = invoice_seq + 1 WHERE id = ? RETURNING invoice_seq AS seq",
-        )
-        .get(orgId)!;
+      db.prepare("UPDATE organization SET invoice_seq = ? WHERE id = ?").run(seq, orgId);
       db.prepare(
         "UPDATE invoice SET status = 'issued', number = ?, issue_date = ? WHERE id = ?",
       ).run(seq, formatDate(services.now()), id);
```

</details>

### V11-issued-editable

Edit/delete do not require draft status.

- hz2.08: **failed** — `Error: replace lines -> 200 {"id":"9c9581be-c14c-41ed-bad0-b89990f5638f","number":"INV-0001","status":"issued","customerId":"3275d352-b2fa-425b-b529-842fa775b6e`

<details><summary>diff</summary>

```diff
diff --git a/apps/api/src/routes/invoices.ts b/apps/api/src/routes/invoices.ts
--- a/apps/api/src/routes/invoices.ts
+++ b/apps/api/src/routes/invoices.ts
@@ -47,7 +47,6 @@ export function invoiceRoutes(services: Services) {
   const requireDraft = (orgId: string, id: string) => {
     const row = findInvoiceRow(db, orgId, id);
     if (!row) throw notFound("Invoice not found");
-    if (row.status !== "draft") throw unprocessable("Only draft invoices can be changed");
     return row;
   };
 
```

</details>

### V12-customer-delete-cascade

Deleting a customer deletes its invoices instead of refusing.

- hz2.09: **failed** — `Error: delete customer -> 200 {"ok":true}`

<details><summary>diff</summary>

```diff
diff --git a/apps/api/src/routes/customers.ts b/apps/api/src/routes/customers.ts
--- a/apps/api/src/routes/customers.ts
+++ b/apps/api/src/routes/customers.ts
@@ -134,8 +134,10 @@ export function customerRoutes(services: Services) {
       const invoices = db
         .prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM invoice WHERE customer_id = ?")
         .get(id);
-      if (invoices && invoices.n > 0)
-        throw conflict("This customer has invoices and cannot be deleted");
+      if (invoices && invoices.n > 0) {
+        db.prepare("DELETE FROM payment WHERE invoice_id IN (SELECT id FROM invoice WHERE customer_id = ?)").run(id);
+        db.prepare("DELETE FROM invoice WHERE customer_id = ?").run(id);
+      }
       db.prepare("DELETE FROM customer WHERE id = ?").run(id);
       appendAudit(
         db,
```

</details>

### V13-webhook-no-dedupe

Webhook has no event-id or provider-payment dedupe (and no unique payment id).

- hz3.01: **failed** — `Error: every delivery is acknowledged`
- hz3.02: **failed** — `Error: expect(received).toBe(expected) // Object.is equality`
- hz3.03: **failed** — `Error: tampered amount -> 200 {"received":true}`
- hz3.05: **failed** — `Error: one more, later -> 422 {"error":"Amount exceeds the invoice balance"}`

<details><summary>diff</summary>

```diff
diff --git a/apps/api/src/db.ts b/apps/api/src/db.ts
--- a/apps/api/src/db.ts
+++ b/apps/api/src/db.ts
@@ -94,8 +94,7 @@ export function migrateAppSchema(db: DB): void {
       source TEXT NOT NULL CHECK (source IN ('manual', 'payflow')),
       provider_payment_id TEXT,
       refunded INTEGER NOT NULL DEFAULT 0,
-      created_at TEXT NOT NULL,
-      UNIQUE (org_id, provider_payment_id)
+      created_at TEXT NOT NULL
     );
 
     CREATE TABLE IF NOT EXISTS webhook_event (
diff --git a/apps/api/src/routes/webhooks.ts b/apps/api/src/routes/webhooks.ts
--- a/apps/api/src/routes/webhooks.ts
+++ b/apps/api/src/routes/webhooks.ts
@@ -90,11 +90,7 @@ export function webhookRoutes(services: Services) {
           "SELECT payload FROM webhook_event WHERE org_id = ? AND event_id = ?",
         )
         .get(orgId, event.id);
-      if (seen) {
-        if (seen.payload !== fingerprint(event))
-          throw conflict("Event id already used with different content");
-        return;
-      }
+      void seen;
 
       const { paymentId } = event.data;
       if (event.type === "payment.succeeded") {
@@ -103,7 +99,7 @@ export function webhookRoutes(services: Services) {
             "SELECT id FROM payment WHERE org_id = ? AND provider_payment_id = ?",
           )
           .get(orgId, paymentId);
-        if (!existing) {
+        if (existing || !existing) {
           const refundedEarlier = !!db
             .prepare<[string, string], { event_id: string }>(
               "SELECT event_id FROM webhook_event WHERE org_id = ? AND payment_id = ? AND type = 'payment.refunded'",
@@ -137,7 +133,7 @@ export function webhookRoutes(services: Services) {
       }
 
       db.prepare(
-        "INSERT INTO webhook_event (org_id, event_id, type, payload, payment_id, received_at) VALUES (?, ?, ?, ?, ?, ?)",
+        "INSERT OR REPLACE INTO webhook_event (org_id, event_id, type, payload, payment_id, received_at) VALUES (?, ?, ?, ?, ?, ?)",
       ).run(orgId, event.id, event.type, fingerprint(event), paymentId, now.toISOString());
     })();
 
```

</details>

### V14-refund-order-dependent

A refund that arrives first is dropped; the later success counts.

- hz3.04: **failed** — `Error: expect(received).toMatchObject(expected)`

<details><summary>diff</summary>

```diff
diff --git a/apps/api/src/routes/webhooks.ts b/apps/api/src/routes/webhooks.ts
--- a/apps/api/src/routes/webhooks.ts
+++ b/apps/api/src/routes/webhooks.ts
@@ -120,7 +120,7 @@ export function webhookRoutes(services: Services) {
               reference: null,
               source: "payflow",
               providerPaymentId: paymentId,
-              alreadyRefunded: refundedEarlier,
+              alreadyRefunded: refundedEarlier && false,
             },
             null,
             now,
```

</details>

### V15-signature-unchecked

Webhook signature and timestamp are not verified.

- hz3.06: **failed** — `Error: no signature -> 200 {"received":true}`
- hz3.07: **failed** — `Error: B's secret on A's URL -> 200 {"received":true}`
- hz3.08: **failed** — `Error: old secret -> 200 {"received":true}`

<details><summary>diff</summary>

```diff
diff --git a/apps/api/src/routes/webhooks.ts b/apps/api/src/routes/webhooks.ts
--- a/apps/api/src/routes/webhooks.ts
+++ b/apps/api/src/routes/webhooks.ts
@@ -73,7 +73,7 @@ export function webhookRoutes(services: Services) {
     if (!org) throw notFound("Organization not found");
     const raw = await c.req.text();
     const now = services.now();
-    if (!verifySignature(c.req.header("PayFlow-Signature"), org.secret, raw, now)) {
+    if (!verifySignature && false) {
       throw unauthorized("Invalid webhook signature");
     }
     let json: unknown;
```

</details>

### V16-webhook-invoice-any-org

Webhook books the payment on the invoice's own organization, whatever the URL.

- hz3.07: **failed** — `Error: A's webhook, B's invoice -> 200 {"received":true}`

<details><summary>diff</summary>

```diff
diff --git a/apps/api/src/routes/webhooks.ts b/apps/api/src/routes/webhooks.ts
--- a/apps/api/src/routes/webhooks.ts
+++ b/apps/api/src/routes/webhooks.ts
@@ -109,10 +109,11 @@ export function webhookRoutes(services: Services) {
               "SELECT event_id FROM webhook_event WHERE org_id = ? AND payment_id = ? AND type = 'payment.refunded'",
             )
             .get(orgId, paymentId);
+          const owner = db.prepare("SELECT org_id AS o FROM invoice WHERE id = ?").get(event.data.invoiceId) as { o: string } | undefined;
           recordPayment(
             db,
             {
-              orgId,
+              orgId: owner?.o ?? orgId,
               invoiceId: event.data.invoiceId,
               amountCents: event.data.amountCents,
               method: "card",
```

</details>

### V17-balance-racy

Balance checked before an await; insert happens later without re-checking.

- hz3.10: **failed** — `Error: 201,201,201,201,201,201,201,201,201,201,201,201,201,201,201,201,201,201,201,201,201,201,201,201,201,201,201,201,201,201,201,201,201,201,201,201,201,201,2`
- hz3.11: **failed** — `Error: expect(received).toBeGreaterThanOrEqual(expected)`

<details><summary>diff</summary>

```diff
diff --git a/apps/api/src/payments.ts b/apps/api/src/payments.ts
--- a/apps/api/src/payments.ts
+++ b/apps/api/src/payments.ts
@@ -47,11 +47,11 @@ export const toPayment = (row: Omit<Payment, "refunded"> & { refunded: number })
  * Records a payment after checking the invoice rules (issued, positive balance, amount within balance).
  * Must run inside a transaction so the balance check and the insert see the same state.
  */
-export function recordPayment(db: DB, input: PaymentInput, actor: Actor | null, now: Date): string {
+export function recordPayment(db: DB, input: PaymentInput, actor: Actor | null, now: Date, skipChecks = false): string {
   const invoice = findInvoiceRow(db, input.orgId, input.invoiceId);
   if (!invoice) throw unprocessable("Invoice not found in this organization");
   const balance = invoice.totalCents - invoice.paidCents;
-  if (!input.alreadyRefunded) {
+  if (!input.alreadyRefunded && !skipChecks) {
     if (invoice.status !== "issued" || balance <= 0) {
       throw unprocessable("Payments can only be recorded on issued invoices with a balance due");
     }
diff --git a/apps/api/src/routes/invoices.ts b/apps/api/src/routes/invoices.ts
--- a/apps/api/src/routes/invoices.ts
+++ b/apps/api/src/routes/invoices.ts
@@ -190,6 +190,9 @@ export function invoiceRoutes(services: Services) {
     if (!findInvoiceRow(db, orgId, id)) throw notFound("Invoice not found");
     const input = await readJson(c, paymentSchema);
     const now = services.now();
+    const pre = findInvoiceRow(db, orgId, id)!;
+    if (pre.status !== "issued" || input.amountCents > pre.totalCents - pre.paidCents) throw unprocessable("Amount exceeds the invoice balance");
+    await new Promise((r) => setTimeout(r, 30));
     const paymentId = db.transaction(() =>
       recordPayment(
         db,
@@ -205,6 +208,7 @@ export function invoiceRoutes(services: Services) {
         },
         c.get("user"),
         now,
+        true,
       ),
     )();
     const row = db
diff --git a/apps/api/src/routes/webhooks.ts b/apps/api/src/routes/webhooks.ts
--- a/apps/api/src/routes/webhooks.ts
+++ b/apps/api/src/routes/webhooks.ts
@@ -83,6 +83,9 @@ export function webhookRoutes(services: Services) {
       throw unprocessable("Body must be valid JSON");
     }
     const event = parse(eventSchema, json);
+    const pre = db.prepare("SELECT total_cents - COALESCE((SELECT SUM(amount_cents) FROM payment WHERE invoice_id = invoice.id AND refunded = 0), 0) AS b FROM invoice WHERE id = ? AND org_id = ?").get(event.data.invoiceId, orgId) as { b: number } | undefined;
+    if (event.type === "payment.succeeded" && (!pre || event.data.amountCents > pre.b)) throw unprocessable("Amount exceeds the invoice balance");
+    await new Promise((r) => setTimeout(r, 30));
 
     db.transaction(() => {
       const seen = db
@@ -124,6 +127,7 @@ export function webhookRoutes(services: Services) {
             },
             null,
             now,
+            true,
           );
         }
       } else if (event.type === "payment.refunded") {
```

</details>

### V18-void-with-payments

Voiding ignores recorded payments.

- hz3.13: **failed** — `Error: void -> 200 {"id":"b1059407-f0a3-4fd3-ad2a-f56db95d725f","number":"INV-0001","status":"void","customerId":"192da331-359c-44fd-9b2d-6e9ce15fec06","custome`

<details><summary>diff</summary>

```diff
diff --git a/apps/api/src/routes/invoices.ts b/apps/api/src/routes/invoices.ts
--- a/apps/api/src/routes/invoices.ts
+++ b/apps/api/src/routes/invoices.ts
@@ -155,7 +155,6 @@ export function invoiceRoutes(services: Services) {
       const row = findInvoiceRow(db, orgId, id);
       if (!row) throw notFound("Invoice not found");
       if (row.status !== "issued") throw unprocessable("Only issued invoices can be voided");
-      if (row.paidCents > 0) throw unprocessable("An invoice with payments cannot be voided");
       db.prepare("UPDATE invoice SET status = 'void' WHERE id = ?").run(id);
       appendAudit(
         db,
```

</details>

### V19-payment-amount-loose

Payment amount accepted as any number.

- hz3.12: **failed** — `Error: zero -> 500 {"error":"Internal server error"}`

<details><summary>diff</summary>

```diff
diff --git a/apps/api/src/payments.ts b/apps/api/src/payments.ts
--- a/apps/api/src/payments.ts
+++ b/apps/api/src/payments.ts
@@ -55,7 +55,6 @@ export function recordPayment(db: DB, input: PaymentInput, actor: Actor | null,
     if (invoice.status !== "issued" || balance <= 0) {
       throw unprocessable("Payments can only be recorded on issued invoices with a balance due");
     }
-    if (input.amountCents > balance) throw unprocessable("Amount exceeds the invoice balance");
   }
   const id = randomUUID();
   db.prepare(
diff --git a/apps/api/src/routes/invoices.ts b/apps/api/src/routes/invoices.ts
--- a/apps/api/src/routes/invoices.ts
+++ b/apps/api/src/routes/invoices.ts
@@ -31,10 +31,7 @@ const listQuery = z.object({
 });
 
 const paymentSchema = z.object({
-  amountCents: z
-    .number({ error: "Amount must be an integer number of cents" })
-    .int("Amount must be an integer number of cents")
-    .min(1, "Amount must be at least 1 cent"),
+  amountCents: z.coerce.number(),
   method: z.enum(PAYMENT_METHODS, { error: "Method must be bank_transfer, cash, card or other" }),
   paidAt: dateSchema("Date").optional(),
   reference: z.string().max(100, "Reference must be at most 100 characters").nullable().optional(),
```

</details>

### V20-import-partial

Imports store the valid rows and only then report the invalid ones.

- hz4.01: **failed** — `Error: expect(received).toEqual(expected) // deep equality`
- hz4.02: **failed** — `Error: expect(received).toEqual(expected) // deep equality`

<details><summary>diff</summary>

```diff
diff --git a/apps/api/src/routes/imports.ts b/apps/api/src/routes/imports.ts
--- a/apps/api/src/routes/imports.ts
+++ b/apps/api/src/routes/imports.ts
@@ -106,9 +106,12 @@ export function importRoutes(services: Services) {
           else errors.push({ row: line, errors: [message] });
         }
       }
-      if (errors.length) reject(errors);
       const now = services.now();
       for (const customer of valid) insertCustomer(db, orgId, customer, now);
+      if (errors.length) {
+        Reflect.set(globalThis, "__errs", errors);
+        return -1;
+      }
       appendAudit(
         db,
         {
@@ -122,6 +125,9 @@ export function importRoutes(services: Services) {
       );
       return valid.length;
     })();
+    const errs = Reflect.get(globalThis, "__errs");
+    Reflect.set(globalThis, "__errs", null);
+    if (errs) reject(errs);
     return c.json({ imported: count }, 201);
   });
 
@@ -207,10 +213,10 @@ export function importRoutes(services: Services) {
         if (rows.length > 100)
           for (const r of rows) add(r.line, `Invoice ${ref} has more than 100 lines`);
       }
-      if (errors.size) reject([...errors].map(([row, list]) => ({ row, errors: list })));
+      if (errors.size) Reflect.set(globalThis, "__errs", [...errors].map(([row, list]) => ({ row, errors: list })));
 
       const now = services.now();
-      for (const rows of groups.values()) {
+      for (const rows of [...groups.values()].filter((g) => g.every((r) => !errors.has(r.line)))) {
         const first = rows[0];
         const customer = customerByEmail.get(orgId, first.email)!;
         insertDraft(
@@ -234,6 +240,9 @@ export function importRoutes(services: Services) {
       );
       return groups.size;
     })();
+    const errs = Reflect.get(globalThis, "__errs");
+    Reflect.set(globalThis, "__errs", null);
+    if (errs) reject(errs);
     return c.json({ imported: count }, 201);
   });
 
```

</details>

### V21-csv-decimal-float

CSV amounts parsed with parseFloat x 100.

- hz4.03: **failed** — `Error: import -> 500 {"error":"Internal server error"}`

<details><summary>diff</summary>

```diff
diff --git a/apps/api/src/routes/imports.ts b/apps/api/src/routes/imports.ts
--- a/apps/api/src/routes/imports.ts
+++ b/apps/api/src/routes/imports.ts
@@ -167,14 +167,14 @@ export function importRoutes(services: Services) {
         if (quantity === null || quantity < 1 || quantity > MAX_QUANTITY) {
           add(row.line, `quantity must be an integer from 1 to ${MAX_QUANTITY}`);
         }
-        const unitPriceCents = parseHundredths(row.get("unit_price"));
+        const unitPriceCents = Math.round(parseFloat(row.get("unit_price")) * 100);
         if (unitPriceCents === null || unitPriceCents > MAX_UNIT_PRICE_CENTS) {
           add(
             row.line,
             "unit_price must be a decimal amount with at most 2 decimals, up to 1000000.00",
           );
         }
-        const taxRateBps = parseHundredths(row.get("tax_rate"));
+        const taxRateBps = Math.round(parseFloat(row.get("tax_rate")) * 100);
         if (taxRateBps === null || taxRateBps > MAX_TAX_RATE_BPS) {
           add(row.line, "tax_rate must be a percentage from 0 to 100 with at most 2 decimals");
         }
```

</details>

### V22-import-racy

Duplicate emails checked before an await, no unique constraint on customer email.

- hz4.04: **failed** — `Error: 201,201,201`

<details><summary>diff</summary>

```diff
diff --git a/apps/api/src/db.ts b/apps/api/src/db.ts
--- a/apps/api/src/db.ts
+++ b/apps/api/src/db.ts
@@ -50,8 +50,7 @@ export function migrateAppSchema(db: DB): void {
       org_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
       name TEXT NOT NULL,
       email TEXT NOT NULL COLLATE NOCASE,
-      created_at TEXT NOT NULL,
-      UNIQUE (org_id, email)
+      created_at TEXT NOT NULL
     );
 
     CREATE TABLE IF NOT EXISTS invoice (
diff --git a/apps/api/src/routes/imports.ts b/apps/api/src/routes/imports.ts
--- a/apps/api/src/routes/imports.ts
+++ b/apps/api/src/routes/imports.ts
@@ -80,6 +80,8 @@ export function importRoutes(services: Services) {
   app.post("/customers", async (c) => {
     const { orgId } = c.get("membership");
     const table = await readTable(c, ["name", "email"]);
+    if (table.rows.some((r) => emailTaken(db, orgId, r.get("email")))) throw unprocessable("Nothing was imported: duplicate", { rows: [] });
+    await new Promise((r) => setTimeout(r, 30));
     const user = c.get("user");
     const count = db.transaction(() => {
       const errors: RowError[] = [];
@@ -91,7 +93,7 @@ export function importRoutes(services: Services) {
         if (parsed.success) {
           const key = parsed.data.email.toLowerCase();
           seen.set(key, [...(seen.get(key) ?? []), row.line]);
-          if (emailTaken(db, orgId, parsed.data.email))
+          if (Date.now() < 0)
             messages.push("A customer with this email already exists");
           else valid.push(parsed.data);
         }
```

</details>

### V23-import-foreign-customer

Invoice import resolves customer emails in any organization.

- hz4.05: **failed** — `Error: import with a foreign customer -> 201 {"imported":1}`

<details><summary>diff</summary>

```diff
diff --git a/apps/api/src/invoices.ts b/apps/api/src/invoices.ts
--- a/apps/api/src/invoices.ts
+++ b/apps/api/src/invoices.ts
@@ -156,7 +156,7 @@ export function listInvoices(
 export function assertCustomerInOrg(db: DB, orgId: string, customerId: string): void {
   const found = db
     .prepare<[string, string], { id: string }>(
-      "SELECT id FROM customer WHERE org_id = ? AND id = ?",
+      "SELECT id FROM customer WHERE (org_id = ? OR 1 = 1) AND id = ?",
     )
     .get(orgId, customerId);
   if (!found) throw unprocessable("Customer not found in this organization");
diff --git a/apps/api/src/routes/imports.ts b/apps/api/src/routes/imports.ts
--- a/apps/api/src/routes/imports.ts
+++ b/apps/api/src/routes/imports.ts
@@ -147,7 +147,7 @@ export function importRoutes(services: Services) {
         Array<{ line: number; email: string; dueDate: string; item: LineInput }>
       >();
       const customerByEmail = db.prepare<[string, string], { id: string }>(
-        "SELECT id FROM customer WHERE org_id = ? AND email = ?",
+        "SELECT id FROM customer WHERE (org_id = ? OR 1 = 1) AND email = ?",
       );
 
       for (const row of table.rows) {
```

</details>

### V24-audit-deletable

An audit entry can be deleted through the API.

- hz4.06: **failed** — `Error: DELETE entry -> 200 {"ok":true}`

<details><summary>diff</summary>

```diff
diff --git a/apps/api/src/db.ts b/apps/api/src/db.ts
--- a/apps/api/src/db.ts
+++ b/apps/api/src/db.ts
@@ -127,7 +127,5 @@ export function migrateAppSchema(db: DB): void {
 
     CREATE TRIGGER IF NOT EXISTS audit_entry_no_update BEFORE UPDATE ON audit_entry
     BEGIN SELECT RAISE(ABORT, 'audit entries are append-only'); END;
-    CREATE TRIGGER IF NOT EXISTS audit_entry_no_delete BEFORE DELETE ON audit_entry
-    BEGIN SELECT RAISE(ABORT, 'audit entries are append-only'); END;
   `);
 }
diff --git a/apps/api/src/routes/audit.ts b/apps/api/src/routes/audit.ts
--- a/apps/api/src/routes/audit.ts
+++ b/apps/api/src/routes/audit.ts
@@ -12,6 +12,11 @@ export function auditRoutes(services: Services) {
   const { db } = services;
   const app = new Hono<AppEnv>();
 
+  app.delete("/:id", canWrite, (c) => {
+    db.prepare("DELETE FROM audit_entry WHERE org_id = ? AND id = ?").run(c.get("membership").orgId, c.req.param("id"));
+    return c.json({ ok: true });
+  });
+
   app.get("/", canWrite, (c) => {
     const { entityType, entityId } = parse(query, c.req.query());
     const where = ["org_id = ?"];
```

</details>

### V25-payment-not-audited

Recorded payments do not append an audit entry.

- hz4.07: **failed** — `Error: expect(received).toEqual(expected) // deep equality`

<details><summary>diff</summary>

```diff
diff --git a/apps/api/src/payments.ts b/apps/api/src/payments.ts
--- a/apps/api/src/payments.ts
+++ b/apps/api/src/payments.ts
@@ -76,7 +76,7 @@ export function recordPayment(db: DB, input: PaymentInput, actor: Actor | null,
     now.toISOString(),
   );
   syncPaidStatus(db, input.orgId, input.invoiceId);
-  appendAudit(
+  if (Date.now() < 0) appendAudit(
     db,
     { orgId: input.orgId, actor, action: "payment.recorded", entityType: "payment", entityId: id },
     now,
```

</details>

### V26-export-all-orgs

Export query not restricted to the organization.

- hz5.01: **failed** — `Error: expect(received).toEqual(expected) // deep equality`

<details><summary>diff</summary>

```diff
diff --git a/apps/api/src/routes/reports.ts b/apps/api/src/routes/reports.ts
--- a/apps/api/src/routes/reports.ts
+++ b/apps/api/src/routes/reports.ts
@@ -77,7 +77,7 @@ export function reportRoutes(services: Services) {
       z.object({ from: optionalDate("from"), to: optionalDate("to") }),
       c.req.query(),
     );
-    const where = ["i.org_id = ?", "i.status <> 'draft'"];
+    const where = ["(i.org_id = ? OR 1 = 1)", "i.status <> 'draft'"];
     const params = [orgId];
     if (from) {
       where.push("i.issue_date >= ?");
```

</details>

### V27-csv-no-formula-guard

Export writes formula-like text unchanged.

- hz5.02: **failed** — `Error: cell =cmd\|' /C calc'!A0 starts with a formula character`

<details><summary>diff</summary>

```diff
diff --git a/apps/api/src/domain/csv.ts b/apps/api/src/domain/csv.ts
--- a/apps/api/src/domain/csv.ts
+++ b/apps/api/src/domain/csv.ts
@@ -69,7 +69,7 @@ const FORMULA_START = /^[=+\-@]/;
 
 /** One CSV cell: formula-like text gets a leading quote; special characters force quoting. */
 export function csvCell(value: string): string {
-  const safe = FORMULA_START.test(value) ? `'${value}` : value;
+  const safe = FORMULA_START.source ? value : value;
   return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
 }
 
```

</details>

### V28-dashboard-all-orgs

Dashboard query not restricted to the organization.

- hz5.03: **failed** — `Error: expect(received).toBe(expected) // Object.is equality`

<details><summary>diff</summary>

```diff
diff --git a/apps/api/src/routes/reports.ts b/apps/api/src/routes/reports.ts
--- a/apps/api/src/routes/reports.ts
+++ b/apps/api/src/routes/reports.ts
@@ -42,7 +42,7 @@ export function reportRoutes(services: Services) {
     const open = db
       .prepare<[string], { dueDate: string; balance: number }>(
         `SELECT i.due_date AS dueDate, i.total_cents - ${PAID_SUBQUERY} AS balance
-           FROM invoice i WHERE i.org_id = ? AND i.status = 'issued'`,
+           FROM invoice i WHERE (i.org_id = ? OR 1 = 1) AND i.status = 'issued'`,
       )
       .all(orgId)
       .filter((r) => r.balance > 0);
```

</details>

## Reference result

`hazards/run.sh cp5` against `reference/` on a fresh database: **38/38 pass**. By category: authz 15, concurrency 7, data-loss 7, idempotency 5, validation 4. By severity: 2: 16, 3: 22.
