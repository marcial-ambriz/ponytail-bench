import { queryOptions, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { ErrorAlert } from "@/components/Alert.tsx";
import { TextField } from "@/components/Field.tsx";
import { Loading, PageHeader, Section } from "@/components/Page.tsx";
import { SelectField } from "@/components/Select.tsx";
import { cellClass, DataTable, EmptyState } from "@/components/Table.tsx";
import { secondaryButton } from "@/components/ui.ts";
import { api, errorMessage } from "@/lib/api.ts";
import { warehousesQuery } from "@/lib/inventory.ts";

interface Valuation {
  totalValueCents: number;
  rows: {
    variantId: string;
    sku: string;
    productName: string;
    variantName: string;
    onHand: number;
    averageCostCents: number;
    valueCents: number;
  }[];
}

interface MovementReport {
  rows: {
    variantId: string;
    sku: string;
    opening: number;
    received: number;
    shipped: number;
    adjusted: number;
    transferred: number;
    closing: number;
  }[];
}

const usd = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const formatMoney = (cents: number) => `$${usd.format(cents / 100)}`;

const qs = (params: Record<string, string>) => {
  const p = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== ""));
  const s = p.toString();
  return s ? `?${s}` : "";
};

const valuationQuery = (warehouseId: string) =>
  queryOptions({
    queryKey: ["reports", "valuation", warehouseId],
    queryFn: () => api<Valuation>(`/api/reports/valuation${qs({ warehouseId })}`),
  });

const movementReportQuery = (from: string, to: string) =>
  queryOptions({
    queryKey: ["reports", "movements", from, to],
    queryFn: () => api<MovementReport>(`/api/reports/movements${qs({ from, to })}`),
    enabled: Boolean(from && to),
  });

const today = () => new Date().toISOString().slice(0, 10);

export function ReportsPage() {
  const warehouses = useQuery(warehousesQuery);
  const [warehouseId, setWarehouseId] = useState("");
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const valuation = useQuery(valuationQuery(warehouseId));
  const period = useQuery(movementReportQuery(from, to));

  return (
    <div>
      <PageHeader title="Reports" />
      <Section title="Inventory valuation">
        <div className="mb-4 flex flex-wrap items-end gap-4">
          <div className="w-full max-w-xs">
            <SelectField
              label="Warehouse"
              value={warehouseId}
              onChange={(e) => setWarehouseId(e.target.value)}
            >
              <option value="">All warehouses</option>
              {warehouses.data?.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </SelectField>
          </div>
          <a
            className={secondaryButton}
            href={`/api/reports/valuation.csv${qs({ warehouseId })}`}
            download
          >
            Export valuation CSV
          </a>
        </div>
        {valuation.isPending ? (
          <Loading />
        ) : valuation.isError ? (
          <ErrorAlert message={errorMessage(valuation.error)} />
        ) : (
          <>
            <p className="mb-3 text-lg font-semibold">
              Total value: {formatMoney(valuation.data.totalValueCents)}
            </p>
            <DataTable
              headers={["SKU", "Product", "Variant", "On hand", "Average cost", "Value"]}
              empty={valuation.data.rows.length === 0 && <EmptyState>No stock to value</EmptyState>}
            >
              {valuation.data.rows.map((r) => (
                <tr key={r.variantId}>
                  <td className={`${cellClass} font-mono`}>{r.sku}</td>
                  <td className={cellClass}>{r.productName}</td>
                  <td className={cellClass}>{r.variantName}</td>
                  <td className={cellClass}>{r.onHand}</td>
                  <td className={cellClass}>{formatMoney(r.averageCostCents)}</td>
                  <td className={cellClass}>{formatMoney(r.valueCents)}</td>
                </tr>
              ))}
            </DataTable>
          </>
        )}
      </Section>

      <Section title="Movements by period">
        <div className="mb-4 flex flex-wrap items-end gap-4">
          <TextField
            label="From"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
          <TextField label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          <a
            className={secondaryButton}
            href={`/api/reports/movements.csv${qs({ from, to })}`}
            download
          >
            Export movements CSV
          </a>
        </div>
        {period.isPending ? (
          <Loading />
        ) : period.isError ? (
          <ErrorAlert message={errorMessage(period.error)} />
        ) : (
          <DataTable
            headers={[
              "SKU",
              "Opening",
              "Received",
              "Shipped",
              "Adjusted",
              "Transferred",
              "Closing",
            ]}
            empty={
              period.data.rows.length === 0 && <EmptyState>No data for this period</EmptyState>
            }
          >
            {period.data.rows.map((r) => (
              <tr key={r.variantId}>
                <td className={`${cellClass} font-mono`}>{r.sku}</td>
                <td className={cellClass}>{r.opening}</td>
                <td className={cellClass}>{r.received}</td>
                <td className={cellClass}>{r.shipped}</td>
                <td className={cellClass}>{r.adjusted}</td>
                <td className={cellClass}>{r.transferred}</td>
                <td className={cellClass}>{r.closing}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </Section>
    </div>
  );
}
