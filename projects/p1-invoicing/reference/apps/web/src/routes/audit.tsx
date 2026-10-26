import { useQuery } from "@tanstack/react-query";

import { ErrorAlert } from "@/components/Alert.tsx";
import { cellClass, DataTable, EmptyState } from "@/components/Table.tsx";
import { errorMessage } from "@/lib/api.ts";
import { auditQuery, canWrite } from "@/lib/data.ts";
import { useOrg } from "@/lib/org-context.ts";

const formatTime = (iso: string) => iso.replace("T", " ").slice(0, 19);

export function AuditPage() {
  const org = useOrg();
  const allowed = canWrite(org.role);
  const { data: entries, error, isPending } = useQuery({ ...auditQuery(org.id), enabled: allowed });

  if (!allowed)
    return <p className="text-slate-700">Your role does not allow viewing the audit log.</p>;
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-xl font-semibold">Audit log</h2>
      {error && <ErrorAlert message={errorMessage(error)} />}
      {isPending ? (
        <p className="text-sm text-slate-500">Loading audit log…</p>
      ) : (
        <DataTable
          headers={["Time", "Actor", "Action", "Entity"]}
          empty={
            entries && entries.length === 0 ? (
              <EmptyState>No changes recorded yet</EmptyState>
            ) : null
          }
        >
          {(entries ?? []).map((e) => (
            <tr key={e.id}>
              <td className={`${cellClass} whitespace-nowrap tabular-nums`}>
                {formatTime(e.at)} UTC
              </td>
              <td className={cellClass}>{e.actorName ?? "PayFlow"}</td>
              <td className={`${cellClass} font-mono text-xs`}>{e.action}</td>
              <td className={`${cellClass} break-all text-xs`}>
                {e.entityType} {e.entityId}
              </td>
            </tr>
          ))}
        </DataTable>
      )}
    </section>
  );
}
