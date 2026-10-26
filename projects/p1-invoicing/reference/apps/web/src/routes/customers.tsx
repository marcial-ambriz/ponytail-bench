import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { ErrorAlert, StatusMessage } from "@/components/Alert.tsx";
import { ConfirmDialog } from "@/components/ConfirmDialog.tsx";
import { Dialog } from "@/components/Dialog.tsx";
import { TextField } from "@/components/Field.tsx";
import { PendingButton } from "@/components/PendingButton.tsx";
import { cellClass, DataTable, EmptyState } from "@/components/Table.tsx";
import { primaryButton, secondaryButton } from "@/components/ui.ts";
import { api, errorMessage } from "@/lib/api.ts";
import { canWrite, customersQuery, orgPath, type Customer } from "@/lib/data.ts";
import { useOrg } from "@/lib/org-context.ts";

function CustomerDialog({
  orgId,
  customer,
  onClose,
  onSaved,
}: {
  orgId: string;
  customer: Customer | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [name, setName] = useState(customer?.name ?? "");
  const [email, setEmail] = useState(customer?.email ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      if (customer) {
        await api(`${orgPath(orgId)}/customers/${encodeURIComponent(customer.id)}`, {
          method: "PATCH",
          body: { name, email },
        });
      } else {
        await api(`${orgPath(orgId)}/customers`, { body: { name, email } });
      }
      onSaved(customer ? "Customer updated" : "Customer created");
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
    }
  };

  return (
    <Dialog title={customer ? "Edit customer" : "New customer"} onClose={onClose}>
      <form noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <TextField
          label="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <ErrorAlert message={error} />
        <PendingButton type="submit" className={primaryButton} pending={pending}>
          Save
        </PendingButton>
      </form>
    </Dialog>
  );
}

export function CustomersPage() {
  const org = useOrg();
  const queryClient = useQueryClient();
  const { data: customers, error, isPending } = useQuery(customersQuery(org.id));
  const [editing, setEditing] = useState<Customer | "new" | null>(null);
  const [deleting, setDeleting] = useState<Customer | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const writer = canWrite(org.role);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: customersQuery(org.id).queryKey });

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">Customers</h2>
        {writer && (
          <button type="button" className={primaryButton} onClick={() => setEditing("new")}>
            New customer
          </button>
        )}
      </div>
      <StatusMessage message={status} />
      {error && <ErrorAlert message={errorMessage(error)} />}
      {isPending ? (
        <p className="text-sm text-slate-500">Loading customers…</p>
      ) : (
        <DataTable
          headers={writer ? ["Name", "Email", "Actions"] : ["Name", "Email"]}
          empty={
            customers && customers.length === 0 ? <EmptyState>No customers yet</EmptyState> : null
          }
        >
          {(customers ?? []).map((c) => (
            <tr key={c.id}>
              <td className={`${cellClass} break-words`}>{c.name}</td>
              <td className={`${cellClass} break-all`}>{c.email}</td>
              {writer && (
                <td className={cellClass}>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className={secondaryButton} onClick={() => setEditing(c)}>
                      Edit
                    </button>
                    <button
                      type="button"
                      className={secondaryButton}
                      onClick={() => setDeleting(c)}
                    >
                      Delete
                    </button>
                  </div>
                </td>
              )}
            </tr>
          ))}
        </DataTable>
      )}
      {editing && (
        <CustomerDialog
          orgId={org.id}
          customer={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null);
            setStatus(message);
            void refresh();
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          confirmLabel="Confirm delete"
          pendingLabel="Deleting…"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api(`${orgPath(org.id)}/customers/${encodeURIComponent(deleting.id)}`, {
              method: "DELETE",
            });
            setDeleting(null);
            setStatus("Customer deleted");
            await refresh();
          }}
        >
          This permanently deletes the customer.
        </ConfirmDialog>
      )}
    </section>
  );
}
