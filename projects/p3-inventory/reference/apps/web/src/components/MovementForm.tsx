import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { api } from "@/lib/api.ts";
import { parseCents, warehousesQuery, type MovementType, type Product } from "@/lib/inventory.ts";

import { ErrorAlert, StatusMessage } from "./Alert.tsx";
import { TextField } from "./Field.tsx";
import { PendingButton } from "./PendingButton.tsx";
import { SelectField } from "./Select.tsx";
import { primaryButton } from "./ui.ts";
import { useAction } from "./useAction.ts";

const toMovementType = (value: string): MovementType =>
  value === "issue" || value === "adjustment" ? value : "receipt";

export function MovementForm({ product, isAdmin }: { product: Product; isAdmin: boolean }) {
  const productId = product.id;
  const queryClient = useQueryClient();
  const warehouses = useQuery(warehousesQuery);
  const [variantId, setVariantId] = useState(product.variants[0]?.id ?? "");
  const [warehouseId, setWarehouseId] = useState("");
  const mainId = warehouses.data?.find((w) => w.code === "MAIN")?.id ?? "";
  const selectedWarehouse = warehouseId || mainId;
  const [type, setType] = useState<MovementType>("receipt");
  const [quantity, setQuantity] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [reason, setReason] = useState("");
  const { pending, error, success, run, setError } = useAction();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const body: Record<string, unknown> = { type, quantity: Number(quantity), variantId };
    if (selectedWarehouse) body.warehouseId = selectedWarehouse;
    if (quantity.trim() === "") body.quantity = null;
    if (type === "receipt") {
      const cents = parseCents(unitCost);
      if (cents === null) {
        setError("Unit cost must be an amount such as 2.50");
        return;
      }
      body.unitCostCents = cents;
    } else {
      body.reason = reason;
    }
    const ok = await run(
      () => api(`/api/products/${productId}/movements`, { body }),
      "Movement recorded",
    );
    if (ok) {
      setQuantity("");
      setReason("");
      await queryClient.invalidateQueries({ queryKey: ["products"] });
    }
  };

  return (
    <form
      noValidate
      onSubmit={(e) => void submit(e)}
      className="grid gap-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-2"
    >
      <SelectField label="Variant" value={variantId} onChange={(e) => setVariantId(e.target.value)}>
        {product.variants.map((v) => (
          <option key={v.id} value={v.id}>
            {v.sku} ({v.name})
          </option>
        ))}
      </SelectField>
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
      <SelectField
        label="Type"
        value={type}
        onChange={(e) => setType(toMovementType(e.target.value))}
      >
        <option value="receipt">Receipt</option>
        <option value="issue">Issue</option>
        {isAdmin && <option value="adjustment">Adjustment</option>}
      </SelectField>
      <TextField
        label="Quantity"
        type="number"
        inputMode="numeric"
        value={quantity}
        onChange={(e) => setQuantity(e.target.value)}
      />
      {type === "receipt" ? (
        <TextField
          label="Unit cost"
          inputMode="decimal"
          placeholder="0.00"
          value={unitCost}
          onChange={(e) => setUnitCost(e.target.value)}
        />
      ) : (
        <TextField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      )}
      <div className="flex flex-col justify-end gap-2 sm:col-span-2">
        <ErrorAlert message={error} />
        <StatusMessage message={success} />
        <PendingButton type="submit" pending={pending} className={`${primaryButton} sm:self-start`}>
          Record
        </PendingButton>
      </div>
    </form>
  );
}
