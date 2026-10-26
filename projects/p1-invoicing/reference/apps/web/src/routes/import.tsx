import { useQueryClient } from "@tanstack/react-query";
import { useId, useState, type FormEvent } from "react";

import { ErrorAlert, StatusMessage } from "@/components/Alert.tsx";
import { PendingButton } from "@/components/PendingButton.tsx";
import { cellClass, DataTable } from "@/components/Table.tsx";
import { inputClass, primaryButton } from "@/components/ui.ts";
import { ApiError, api, errorMessage } from "@/lib/api.ts";
import { canWrite, orgPath } from "@/lib/data.ts";
import { useOrg } from "@/lib/org-context.ts";

interface RowError {
  row: number;
  errors: string[];
}

function isRowError(value: unknown): value is RowError {
  if (!value || typeof value !== "object") return false;
  const row: unknown = Reflect.get(value, "row");
  const errors: unknown = Reflect.get(value, "errors");
  return (
    typeof row === "number" && Array.isArray(errors) && errors.every((e) => typeof e === "string")
  );
}

function rowErrors(err: unknown): RowError[] {
  if (!(err instanceof ApiError) || !err.payload || typeof err.payload !== "object") return [];
  const rows: unknown = Reflect.get(err.payload, "rows");
  return Array.isArray(rows) ? rows.filter(isRowError) : [];
}

function ImportSection({ kind, orgId }: { kind: "customers" | "invoices"; orgId: string }) {
  const queryClient = useQueryClient();
  const inputId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<RowError[]>([]);
  const title = kind === "customers" ? "Customers" : "Invoices";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setStatus(null);
    setError(null);
    setRows([]);
    if (!file) {
      setError(`Choose a ${title.toLowerCase()} CSV file first`);
      return;
    }
    setPending(true);
    try {
      const content = await file.text();
      const result = await api<{ imported: number }>(`${orgPath(orgId)}/imports/${kind}`, {
        text: { content, contentType: "text/csv" },
      });
      setStatus(`Imported ${result.imported} ${kind}`);
      await queryClient.invalidateQueries({ queryKey: ["org", orgId] });
    } catch (err) {
      const message = errorMessage(err);
      setError(
        message.includes("Nothing was imported") ? message : `Nothing was imported: ${message}`,
      );
      setRows(rowErrors(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      noValidate
      onSubmit={(e) => void submit(e)}
      className="flex flex-col gap-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
    >
      <h2 className="text-lg font-semibold">Import {kind}</h2>
      <div className="flex flex-col gap-1">
        <label htmlFor={inputId} className="text-sm font-medium">
          {title} CSV
        </label>
        <input
          id={inputId}
          type="file"
          accept=".csv,text/csv"
          className={inputClass}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </div>
      <ErrorAlert message={error} />
      <StatusMessage message={status} />
      {rows.length > 0 && (
        <DataTable headers={["Row", "Error"]}>
          {rows.flatMap((r) =>
            r.errors.map((message, i) => (
              <tr key={`${r.row}-${i}`}>
                <td className={`${cellClass} tabular-nums`}>{r.row}</td>
                <td className={`${cellClass} break-words`}>{message}</td>
              </tr>
            )),
          )}
        </DataTable>
      )}
      <div>
        <PendingButton type="submit" className={primaryButton} pending={pending}>
          Import {kind}
        </PendingButton>
      </div>
    </form>
  );
}

export function ImportPage() {
  const org = useOrg();
  if (!canWrite(org.role)) {
    return <p className="text-slate-700">Your role does not allow importing data.</p>;
  }
  return (
    <section className="flex flex-col gap-6">
      <ImportSection kind="customers" orgId={org.id} />
      <ImportSection kind="invoices" orgId={org.id} />
    </section>
  );
}
