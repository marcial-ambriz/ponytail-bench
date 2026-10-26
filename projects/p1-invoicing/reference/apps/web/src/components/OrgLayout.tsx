import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useParams } from "@tanstack/react-router";

import { ApiError, errorMessage } from "@/lib/api.ts";
import { canWrite, orgQuery, ROLE_OPTIONS } from "@/lib/data.ts";
import { OrgContext } from "@/lib/org-context.ts";

import { ErrorAlert } from "./Alert.tsx";

const navClass = "rounded-md px-3 py-2 text-sm font-medium text-slate-700 hover:bg-indigo-50";
const activeProps = { className: "bg-indigo-50 font-semibold text-indigo-700" };

export function OrgLayout() {
  const orgId = useParams({ strict: false }).orgId ?? "";
  const { data: org, error, isPending } = useQuery(orgQuery(orgId));

  if (isPending) return <p className="text-sm text-slate-500">Loading organization…</p>;
  if (error || !org) {
    const notFound = error instanceof ApiError && error.status === 404;
    return (
      <section className="flex flex-col gap-4">
        {notFound ? (
          <p className="rounded-lg border border-slate-200 bg-white p-6 text-slate-700">
            Organization not found
          </p>
        ) : (
          <ErrorAlert message={errorMessage(error)} />
        )}
        <Link
          to="/"
          className="inline-flex min-h-6 items-center self-start text-sm text-indigo-700 underline"
        >
          All organizations
        </Link>
      </section>
    );
  }

  const writer = canWrite(org.role);
  const roleLabel = ROLE_OPTIONS.find((r) => r.value === org.role)?.label ?? org.role;

  return (
    <OrgContext.Provider value={org}>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <Link
            to="/"
            className="inline-flex min-h-6 items-center self-start text-sm text-indigo-700 underline"
          >
            All organizations
          </Link>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="text-2xl font-bold break-words">{org.name}</h1>
            <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-700">
              {roleLabel}
            </span>
          </div>
          <nav
            aria-label="Organization"
            className="flex flex-wrap gap-1 border-b border-slate-200 pb-2"
          >
            <Link
              to="/orgs/$orgId"
              params={{ orgId }}
              className={navClass}
              activeProps={activeProps}
              activeOptions={{ exact: true }}
            >
              Dashboard
            </Link>
            <Link
              to="/orgs/$orgId/customers"
              params={{ orgId }}
              className={navClass}
              activeProps={activeProps}
            >
              Customers
            </Link>
            <Link
              to="/orgs/$orgId/invoices"
              params={{ orgId }}
              className={navClass}
              activeProps={activeProps}
            >
              Invoices
            </Link>
            {writer && (
              <Link
                to="/orgs/$orgId/import"
                params={{ orgId }}
                className={navClass}
                activeProps={activeProps}
              >
                Import
              </Link>
            )}
            {writer && (
              <Link
                to="/orgs/$orgId/audit"
                params={{ orgId }}
                className={navClass}
                activeProps={activeProps}
              >
                Audit log
              </Link>
            )}
            <Link
              to="/orgs/$orgId/members"
              params={{ orgId }}
              className={navClass}
              activeProps={activeProps}
            >
              Members
            </Link>
            {org.role === "owner" && (
              <Link
                to="/orgs/$orgId/settings"
                params={{ orgId }}
                className={navClass}
                activeProps={activeProps}
              >
                Settings
              </Link>
            )}
          </nav>
        </div>
        <Outlet />
      </div>
    </OrgContext.Provider>
  );
}
