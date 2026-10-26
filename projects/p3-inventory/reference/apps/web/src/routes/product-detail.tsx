import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useState } from "react";

import { ErrorAlert } from "@/components/Alert.tsx";
import { MovementForm } from "@/components/MovementForm.tsx";
import { Card, Loading, PageHeader, Section } from "@/components/Page.tsx";
import { cellClass, DataTable, EmptyState } from "@/components/Table.tsx";
import { secondaryButton } from "@/components/ui.ts";
import { VariantDialog } from "@/components/VariantDialog.tsx";
import { errorMessage } from "@/lib/api.ts";
import { meQuery } from "@/lib/auth.ts";
import {
  formatDateTime,
  MOVEMENT_LABELS,
  movementsQuery,
  productQuery,
  signed,
  warehousesQuery,
} from "@/lib/inventory.ts";

export function ProductDetailPage() {
  const { productId } = useParams({ from: "/authed/products/$productId" });
  const { data: user } = useSuspenseQuery(meQuery);
  const product = useQuery(productQuery(productId));
  const movements = useQuery(movementsQuery(productId));
  const warehouses = useQuery(warehousesQuery);
  const [addingVariant, setAddingVariant] = useState(false);
  const isAdmin = user?.role === "admin";
  const warehouseName = (id: string) => warehouses.data?.find((w) => w.id === id)?.name ?? id;

  if (product.isPending) return <Loading />;
  if (product.isError) return <ErrorAlert message={errorMessage(product.error)} />;
  const p = product.data;

  return (
    <div>
      <PageHeader title={p.name} />
      <div className="grid gap-4 sm:grid-cols-4">
        <Card>
          <p className="font-mono text-sm">SKU: {p.sku}</p>
          {p.description && <p className="mt-2 text-sm text-slate-600">{p.description}</p>}
        </Card>
        <Card>
          <p className="text-lg font-semibold">On hand: {p.onHand}</p>
        </Card>
        <Card>
          <p className="text-lg font-semibold">Reserved: {p.reserved}</p>
        </Card>
        <Card>
          <p className="text-lg font-semibold">Available: {p.available}</p>
          <p className="text-xs text-slate-500">Reorder point: {p.reorderPoint}</p>
        </Card>
      </div>

      <Section title="Variants">
        {isAdmin && (
          <div className="mb-3">
            <button
              type="button"
              className={secondaryButton}
              onClick={() => setAddingVariant(true)}
            >
              Add variant
            </button>
          </div>
        )}
        <DataTable headers={["SKU", "Variant", "On hand", "Available"]}>
          {p.variants.map((v) => (
            <tr key={v.id}>
              <td className={`${cellClass} font-mono`}>{v.sku}</td>
              <td className={cellClass}>{v.name}</td>
              <td className={cellClass}>{v.onHand}</td>
              <td className={cellClass}>{v.available}</td>
            </tr>
          ))}
        </DataTable>
      </Section>

      <Section title="Stock by warehouse">
        <DataTable
          headers={["Warehouse", "SKU", "On hand", "Reserved", "Available"]}
          empty={p.stock.length === 0 && <EmptyState>No stock in any warehouse</EmptyState>}
        >
          {p.stock.map((s) => (
            <tr key={`${s.variantId}-${s.warehouseId}`}>
              <td className={cellClass}>{warehouseName(s.warehouseId)}</td>
              <td className={`${cellClass} font-mono`}>{s.sku}</td>
              <td className={cellClass}>{s.onHand}</td>
              <td className={cellClass}>{s.reserved}</td>
              <td className={cellClass}>{s.available}</td>
            </tr>
          ))}
        </DataTable>
      </Section>

      <Section title="Record movement">
        <MovementForm key={p.variants.length} product={p} isAdmin={isAdmin} />
      </Section>

      <Section title="History">
        {movements.isPending ? (
          <Loading />
        ) : movements.isError ? (
          <ErrorAlert message={errorMessage(movements.error)} />
        ) : (
          <DataTable
            headers={["Date", "Type", "SKU", "Warehouse", "Quantity", "Balance", "User"]}
            empty={movements.data.length === 0 && <EmptyState>No movements yet</EmptyState>}
          >
            {movements.data.map((m) => (
              <tr key={m.id}>
                <td className={cellClass}>{formatDateTime(m.createdAt)}</td>
                <td className={cellClass}>{MOVEMENT_LABELS[m.type]}</td>
                <td className={`${cellClass} font-mono`}>{m.sku}</td>
                <td className={cellClass}>{warehouseName(m.warehouseId)}</td>
                <td className={cellClass}>{signed(m.quantity)}</td>
                <td className={cellClass}>{m.balanceAfter}</td>
                <td className={cellClass}>{m.userName}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </Section>
      {addingVariant && <VariantDialog productId={p.id} onClose={() => setAddingVariant(false)} />}
    </div>
  );
}
