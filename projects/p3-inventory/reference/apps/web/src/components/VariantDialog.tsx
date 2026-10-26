import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { api } from "@/lib/api.ts";

import { ErrorAlert } from "./Alert.tsx";
import { Dialog } from "./Dialog.tsx";
import { TextField } from "./Field.tsx";
import { PendingButton } from "./PendingButton.tsx";
import { primaryButton } from "./ui.ts";
import { useAction } from "./useAction.ts";

export function VariantDialog({ productId, onClose }: { productId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [sku, setSku] = useState("");
  const [name, setName] = useState("");
  const [reorderPoint, setReorderPoint] = useState("0");
  const { pending, error, run } = useAction();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const ok = await run(() =>
      api(`/api/products/${productId}/variants`, {
        body: { sku, name, reorderPoint: reorderPoint.trim() === "" ? 0 : Number(reorderPoint) },
      }),
    );
    if (ok) {
      await queryClient.invalidateQueries({ queryKey: ["products"] });
      onClose();
    }
  };

  return (
    <Dialog title="Add variant" onClose={onClose}>
      <form noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        <TextField label="SKU" value={sku} onChange={(e) => setSku(e.target.value)} />
        <TextField label="Variant name" value={name} onChange={(e) => setName(e.target.value)} />
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
