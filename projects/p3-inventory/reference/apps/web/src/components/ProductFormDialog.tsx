import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { api } from "@/lib/api.ts";
import type { Product } from "@/lib/inventory.ts";

import { ErrorAlert } from "./Alert.tsx";
import { Dialog } from "./Dialog.tsx";
import { TextField } from "./Field.tsx";
import { PendingButton } from "./PendingButton.tsx";
import { primaryButton } from "./ui.ts";
import { useAction } from "./useAction.ts";

interface Props {
  product?: Product;
  onClose: () => void;
}

/** Create/edit dialog. Numbers are sent as typed so the server validates them. */
export function ProductFormDialog({ product, onClose }: Props) {
  const queryClient = useQueryClient();
  const [sku, setSku] = useState(product?.sku ?? "");
  const [name, setName] = useState(product?.name ?? "");
  const [description, setDescription] = useState(product?.description ?? "");
  const [reorderPoint, setReorderPoint] = useState(String(product?.reorderPoint ?? 0));
  const { pending, error, run } = useAction();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const payload = {
      name,
      description,
      reorderPoint: reorderPoint.trim() === "" ? 0 : Number(reorderPoint),
    };
    const ok = await run(() =>
      product
        ? api(`/api/products/${product.id}`, { method: "PATCH", body: payload })
        : api("/api/products", { body: { ...payload, sku } }),
    );
    if (ok) {
      await queryClient.invalidateQueries({ queryKey: ["products"] });
      onClose();
    }
  };

  return (
    <Dialog title={product ? `Edit ${product.name}` : "New product"} onClose={onClose}>
      <form noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        <TextField
          label="SKU"
          value={sku}
          disabled={Boolean(product)}
          onChange={(e) => setSku(e.target.value)}
        />
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <TextField
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <TextField
          label="Reorder point"
          type="number"
          inputMode="numeric"
          value={reorderPoint}
          onChange={(e) => setReorderPoint(e.target.value)}
        />
        <ErrorAlert message={error} />
        <PendingButton type="submit" pending={pending} className={primaryButton}>
          Save
        </PendingButton>
      </form>
    </Dialog>
  );
}
