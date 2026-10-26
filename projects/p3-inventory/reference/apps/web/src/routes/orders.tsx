import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { ErrorAlert } from "@/components/Alert.tsx";
import { Loading, PageHeader } from "@/components/Page.tsx";
import { cellClass, DataTable, EmptyState } from "@/components/Table.tsx";
import { primaryButton } from "@/components/ui.ts";
import { errorMessage } from "@/lib/api.ts";
import { formatDateTime, ordersQuery, STATUS_LABELS } from "@/lib/inventory.ts";

export function OrdersPage() {
  const orders = useQuery(ordersQuery);
  return (
    <div>
      <PageHeader title="Orders">
        <Link to="/orders/new" className={primaryButton}>
          New order
        </Link>
      </PageHeader>
      {orders.isPending ? (
        <Loading />
      ) : orders.isError ? (
        <ErrorAlert message={errorMessage(orders.error)} />
      ) : (
        <DataTable
          headers={["Customer", "Status", "Lines", "Created"]}
          empty={orders.data.length === 0 && <EmptyState>No orders yet</EmptyState>}
        >
          {orders.data.map((o) => (
            <tr key={o.id}>
              <td className={cellClass}>
                <Link
                  to="/orders/$orderId"
                  params={{ orderId: o.id }}
                  className="font-medium text-indigo-700 underline"
                >
                  {o.customer}
                </Link>
              </td>
              <td className={cellClass}>{STATUS_LABELS[o.status]}</td>
              <td className={cellClass}>
                {o.lines.map((l) => `${l.sku} × ${l.quantity}`).join(", ")}
              </td>
              <td className={cellClass}>{formatDateTime(o.createdAt)}</td>
            </tr>
          ))}
        </DataTable>
      )}
    </div>
  );
}
