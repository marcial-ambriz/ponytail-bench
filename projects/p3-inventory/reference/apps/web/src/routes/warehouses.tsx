import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { ErrorAlert } from "@/components/Alert.tsx";
import { Dialog } from "@/components/Dialog.tsx";
import { TextField } from "@/components/Field.tsx";
import { Loading, PageHeader } from "@/components/Page.tsx";
import { PendingButton } from "@/components/PendingButton.tsx";
import { cellClass, DataTable } from "@/components/Table.tsx";
import { primaryButton } from "@/components/ui.ts";
import { useAction } from "@/components/useAction.ts";
import { api, errorMessage } from "@/lib/api.ts";
import { warehousesQuery } from "@/lib/inventory.ts";

function NewWarehouseDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const { pending, error, run } = useAction();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (await run(() => api("/api/warehouses", { body: { code, name } }))) {
      await queryClient.invalidateQueries({ queryKey: ["warehouses"] });
      onClose();
    }
  };

  return (
    <Dialog title="New warehouse" onClose={onClose}>
      <form noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        <TextField label="Code" value={code} onChange={(e) => setCode(e.target.value)} />
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <ErrorAlert message={error} />
        <PendingButton type="submit" pending={pending} className={primaryButton}>
          Save
        </PendingButton>
      </form>
    </Dialog>
  );
}

export function WarehousesPage() {
  const warehouses = useQuery(warehousesQuery);
  const [creating, setCreating] = useState(false);
  return (
    <div>
      <PageHeader title="Warehouses">
        <button type="button" className={primaryButton} onClick={() => setCreating(true)}>
          New warehouse
        </button>
      </PageHeader>
      {warehouses.isPending ? (
        <Loading />
      ) : warehouses.isError ? (
        <ErrorAlert message={errorMessage(warehouses.error)} />
      ) : (
        <DataTable headers={["Code", "Name"]}>
          {warehouses.data.map((w) => (
            <tr key={w.id}>
              <td className={`${cellClass} font-mono`}>{w.code}</td>
              <td className={cellClass}>{w.name}</td>
            </tr>
          ))}
        </DataTable>
      )}
      {creating && <NewWarehouseDialog onClose={() => setCreating(false)} />}
    </div>
  );
}
