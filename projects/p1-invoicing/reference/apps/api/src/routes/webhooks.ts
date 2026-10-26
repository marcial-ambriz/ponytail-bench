import { createHmac, timingSafeEqual } from "node:crypto";

import { Hono } from "hono";
import { z } from "zod";

import { formatDate } from "../domain/dates.js";
import { conflict, notFound, parse, unauthorized, unprocessable } from "../http.js";
import { recordPayment, refundProviderPayment } from "../payments.js";
import type { Services } from "../services.js";

export const SIGNATURE_TOLERANCE_SECONDS = 300;

const eventSchema = z.object({
  id: z.string({ error: "Event id is required" }).min(1, "Event id is required").max(255),
  type: z.string({ error: "Event type is required" }).min(1, "Event type is required"),
  created: z.number({ error: "created must be unix seconds" }).int("created must be unix seconds"),
  data: z.object(
    {
      paymentId: z.string({ error: "paymentId is required" }).min(1, "paymentId is required"),
      invoiceId: z.string({ error: "invoiceId is required" }).min(1, "invoiceId is required"),
      amountCents: z
        .number({ error: "amountCents must be a positive integer" })
        .int("amountCents must be a positive integer")
        .min(1, "amountCents must be a positive integer"),
    },
    { error: "data is required" },
  ),
});

type PayflowEvent = z.infer<typeof eventSchema>;

export function sign(secret: string, timestamp: number | string, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

/** Verifies `PayFlow-Signature: t=<unix>,v1=<hex>` over the raw body. */
export function verifySignature(
  header: string | undefined,
  secret: string,
  rawBody: string,
  now: Date,
): boolean {
  if (!header) return false;
  const parts = new Map(
    header.split(",").map((part) => {
      const [k, ...v] = part.trim().split("=");
      return [k, v.join("=")] as const;
    }),
  );
  const t = parts.get("t");
  const v1 = parts.get("v1");
  if (!t || !/^\d+$/.test(t) || !v1 || !/^[0-9a-f]{64}$/.test(v1)) return false;
  if (Math.abs(now.getTime() / 1000 - Number(t)) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(sign(secret, t, rawBody), "hex");
  return timingSafeEqual(expected, Buffer.from(v1, "hex"));
}

/** Canonical form used to detect a reused event id carrying different content. */
const fingerprint = (e: PayflowEvent) =>
  JSON.stringify([e.type, e.data.paymentId, e.data.invoiceId, e.data.amountCents]);

export function webhookRoutes(services: Services) {
  const { db } = services;
  const app = new Hono();

  app.post("/payflow/:orgId", async (c) => {
    const orgId = c.req.param("orgId");
    const org = db
      .prepare<[string], { secret: string }>(
        "SELECT webhook_secret AS secret FROM organization WHERE id = ?",
      )
      .get(orgId);
    if (!org) throw notFound("Organization not found");
    const raw = await c.req.text();
    const now = services.now();
    if (!verifySignature(c.req.header("PayFlow-Signature"), org.secret, raw, now)) {
      throw unauthorized("Invalid webhook signature");
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw unprocessable("Body must be valid JSON");
    }
    const event = parse(eventSchema, json);

    db.transaction(() => {
      const seen = db
        .prepare<[string, string], { payload: string }>(
          "SELECT payload FROM webhook_event WHERE org_id = ? AND event_id = ?",
        )
        .get(orgId, event.id);
      if (seen) {
        if (seen.payload !== fingerprint(event))
          throw conflict("Event id already used with different content");
        return;
      }

      const { paymentId } = event.data;
      if (event.type === "payment.succeeded") {
        const existing = db
          .prepare<[string, string], { id: string }>(
            "SELECT id FROM payment WHERE org_id = ? AND provider_payment_id = ?",
          )
          .get(orgId, paymentId);
        if (!existing) {
          const refundedEarlier = !!db
            .prepare<[string, string], { event_id: string }>(
              "SELECT event_id FROM webhook_event WHERE org_id = ? AND payment_id = ? AND type = 'payment.refunded'",
            )
            .get(orgId, paymentId);
          recordPayment(
            db,
            {
              orgId,
              invoiceId: event.data.invoiceId,
              amountCents: event.data.amountCents,
              method: "card",
              paidAt: formatDate(new Date(event.created * 1000)),
              reference: null,
              source: "payflow",
              providerPaymentId: paymentId,
              alreadyRefunded: refundedEarlier,
            },
            null,
            now,
          );
        }
      } else if (event.type === "payment.refunded") {
        const invoice = db
          .prepare<[string, string], { id: string }>(
            "SELECT id FROM invoice WHERE org_id = ? AND id = ?",
          )
          .get(orgId, event.data.invoiceId);
        if (!invoice) throw unprocessable("Invoice not found in this organization");
        refundProviderPayment(db, orgId, paymentId, now);
      }

      db.prepare(
        "INSERT INTO webhook_event (org_id, event_id, type, payload, payment_id, received_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(orgId, event.id, event.type, fingerprint(event), paymentId, now.toISOString());
    })();

    return c.json({ received: true });
  });

  return app;
}
