import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { ErrorAlert } from "@/components/Alert.tsx";
import { Loading, PageHeader } from "@/components/Page.tsx";
import { cellClass, DataTable, EmptyState } from "@/components/Table.tsx";
import { errorMessage } from "@/lib/api.ts";
import { lowStockQuery } from "@/lib/inventory.ts";

export function AlertsPage() {
  const alerts = useQuery(lowStockQuery);
  return (
    <div>
      <PageHeader title="Low stock" />
      {alerts.isPending ? (
        <Loading />
      ) : alerts.isError ? (
        <ErrorAlert message={errorMessage(alerts.error)} />
      ) : (
        <DataTable
          headers={["SKU", "Name", "Variant", "Available", "Reorder point"]}
          empty={alerts.data.length === 0 && <EmptyState>No low-stock products</EmptyState>}
        >
          {alerts.data.map((a) => (
            <tr key={a.variantId}>
              <td className={cellClass}>
                <Link
                  to="/products/$productId"
                  params={{ productId: a.productId }}
                  className="font-mono text-indigo-700 underline"
                >
                  {a.sku}
                </Link>
              </td>
              <td className={cellClass}>{a.name}</td>
              <td className={cellClass}>{a.variantName}</td>
              <td className={`${cellClass} font-semibold text-red-700`}>{a.available}</td>
              <td className={cellClass}>{a.reorderPoint}</td>
            </tr>
          ))}
        </DataTable>
      )}
    </div>
  );
}
