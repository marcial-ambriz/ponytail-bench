import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useState } from "react";

import { ErrorAlert, StatusMessage } from "@/components/Alert.tsx";
import { ConfirmDialog } from "@/components/ConfirmDialog.tsx";
import { Loading, PageHeader } from "@/components/Page.tsx";
import { PendingButton } from "@/components/PendingButton.tsx";
import { cellClass, DataTable } from "@/components/Table.tsx";
import { primaryButton, secondaryButton } from "@/components/ui.ts";
import { useAction } from "@/components/useAction.ts";
import { api, errorMessage } from "@/lib/api.ts";
import { formatDateTime, orderQuery, STATUS_LABELS } from "@/lib/inventory.ts";

export function OrderDetailPage() {
  const { orderId } = useParams({ from: "/authed/orders/$orderId" });
  const queryClient = useQueryClient();
  const order = useQuery(orderQuery(orderId));
  const ship = useAction();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelled, setCancelled] = useState<string | null>(null);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["orders"] });
    await queryClient.invalidateQueries({ queryKey: ["products"] });
  };

  if (order.isPending) return <Loading />;
  if (order.isError) return <ErrorAlert message={errorMessage(order.error)} />;
  const o = order.data;

  return (
    <div>
      <PageHeader title={o.customer}>
        {o.status === "reserved" && (
          <>
            <PendingButton
              type="button"
              pending={ship.pending}
              className={primaryButton}
              onClick={() =>
                void ship.run(
                  () => api(`/api/orders/${o.id}/ship`, { body: {} }).then(refresh),
                  "Order shipped",
                )
              }
            >
              Ship order
            </PendingButton>
            <button
              type="button"
              className={secondaryButton}
              onClick={() => setConfirmCancel(true)}
            >
              Cancel order
            </button>
          </>
        )}
      </PageHeader>
      <p className="mb-2 text-sm text-slate-600">
        Status: <span className="font-semibold text-slate-900">{STATUS_LABELS[o.status]}</span> ·
        Created {formatDateTime(o.createdAt)} by {o.createdBy}
      </p>
      <div className="mb-4 flex flex-col gap-2">
        <ErrorAlert message={ship.error} />
        <StatusMessage message={ship.success ?? cancelled} />
      </div>
      <DataTable headers={["SKU", "Quantity"]}>
        {o.lines.map((l) => (
          <tr key={l.productId}>
            <td className={`${cellClass} font-mono`}>{l.sku}</td>
            <td className={cellClass}>{l.quantity}</td>
          </tr>
        ))}
      </DataTable>
      {confirmCancel && (
        <ConfirmDialog
          title="Cancel this order?"
          confirmLabel="Confirm cancel"
          pendingLabel="Cancelling…"
          onClose={() => setConfirmCancel(false)}
          onConfirm={async () => {
            await api(`/api/orders/${o.id}/cancel`, { body: {} });
            await refresh();
            setConfirmCancel(false);
            setCancelled("Order cancelled");
          }}
        >
          The reserved stock is released.
        </ConfirmDialog>
      )}
    </div>
  );
}
