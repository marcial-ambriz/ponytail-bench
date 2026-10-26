import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { ErrorAlert } from "@/components/Alert.tsx";
import { ConfirmDialog } from "@/components/ConfirmDialog.tsx";
import { TextField } from "@/components/Field.tsx";
import { Loading, PageHeader } from "@/components/Page.tsx";
import { ProductFormDialog } from "@/components/ProductFormDialog.tsx";
import { cellClass, DataTable, EmptyState } from "@/components/Table.tsx";
import { primaryButton, secondaryButton } from "@/components/ui.ts";
import { api, errorMessage } from "@/lib/api.ts";
import { meQuery } from "@/lib/auth.ts";
import { productsQuery, type Product } from "@/lib/inventory.ts";

type DialogState = { kind: "new" } | { kind: "edit" | "delete"; product: Product } | null;

export function ProductsPage() {
  const { data: user } = useSuspenseQuery(meQuery);
  const isAdmin = user?.role === "admin";
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [dialog, setDialog] = useState<DialogState>(null);
  const products = useQuery(productsQuery(search.trim()));

  const headers = ["SKU", "Name", "On hand", "Available"];
  if (isAdmin) headers.push("Actions");

  return (
    <div>
      <PageHeader title="Products">
        {isAdmin && (
          <button
            type="button"
            className={primaryButton}
            onClick={() => setDialog({ kind: "new" })}
          >
            New product
          </button>
        )}
      </PageHeader>
      <div className="mb-4 max-w-sm">
        <TextField
          label="Search"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {products.isPending ? (
        <Loading />
      ) : products.isError ? (
        <ErrorAlert message={errorMessage(products.error)} />
      ) : (
        <DataTable
          headers={headers}
          empty={products.data.length === 0 && <EmptyState>No products found</EmptyState>}
        >
          {products.data.map((p) => (
            <tr key={p.id}>
              <td className={cellClass}>
                <Link
                  to="/products/$productId"
                  params={{ productId: p.id }}
                  className="font-mono font-medium text-indigo-700 underline"
                >
                  {p.sku}
                </Link>
              </td>
              <td className={cellClass}>{p.name}</td>
              <td className={cellClass}>{p.onHand}</td>
              <td className={cellClass}>{p.available}</td>
              {isAdmin && (
                <td className={cellClass}>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className={secondaryButton}
                      onClick={() => setDialog({ kind: "edit", product: p })}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className={secondaryButton}
                      onClick={() => setDialog({ kind: "delete", product: p })}
                    >
                      Delete
                    </button>
                  </div>
                </td>
              )}
            </tr>
          ))}
        </DataTable>
      )}
      {dialog?.kind === "new" && <ProductFormDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === "edit" && (
        <ProductFormDialog product={dialog.product} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "delete" && (
        <ConfirmDialog
          title={`Delete ${dialog.product.name}?`}
          confirmLabel="Confirm delete"
          pendingLabel="Deleting…"
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await api(`/api/products/${dialog.product.id}`, { method: "DELETE" });
            await queryClient.invalidateQueries({ queryKey: ["products"] });
            setDialog(null);
          }}
        >
          This permanently removes {dialog.product.sku} from the catalog.
        </ConfirmDialog>
      )}
    </div>
  );
}
