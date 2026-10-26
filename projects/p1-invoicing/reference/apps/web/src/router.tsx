import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";

import { AppLayout } from "./components/AppLayout.tsx";
import { OrgLayout } from "./components/OrgLayout.tsx";
import { meQuery } from "./lib/auth.ts";
import { AuditPage } from "./routes/audit.tsx";
import { CustomersPage } from "./routes/customers.tsx";
import { DashboardPage } from "./routes/dashboard.tsx";
import { HomePage } from "./routes/home.tsx";
import { ImportPage } from "./routes/import.tsx";
import { InvitationPage } from "./routes/invitation.tsx";
import { InvoiceDetailPage } from "./routes/invoice-detail.tsx";
import { EditInvoicePage, NewInvoicePage } from "./routes/invoice-form.tsx";
import { InvoicesPage } from "./routes/invoices.tsx";
import { LoginPage } from "./routes/login.tsx";
import { MembersPage } from "./routes/members.tsx";
import { RegisterPage } from "./routes/register.tsx";
import { SettingsPage } from "./routes/settings.tsx";

interface RouterContext {
  queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />,
});

const guestOnly = async ({ context }: { context: RouterContext }) => {
  const user = await context.queryClient.ensureQueryData(meQuery);
  if (user) throw redirect({ to: "/" });
};

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  beforeLoad: guestOnly,
  component: LoginPage,
});

const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/register",
  beforeLoad: guestOnly,
  component: RegisterPage,
});

const authedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "authed",
  beforeLoad: async ({ context }) => {
    const user = await context.queryClient.ensureQueryData(meQuery);
    if (!user) throw redirect({ to: "/login" });
    return { user };
  },
  component: AppLayout,
});

const indexRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/",
  component: HomePage,
});

const invitationRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/invitations/$token",
  component: InvitationPage,
});

const orgRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/orgs/$orgId",
  component: OrgLayout,
});

const orgDashboardRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/",
  component: DashboardPage,
});
const customersRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/customers",
  component: CustomersPage,
});
const invoicesRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/invoices",
  component: InvoicesPage,
});
const newInvoiceRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/invoices/new",
  component: NewInvoicePage,
});
const invoiceRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/invoices/$invoiceId",
  component: InvoiceDetailPage,
});
const editInvoiceRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/invoices/$invoiceId/edit",
  component: EditInvoicePage,
});
const membersRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/members",
  component: MembersPage,
});
const settingsRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/settings",
  component: SettingsPage,
});
const importRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/import",
  component: ImportPage,
});
const auditRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/audit",
  component: AuditPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  registerRoute,
  authedRoute.addChildren([
    indexRoute,
    invitationRoute,
    orgRoute.addChildren([
      orgDashboardRoute,
      customersRoute,
      invoicesRoute,
      newInvoiceRoute,
      invoiceRoute,
      editInvoiceRoute,
      membersRoute,
      settingsRoute,
      importRoute,
      auditRoute,
    ]),
  ]),
]);

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultNotFoundComponent: () => <p>Page not found.</p>,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
