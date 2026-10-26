import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { errorMessage } from "@/lib/api.ts";
import { meQuery, signOut } from "@/lib/auth.ts";

import { ErrorAlert } from "./Alert.tsx";
import { PendingButton } from "./PendingButton.tsx";

const navClass = "rounded-md px-2 py-1 text-sm font-medium text-slate-700 hover:bg-indigo-50";
const activeProps = { className: "font-semibold text-indigo-700" };

export function AppLayout() {
  const { data: user } = useSuspenseQuery(meQuery);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  const handleSignOut = async () => {
    setSignOutError(null);
    setSigningOut(true);
    try {
      await signOut(queryClient);
      await navigate({ to: "/login" });
    } catch (err) {
      setSignOutError(errorMessage(err));
      setSigningOut(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <Link to="/" className="text-lg font-bold text-indigo-700">
            Stockly
          </Link>
          <nav
            aria-label="Main"
            className="order-last flex w-full flex-wrap gap-1 sm:order-none sm:w-auto sm:flex-1"
          >
            <Link to="/products" className={navClass} activeProps={activeProps}>
              Products
            </Link>
            <Link to="/orders" className={navClass} activeProps={activeProps}>
              Orders
            </Link>
            <Link to="/transfers" className={navClass} activeProps={activeProps}>
              Transfers
            </Link>
            <Link to="/alerts" className={navClass} activeProps={activeProps}>
              Alerts
            </Link>
            {user?.role === "admin" && (
              <>
                <Link to="/warehouses" className={navClass} activeProps={activeProps}>
                  Warehouses
                </Link>
                <Link to="/reports" className={navClass} activeProps={activeProps}>
                  Reports
                </Link>
                <Link to="/users" className={navClass} activeProps={activeProps}>
                  Users
                </Link>
              </>
            )}
          </nav>
          <div className="ml-auto flex items-center gap-3 sm:ml-0">
            <span className="text-sm font-medium text-slate-700">{user?.name}</span>
            <PendingButton
              type="button"
              pending={signingOut}
              onClick={() => void handleSignOut()}
              className="rounded-md border border-slate-300 px-3 py-1 text-sm font-medium hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Sign out
            </PendingButton>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6 sm:py-8">
        {signOutError && (
          <div className="mb-4">
            <ErrorAlert message={`Could not sign out: ${signOutError}`} />
          </div>
        )}
        <Outlet />
      </main>
    </div>
  );
}
