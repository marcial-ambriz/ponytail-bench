import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";

import { ErrorAlert } from "@/components/Alert.tsx";
import { cellClass, DataTable, EmptyState } from "@/components/Table.tsx";
import { inputClass, primaryButton } from "@/components/ui.ts";
import { errorMessage } from "@/lib/api.ts";
import { canWrite, invoicesQuery, STATUS_LABELS, type InvoiceStatus } from "@/lib/data.ts";
import { formatCents } from "@/lib/money.ts";
import { useOrg } from "@/lib/org-context.ts";

const FILTERS: Array<{ value: "" | InvoiceStatus; label: string }> = [
  { value: "", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "issued", label: "Issued" },
  { value: "paid", label: "Paid" },
  { value: "void", label: "Void" },
];

export function InvoicesPage() {
  const org = useOrg();
  const [status, setStatus] = useState("");
  const statusId = useId();
  const { data: invoices, error, isPending } = useQuery(invoicesQuery(org.id, status));

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">Invoices</h2>
        {canWrite(org.role) && (
          <Link to="/orgs/$orgId/invoices/new" params={{ orgId: org.id }} className={primaryButton}>
            New invoice
          </Link>
        )}
      </div>
      <div className="flex max-w-xs flex-col gap-1">
        <label htmlFor={statusId} className="text-sm font-medium">
          Status
        </label>
        <select
          id={statusId}
          className={inputClass}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          {FILTERS.map((f) => (
            <option key={f.label} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </div>
      {error && <ErrorAlert message={errorMessage(error)} />}
      {isPending ? (
        <p className="text-sm text-slate-500">Loading invoices…</p>
      ) : (
        <DataTable
          headers={["Number", "Customer", "Status", "Due date", "Total", "Balance"]}
          empty={
            invoices && invoices.length === 0 ? <EmptyState>No invoices yet</EmptyState> : null
          }
        >
          {(invoices ?? []).map((inv) => (
            <tr key={inv.id}>
              <td className={cellClass}>
                <Link
                  to="/orgs/$orgId/invoices/$invoiceId"
                  params={{ orgId: org.id, invoiceId: inv.id }}
                  className="font-medium text-indigo-700 hover:underline"
                >
                  {inv.number ?? "Draft"}
                </Link>
              </td>
              <td className={`${cellClass} break-words`}>{inv.customerName}</td>
              <td className={cellClass}>{STATUS_LABELS[inv.status]}</td>
              <td className={`${cellClass} whitespace-nowrap`}>{inv.dueDate}</td>
              <td className={`${cellClass} text-right tabular-nums`}>
                {formatCents(inv.totalCents)}
              </td>
              <td className={`${cellClass} text-right tabular-nums`}>
                {formatCents(inv.balanceCents)}
              </td>
            </tr>
          ))}
        </DataTable>
      )}
    </section>
  );
}
