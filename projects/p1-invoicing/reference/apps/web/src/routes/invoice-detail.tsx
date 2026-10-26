import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useId, useState, type FormEvent } from "react";

import { ErrorAlert, StatusMessage } from "@/components/Alert.tsx";
import { ConfirmDialog } from "@/components/ConfirmDialog.tsx";
import { Dialog } from "@/components/Dialog.tsx";
import { TextField } from "@/components/Field.tsx";
import { PendingButton } from "@/components/PendingButton.tsx";
import { cellClass, DataTable, EmptyState } from "@/components/Table.tsx";
import { inputClass, primaryButton, secondaryButton } from "@/components/ui.ts";
import { ApiError, api, errorMessage } from "@/lib/api.ts";
import {
  canWrite,
  invoiceQuery,
  orgPath,
  paymentsQuery,
  STATUS_LABELS,
  type Invoice,
  type Payment,
} from "@/lib/data.ts";
import { formatCents, parseHundredths, todayUtc } from "@/lib/money.ts";
import { useOrg } from "@/lib/org-context.ts";

const METHODS: Array<{ value: Payment["method"]; label: string }> = [
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card" },
  { value: "other", label: "Other" },
];

function PaymentDialog({
  orgId,
  invoiceId,
  onClose,
  onSaved,
}: {
  orgId: string;
  invoiceId: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const methodId = useId();
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<Payment["method"]>("bank_transfer");
  const [date, setDate] = useState(todayUtc());
  const [reference, setReference] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const amountCents = parseHundredths(amount);
    if (amountCents === null) {
      setError("Amount must be a positive amount with at most 2 decimals");
      return;
    }
    setPending(true);
    try {
      await api(`${orgPath(orgId)}/invoices/${encodeURIComponent(invoiceId)}/payments`, {
        body: { amountCents, method, paidAt: date || undefined, reference: reference || null },
      });
      await onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
    }
  };

  return (
    <Dialog title="Record payment" onClose={onClose}>
      <form noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        <TextField
          label="Amount"
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <div className="flex flex-col gap-1">
          <label htmlFor={methodId} className="text-sm font-medium">
            Method
          </label>
          <select
            id={methodId}
            className={inputClass}
            value={method}
            onChange={(e) => {
              const next = METHODS.find((m) => m.value === e.target.value);
              if (next) setMethod(next.value);
            }}
          >
            {METHODS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        <TextField
          label="Date"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
        <TextField
          label="Reference"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
        />
        <ErrorAlert message={error} />
        <PendingButton type="submit" className={primaryButton} pending={pending}>
          Save payment
        </PendingButton>
      </form>
    </Dialog>
  );
}

function Amounts({ invoice }: { invoice: Invoice }) {
  const rows: Array<[string, number]> = [
    ["Subtotal", invoice.subtotalCents],
    ["Tax", invoice.taxCents],
    ["Total", invoice.totalCents],
    ["Paid", invoice.paidCents],
    ["Balance", invoice.balanceCents],
  ];
  return (
    <ul className="ml-auto flex w-full max-w-xs flex-col gap-1 text-sm">
      {rows.map(([label, cents]) => (
        <li
          key={label}
          className={`tabular-nums ${label === "Total" || label === "Balance" ? "font-semibold" : ""}`}
        >
          {`${label}: ${formatCents(cents)}`}
        </li>
      ))}
    </ul>
  );
}

type Action = "issue" | "delete" | "void" | "pay" | null;

export function InvoiceDetailPage() {
  const org = useOrg();
  const invoiceId = useParams({ strict: false }).invoiceId ?? "";
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: invoice, error, isPending } = useQuery(invoiceQuery(org.id, invoiceId));
  const { data: payments } = useQuery({ ...paymentsQuery(org.id, invoiceId), enabled: !!invoice });
  const [action, setAction] = useState<Action>(null);
  const [status, setStatus] = useState<string | null>(null);

  if (isPending) return <p className="text-sm text-slate-500">Loading invoice…</p>;
  if (error instanceof ApiError && error.status === 404) {
    return (
      <p className="rounded-lg border border-slate-200 bg-white p-6 text-slate-700">
        Invoice not found
      </p>
    );
  }
  if (error || !invoice) return <ErrorAlert message={errorMessage(error)} />;

  const writer = canWrite(org.role);
  const path = `${orgPath(org.id)}/invoices/${encodeURIComponent(invoice.id)}`;
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["org", org.id] });

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-xl font-semibold">{invoice.number ?? "Draft invoice"}</h2>
          <p className="text-sm">{`Status: ${STATUS_LABELS[invoice.status]}`}</p>
          <p className="text-sm break-words">{`Customer: ${invoice.customerName}`}</p>
          <p className="text-sm">{`Due date: ${invoice.dueDate}`}</p>
          {invoice.issueDate && (
            <p className="text-sm text-slate-600">{`Issue date: ${invoice.issueDate}`}</p>
          )}
        </div>
        {writer && (
          <div className="flex flex-wrap gap-2">
            {invoice.status === "draft" && (
              <>
                <Link
                  to="/orgs/$orgId/invoices/$invoiceId/edit"
                  params={{ orgId: org.id, invoiceId: invoice.id }}
                  className={secondaryButton}
                >
                  Edit
                </Link>
                <button type="button" className={primaryButton} onClick={() => setAction("issue")}>
                  Issue invoice
                </button>
                <button
                  type="button"
                  className={secondaryButton}
                  onClick={() => setAction("delete")}
                >
                  Delete draft
                </button>
              </>
            )}
            {invoice.status === "issued" && (
              <>
                <button type="button" className={primaryButton} onClick={() => setAction("pay")}>
                  Record payment
                </button>
                <button type="button" className={secondaryButton} onClick={() => setAction("void")}>
                  Void invoice
                </button>
              </>
            )}
          </div>
        )}
      </div>
      <StatusMessage message={status} />

      <DataTable headers={["Description", "Quantity", "Unit price", "Tax", "Amount"]}>
        {(invoice.lines ?? []).map((line, i) => (
          <tr key={i}>
            <td className={`${cellClass} break-words`}>{line.description}</td>
            <td className={`${cellClass} tabular-nums`}>{line.quantity}</td>
            <td className={`${cellClass} tabular-nums`}>{formatCents(line.unitPriceCents)}</td>
            <td className={`${cellClass} tabular-nums`}>{formatCents(line.taxCents)}</td>
            <td className={`${cellClass} tabular-nums`}>{formatCents(line.totalCents)}</td>
          </tr>
        ))}
      </DataTable>
      <Amounts invoice={invoice} />
      {invoice.notes && (
        <p className="text-sm whitespace-pre-line text-slate-600">{invoice.notes}</p>
      )}

      <div className="flex flex-col gap-3">
        <h3 className="text-lg font-semibold">Payments</h3>
        <DataTable
          headers={["Date", "Amount", "Method", "Source", "Status"]}
          empty={
            payments && payments.length === 0 ? <EmptyState>No payments yet</EmptyState> : null
          }
        >
          {(payments ?? []).map((p) => (
            <tr key={p.id}>
              <td className={`${cellClass} whitespace-nowrap`}>{p.paidAt}</td>
              <td className={`${cellClass} tabular-nums`}>{formatCents(p.amountCents)}</td>
              <td className={cellClass}>
                {METHODS.find((m) => m.value === p.method)?.label ?? p.method}
              </td>
              <td className={cellClass}>{p.source === "payflow" ? "PayFlow" : "Manual"}</td>
              <td className={cellClass}>{p.refunded ? "Refunded" : "Received"}</td>
            </tr>
          ))}
        </DataTable>
      </div>

      {action === "issue" && (
        <ConfirmDialog
          title="Issue this invoice?"
          confirmLabel="Confirm issue"
          pendingLabel="Issuing…"
          onClose={() => setAction(null)}
          onConfirm={async () => {
            const issued = await api<Invoice>(`${path}/issue`, { body: {} });
            setAction(null);
            setStatus(`Invoice issued as ${issued.number ?? ""}`);
            await refresh();
          }}
        >
          Issuing assigns the next invoice number. Issued invoices can no longer be edited.
        </ConfirmDialog>
      )}
      {action === "delete" && (
        <ConfirmDialog
          title="Delete this draft?"
          confirmLabel="Confirm delete"
          pendingLabel="Deleting…"
          onClose={() => setAction(null)}
          onConfirm={async () => {
            await api(path, { method: "DELETE" });
            await refresh();
            await navigate({ to: "/orgs/$orgId/invoices", params: { orgId: org.id } });
          }}
        >
          The draft and its lines are deleted permanently.
        </ConfirmDialog>
      )}
      {action === "void" && (
        <ConfirmDialog
          title="Void this invoice?"
          confirmLabel="Confirm void"
          pendingLabel="Voiding…"
          onClose={() => setAction(null)}
          onConfirm={async () => {
            await api(`${path}/void`, { body: {} });
            setAction(null);
            setStatus("Invoice voided");
            await refresh();
          }}
        >
          A voided invoice keeps its number but no longer counts as receivable.
        </ConfirmDialog>
      )}
      {action === "pay" && (
        <PaymentDialog
          orgId={org.id}
          invoiceId={invoice.id}
          onClose={() => setAction(null)}
          onSaved={async () => {
            setAction(null);
            setStatus("Payment recorded");
            await refresh();
          }}
        />
      )}
    </section>
  );
}
