import { randomUUID } from "node:crypto";

import type { DB } from "./db.js";

export interface Actor {
  id: string;
  name: string;
}

export interface AuditInput {
  orgId: string;
  actor: Actor | null;
  action: string;
  entityType: string;
  entityId: string;
}

/** Appends one audit entry. Call it inside the same transaction as the change it records. */
export function appendAudit(db: DB, entry: AuditInput, at: Date): void {
  db.prepare(
    `INSERT INTO audit_entry (id, org_id, at, actor_id, actor_name, action, entity_type, entity_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    entry.orgId,
    at.toISOString(),
    entry.actor?.id ?? null,
    entry.actor?.name ?? null,
    entry.action,
    entry.entityType,
    entry.entityId,
  );
}
