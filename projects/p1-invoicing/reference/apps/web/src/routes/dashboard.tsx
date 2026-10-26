import { useQuery } from "@tanstack/react-query";

import { ErrorAlert } from "@/components/Alert.tsx";
import { cellClass, DataTable } from "@/components/Table.tsx";
import { secondaryButton } from "@/components/ui.ts";
import { errorMessage } from "@/lib/api.ts";
import { dashboardQuery, orgPath, type Dashboard } from "@/lib/data.ts";
import { formatCents } from "@/lib/money.ts";
import { useOrg } from "@/lib/org-context.ts";

const BUCKETS: Array<[keyof Dashboard["aging"], string]> = [
  ["currentCents", "Current"],
  ["days1to30Cents", "1-30 days"],
  ["days31to60Cents", "31-60 days"],
  ["days61to90Cents", "61-90 days"],
  ["over90Cents", "Over 90 days"],
];

function Stat({ text }: { text: string }) {
  return (
    <p className="rounded-lg border border-slate-200 bg-white p-4 text-lg font-semibold tabular-nums shadow-sm">
      {text}
    </p>
  );
}

export function DashboardPage() {
  const org = useOrg();
  const { data, error, isPending } = useQuery(dashboardQuery(org.id));

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">Dashboard</h2>
        <a
          href={`${orgPath(org.id)}/exports/invoices.csv`}
          download="invoices.csv"
          className={secondaryButton}
        >
          Export invoices CSV
        </a>
      </div>
      {error && <ErrorAlert message={errorMessage(error)} />}
      {isPending && <p className="text-sm text-slate-500">Loading dashboard…</p>}
      {data && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat text={`Receivable: ${formatCents(data.receivableCents)}`} />
            <Stat text={`Overdue: ${formatCents(data.overdueCents)}`} />
            <Stat text={`Collected this month: ${formatCents(data.collectedCents)}`} />
          </div>
          <div className="flex flex-col gap-3">
            <h3 className="text-lg font-semibold">Aging</h3>
            <DataTable headers={["Bucket", "Amount"]}>
              {BUCKETS.map(([key, label]) => (
                <tr key={key}>
                  <td className={cellClass}>{label}</td>
                  <td className={`${cellClass} tabular-nums`}>{formatCents(data.aging[key])}</td>
                </tr>
              ))}
            </DataTable>
          </div>
        </>
      )}
    </section>
  );
}
