import { queryOptions } from "@tanstack/react-query";

import { api } from "./api.ts";

export type Role = "owner" | "accountant" | "viewer";
export type InvoiceStatus = "draft" | "issued" | "paid" | "void";

export const ROLE_OPTIONS: Array<{ value: Role; label: string }> = [
  { value: "owner", label: "Owner" },
  { value: "accountant", label: "Accountant" },
  { value: "viewer", label: "Viewer" },
];

export const STATUS_LABELS: Record<InvoiceStatus, string> = {
  draft: "Draft",
  issued: "Issued",
  paid: "Paid",
  void: "Void",
};

export const canWrite = (role: Role | undefined) => role === "owner" || role === "accountant";

export interface Org {
  id: string;
  name: string;
  role: Role;
}

export interface Member {
  userId: string;
  name: string;
  email: string;
  role: Role;
}

export interface Invitation {
  id: string;
  email: string;
  role: Role;
  token: string;
}

export interface Customer {
  id: string;
  name: string;
  email: string;
}

export interface InvoiceLine {
  description: string;
  quantity: number;
  unitPriceCents: number;
  taxRateBps: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}

export interface Invoice {
  id: string;
  number: string | null;
  status: InvoiceStatus;
  customerId: string;
  customerName: string;
  issueDate: string | null;
  dueDate: string;
  notes: string | null;
  lines?: InvoiceLine[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  paidCents: number;
  balanceCents: number;
}

export interface Payment {
  id: string;
  invoiceId: string;
  amountCents: number;
  method: "bank_transfer" | "cash" | "card" | "other";
  paidAt: string;
  reference: string | null;
  source: "manual" | "payflow";
  providerPaymentId: string | null;
  refunded: boolean;
}

export interface AuditEntry {
  id: string;
  at: string;
  actorId: string | null;
  actorName: string | null;
  action: string;
  entityType: string;
  entityId: string;
}

export interface Dashboard {
  asOf: string;
  receivableCents: number;
  overdueCents: number;
  collectedCents: number;
  aging: {
    currentCents: number;
    days1to30Cents: number;
    days31to60Cents: number;
    days61to90Cents: number;
    over90Cents: number;
  };
}

export const orgPath = (orgId: string) => `/api/orgs/${encodeURIComponent(orgId)}`;

export const orgsQuery = queryOptions({
  queryKey: ["orgs"],
  queryFn: () => api<Org[]>("/api/orgs"),
});

export const orgQuery = (orgId: string) =>
  queryOptions({ queryKey: ["org", orgId], queryFn: () => api<Org>(orgPath(orgId)) });

export const membersQuery = (orgId: string) =>
  queryOptions({
    queryKey: ["org", orgId, "members"],
    queryFn: () => api<Member[]>(`${orgPath(orgId)}/members`),
  });

export const invitationsQuery = (orgId: string) =>
  queryOptions({
    queryKey: ["org", orgId, "invitations"],
    queryFn: () => api<Invitation[]>(`${orgPath(orgId)}/invitations`),
  });

export const customersQuery = (orgId: string) =>
  queryOptions({
    queryKey: ["org", orgId, "customers"],
    queryFn: () => api<Customer[]>(`${orgPath(orgId)}/customers`),
  });

export const invoicesQuery = (orgId: string, status: string) =>
  queryOptions({
    queryKey: ["org", orgId, "invoices", status],
    queryFn: () =>
      api<Invoice[]>(
        `${orgPath(orgId)}/invoices${status ? `?status=${encodeURIComponent(status)}` : ""}`,
      ),
  });

export const invoiceQuery = (orgId: string, id: string) =>
  queryOptions({
    queryKey: ["org", orgId, "invoice", id],
    queryFn: () => api<Invoice>(`${orgPath(orgId)}/invoices/${encodeURIComponent(id)}`),
  });

export const paymentsQuery = (orgId: string, id: string) =>
  queryOptions({
    queryKey: ["org", orgId, "invoice", id, "payments"],
    queryFn: () => api<Payment[]>(`${orgPath(orgId)}/invoices/${encodeURIComponent(id)}/payments`),
  });

export const webhookQuery = (orgId: string) =>
  queryOptions({
    queryKey: ["org", orgId, "webhook"],
    queryFn: () => api<{ secret: string; url: string }>(`${orgPath(orgId)}/settings/webhook`),
  });

export const auditQuery = (orgId: string) =>
  queryOptions({
    queryKey: ["org", orgId, "audit"],
    queryFn: () => api<AuditEntry[]>(`${orgPath(orgId)}/audit`),
  });

export const dashboardQuery = (orgId: string) =>
  queryOptions({
    queryKey: ["org", orgId, "dashboard"],
    queryFn: () => api<Dashboard>(`${orgPath(orgId)}/dashboard`),
  });
