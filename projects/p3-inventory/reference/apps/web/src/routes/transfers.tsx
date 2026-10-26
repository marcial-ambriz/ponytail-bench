import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { ErrorAlert, StatusMessage } from "@/components/Alert.tsx";
import { TextField } from "@/components/Field.tsx";
import { Loading, PageHeader, Section } from "@/components/Page.tsx";
import { PendingButton } from "@/components/PendingButton.tsx";
import { SelectField } from "@/components/Select.tsx";
import { cellClass, DataTable, EmptyState } from "@/components/Table.tsx";
import { primaryButton } from "@/components/ui.ts";
import { useAction } from "@/components/useAction.ts";
import { api, errorMessage } from "@/lib/api.ts";
import {
  formatDateTime,
  productsQuery,
  transfersQuery,
  variantOptions,
  warehousesQuery,
} from "@/lib/inventory.ts";

export function TransfersPage() {
  const queryClient = useQueryClient();
  const products = useQuery(productsQuery());
  const warehouses = useQuery(warehousesQuery);
  const transfers = useQuery(transfersQuery);
  const [variantId, setVariantId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [quantity, setQuantity] = useState("");
  const { pending, error, success, run } = useAction();

  const options = variantOptions(products.data);
  const list = warehouses.data ?? [];
  const fromId = from || list[0]?.id || "";
  const toId = to || list.find((w) => w.id !== fromId)?.id || "";
  const name = (id: string) => list.find((w) => w.id === id)?.name ?? id;
  const sku = variantId || options[0]?.id || "";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const ok = await run(
      () =>
        api("/api/transfers", {
          body: {
            variantId: sku,
            fromWarehouseId: fromId,
            toWarehouseId: toId,
            quantity: quantity.trim() === "" ? null : Number(quantity),
          },
        }),
      "Transfer completed",
    );
    if (ok) {
      setQuantity("");
      await queryClient.invalidateQueries({ queryKey: ["transfers"] });
      await queryClient.invalidateQueries({ queryKey: ["products"] });
    }
  };

  return (
    <div>
      <PageHeader title="Transfers" />
      <form
        noValidate
        onSubmit={(e) => void submit(e)}
        className="grid gap-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-2"
      >
        <SelectField label="Variant" value={sku} onChange={(e) => setVariantId(e.target.value)}>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Quantity"
          type="number"
          inputMode="numeric"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
        />
        <SelectField label="From" value={fromId} onChange={(e) => setFrom(e.target.value)}>
          {list.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </SelectField>
        <SelectField label="To" value={toId} onChange={(e) => setTo(e.target.value)}>
          {list.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </SelectField>
        <div className="flex flex-col gap-2 sm:col-span-2">
          <ErrorAlert message={error} />
          <StatusMessage message={success} />
          <PendingButton
            type="submit"
            pending={pending}
            className={`${primaryButton} sm:self-start`}
          >
            Transfer
          </PendingButton>
        </div>
      </form>

      <Section title="Recent transfers">
        {transfers.isPending ? (
          <Loading />
        ) : transfers.isError ? (
          <ErrorAlert message={errorMessage(transfers.error)} />
        ) : (
          <DataTable
            headers={["Date", "SKU", "From", "To", "Quantity"]}
            empty={transfers.data.length === 0 && <EmptyState>No transfers yet</EmptyState>}
          >
            {transfers.data.map((t) => (
              <tr key={t.id}>
                <td className={cellClass}>{formatDateTime(t.createdAt)}</td>
                <td className={`${cellClass} font-mono`}>{t.sku}</td>
                <td className={cellClass}>{name(t.fromWarehouseId)}</td>
                <td className={cellClass}>{name(t.toWarehouseId)}</td>
                <td className={cellClass}>{t.quantity}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </Section>
    </div>
  );
}
