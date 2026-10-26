import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useId, useState, type FormEvent } from "react";

import { ErrorAlert } from "@/components/Alert.tsx";
import { TextField } from "@/components/Field.tsx";
import { PendingButton } from "@/components/PendingButton.tsx";
import { inputClass, primaryButton, secondaryButton } from "@/components/ui.ts";
import { ApiError, api, errorMessage } from "@/lib/api.ts";
import { canWrite, customersQuery, invoiceQuery, orgPath, type Invoice } from "@/lib/data.ts";
import { bpsToInput, centsToInput, parseHundredths } from "@/lib/money.ts";
import { useOrg } from "@/lib/org-context.ts";

interface LineDraft {
  key: number;
  description: string;
  quantity: string;
  unitPrice: string;
  taxRate: string;
}

let nextKey = 1;
const emptyLine = (): LineDraft => ({
  key: nextKey++,
  description: "",
  quantity: "1",
  unitPrice: "",
  taxRate: "0",
});

function toPayload(lines: LineDraft[]) {
  const errors: string[] = [];
  const payload = lines.map((l, i) => {
    const n = i + 1;
    const unitPriceCents = parseHundredths(l.unitPrice);
    const taxRateBps = parseHundredths(l.taxRate);
    if (unitPriceCents === null)
      errors.push(`Unit price ${n} must be an amount with at most 2 decimals`);
    if (taxRateBps === null)
      errors.push(`Tax rate ${n} must be a percentage with at most 2 decimals`);
    const quantity = /^\d+$/.test(l.quantity.trim()) ? Number(l.quantity.trim()) : Number.NaN;
    if (Number.isNaN(quantity)) errors.push(`Quantity ${n} must be a whole number`);
    return {
      description: l.description,
      quantity,
      unitPriceCents: unitPriceCents ?? 0,
      taxRateBps: taxRateBps ?? 0,
    };
  });
  return { payload, error: errors.length ? errors.join(". ") : null };
}

function InvoiceForm({ invoice }: { invoice: Invoice | null }) {
  const org = useOrg();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: customers = [] } = useQuery(customersQuery(org.id));
  const customerId = useId();
  const notesId = useId();
  const [customer, setCustomer] = useState(invoice?.customerId ?? "");
  const [dueDate, setDueDate] = useState(invoice?.dueDate ?? "");
  const [notes, setNotes] = useState(invoice?.notes ?? "");
  const [lines, setLines] = useState<LineDraft[]>(
    invoice?.lines?.length
      ? invoice.lines.map((l) => ({
          key: nextKey++,
          description: l.description,
          quantity: String(l.quantity),
          unitPrice: centsToInput(l.unitPriceCents),
          taxRate: bpsToInput(l.taxRateBps),
        }))
      : [emptyLine()],
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const selectedCustomer = customer || customers[0]?.id || "";
  const update = (key: number, patch: Partial<LineDraft>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const { payload, error: clientError } = toPayload(lines);
    if (clientError) {
      setError(clientError);
      return;
    }
    setPending(true);
    try {
      const body = { customerId: selectedCustomer, dueDate, notes: notes || null, lines: payload };
      const saved = invoice
        ? await api<Invoice>(`${orgPath(org.id)}/invoices/${encodeURIComponent(invoice.id)}`, {
            method: "PATCH",
            body,
          })
        : await api<Invoice>(`${orgPath(org.id)}/invoices`, { body });
      await queryClient.invalidateQueries({ queryKey: ["org", org.id] });
      await navigate({
        to: "/orgs/$orgId/invoices/$invoiceId",
        params: { orgId: org.id, invoiceId: saved.id },
      });
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
    }
  };

  return (
    <form noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-5">
      <div className="grid gap-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={customerId} className="text-sm font-medium">
            Customer
          </label>
          <select
            id={customerId}
            className={inputClass}
            value={selectedCustomer}
            onChange={(e) => setCustomer(e.target.value)}
          >
            {customers.length === 0 && <option value="">No customers yet</option>}
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <TextField
          label="Due date"
          type="date"
          value={dueDate}
          onChange={(e) => setDueDate(e.target.value)}
        />
        <div className="flex flex-col gap-1 sm:col-span-2">
          <label htmlFor={notesId} className="text-sm font-medium">
            Notes
          </label>
          <textarea
            id={notesId}
            rows={2}
            className={inputClass}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
      </div>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-lg font-semibold">Lines</legend>
        {lines.map((line, i) => {
          const n = i + 1;
          return (
            <div
              key={line.key}
              className="grid gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-[2fr_1fr_1fr_1fr_auto] sm:items-end"
            >
              <TextField
                label={`Description ${n}`}
                value={line.description}
                onChange={(e) => update(line.key, { description: e.target.value })}
              />
              <TextField
                label={`Quantity ${n}`}
                inputMode="numeric"
                value={line.quantity}
                onChange={(e) => update(line.key, { quantity: e.target.value })}
              />
              <TextField
                label={`Unit price ${n}`}
                inputMode="decimal"
                placeholder="0.00"
                value={line.unitPrice}
                onChange={(e) => update(line.key, { unitPrice: e.target.value })}
              />
              <TextField
                label={`Tax rate ${n}`}
                inputMode="decimal"
                placeholder="%"
                value={line.taxRate}
                onChange={(e) => update(line.key, { taxRate: e.target.value })}
              />
              <button
                type="button"
                className={secondaryButton}
                disabled={lines.length === 1}
                onClick={() => setLines((ls) => ls.filter((l) => l.key !== line.key))}
              >
                Remove line {n}
              </button>
            </div>
          );
        })}
        <div>
          <button
            type="button"
            className={secondaryButton}
            onClick={() => setLines((ls) => [...ls, emptyLine()])}
          >
            Add line
          </button>
        </div>
      </fieldset>
      <ErrorAlert message={error} />
      <div>
        <PendingButton type="submit" className={primaryButton} pending={pending}>
          Save draft
        </PendingButton>
      </div>
    </form>
  );
}

export function NewInvoicePage() {
  const org = useOrg();
  if (!canWrite(org.role))
    return <p className="text-slate-600">Your role does not allow creating invoices.</p>;
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-xl font-semibold">New invoice</h2>
      <InvoiceForm invoice={null} />
    </section>
  );
}

export function EditInvoicePage() {
  const org = useOrg();
  const invoiceId = useParams({ strict: false }).invoiceId ?? "";
  const { data: invoice, error, isPending } = useQuery(invoiceQuery(org.id, invoiceId));
  if (isPending) return <p className="text-sm text-slate-500">Loading invoice…</p>;
  if (error instanceof ApiError && error.status === 404)
    return <p className="text-slate-700">Invoice not found</p>;
  if (error || !invoice) return <ErrorAlert message={errorMessage(error)} />;
  if (!canWrite(org.role) || invoice.status !== "draft") {
    return <p className="text-slate-600">Only draft invoices can be edited.</p>;
  }
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-xl font-semibold">Edit draft invoice</h2>
      <InvoiceForm invoice={invoice} />
    </section>
  );
}
