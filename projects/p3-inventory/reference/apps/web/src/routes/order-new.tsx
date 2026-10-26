import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";

import { ErrorAlert } from "@/components/Alert.tsx";
import { TextField } from "@/components/Field.tsx";
import { PageHeader } from "@/components/Page.tsx";
import { PendingButton } from "@/components/PendingButton.tsx";
import { SelectField } from "@/components/Select.tsx";
import { primaryButton, secondaryButton } from "@/components/ui.ts";
import { useAction } from "@/components/useAction.ts";
import { api } from "@/lib/api.ts";
import { productsQuery, variantOptions, warehousesQuery, type Order } from "@/lib/inventory.ts";

interface Line {
  key: number;
  variantId: string;
  quantity: string;
}

export function NewOrderPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const products = useQuery(productsQuery());
  const warehouses = useQuery(warehousesQuery);
  const [warehouseId, setWarehouseId] = useState("");
  const selectedWarehouse =
    warehouseId || warehouses.data?.find((w) => w.code === "MAIN")?.id || "";
  const options = variantOptions(products.data);
  const [customer, setCustomer] = useState("");
  const [lines, setLines] = useState<Line[]>([{ key: 1, variantId: "", quantity: "1" }]);
  const { pending, error, run } = useAction();

  const update = (key: number, patch: Partial<Line>) =>
    setLines((all) => all.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    let created: Order | undefined;
    const ok = await run(async () => {
      created = await api<Order>("/api/orders", {
        body: {
          customer,
          ...(selectedWarehouse ? { warehouseId: selectedWarehouse } : {}),
          lines: lines.map((l) => ({
            variantId: l.variantId,
            quantity: l.quantity.trim() === "" ? null : Number(l.quantity),
          })),
        },
      });
    });
    if (ok && created) {
      await queryClient.invalidateQueries({ queryKey: ["products"] });
      await queryClient.invalidateQueries({ queryKey: ["orders"] });
      await navigate({ to: "/orders/$orderId", params: { orderId: created.id } });
    }
  };

  return (
    <div className="max-w-2xl">
      <PageHeader title="New order" />
      <form
        noValidate
        onSubmit={(e) => void submit(e)}
        className="flex flex-col gap-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
      >
        <TextField
          label="Customer"
          value={customer}
          onChange={(e) => setCustomer(e.target.value)}
        />
        <SelectField
          label="Warehouse"
          value={selectedWarehouse}
          onChange={(e) => setWarehouseId(e.target.value)}
        >
          {warehouses.data?.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </SelectField>
        {lines.map((line, index) => (
          <fieldset key={line.key} className="grid gap-3 sm:grid-cols-[1fr_8rem_auto] sm:items-end">
            <legend className="sr-only">Line {index + 1}</legend>
            <SelectField
              label={`Line ${index + 1} product`}
              value={line.variantId}
              onChange={(e) => update(line.key, { variantId: e.target.value })}
            >
              <option value="">Choose a product…</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </SelectField>
            <TextField
              label={`Line ${index + 1} quantity`}
              type="number"
              inputMode="numeric"
              value={line.quantity}
              onChange={(e) => update(line.key, { quantity: e.target.value })}
            />
            {lines.length > 1 && (
              <button
                type="button"
                className={secondaryButton}
                onClick={() => setLines((all) => all.filter((l) => l.key !== line.key))}
              >
                Remove line {index + 1}
              </button>
            )}
          </fieldset>
        ))}
        <div>
          <button
            type="button"
            className={secondaryButton}
            onClick={() =>
              setLines((all) => [
                ...all,
                { key: Math.max(...all.map((l) => l.key)) + 1, variantId: "", quantity: "1" },
              ])
            }
          >
            Add line
          </button>
        </div>
        <ErrorAlert message={error} />
        <PendingButton type="submit" pending={pending} className={`${primaryButton} self-start`}>
          Place order
        </PendingButton>
      </form>
    </div>
  );
}
