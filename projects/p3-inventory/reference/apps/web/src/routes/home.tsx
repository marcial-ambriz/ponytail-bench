import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { Card, PageHeader } from "@/components/Page.tsx";
import { meQuery } from "@/lib/auth.ts";
import { lowStockQuery, ordersQuery, productsQuery } from "@/lib/inventory.ts";

function Stat({ label, value, to }: { label: string; value: number | undefined; to: string }) {
  return (
    <Card>
      <p className="text-sm text-slate-500">{label}</p>
      <p className="mt-1 text-3xl font-semibold">{value ?? "–"}</p>
      <Link
        to={to}
        className="mt-2 inline-flex min-h-8 items-center text-sm text-indigo-700 underline"
      >
        View
      </Link>
    </Card>
  );
}

export function HomePage() {
  const { data: user } = useSuspenseQuery(meQuery);
  const products = useQuery(productsQuery());
  const orders = useQuery(ordersQuery);
  const alerts = useQuery(lowStockQuery);

  return (
    <div>
      <PageHeader title="Stockly" />
      <p className="mb-6 text-slate-600">Welcome back, {user?.name}.</p>
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Products" value={products.data?.length} to="/products" />
        <Stat
          label="Open orders"
          value={orders.data?.filter((o) => o.status === "reserved").length}
          to="/orders"
        />
        <Stat label="Low-stock products" value={alerts.data?.length} to="/alerts" />
      </div>
    </div>
  );
}
