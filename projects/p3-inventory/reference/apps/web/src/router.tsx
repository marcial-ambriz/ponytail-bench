import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";

import { AppLayout } from "./components/AppLayout.tsx";
import { meQuery, type User } from "./lib/auth.ts";
import { AlertsPage } from "./routes/alerts.tsx";
import { HomePage } from "./routes/home.tsx";
import { LoginPage } from "./routes/login.tsx";
import { OrderDetailPage } from "./routes/order-detail.tsx";
import { NewOrderPage } from "./routes/order-new.tsx";
import { OrdersPage } from "./routes/orders.tsx";
import { ProductDetailPage } from "./routes/product-detail.tsx";
import { ProductsPage } from "./routes/products.tsx";
import { RegisterPage } from "./routes/register.tsx";
import { ReportsPage } from "./routes/reports.tsx";
import { TransfersPage } from "./routes/transfers.tsx";
import { UsersPage } from "./routes/users.tsx";
import { WarehousesPage } from "./routes/warehouses.tsx";

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
    // Re-read the session on navigation so role changes apply without signing out.
    const user = await context.queryClient.fetchQuery({ ...meQuery, staleTime: 5_000 });
    if (!user) throw redirect({ to: "/login" });
    return { user };
  },
  component: AppLayout,
});

const adminOnly = ({ context }: { context: { user: User } }) => {
  if (context.user.role !== "admin") throw redirect({ to: "/" });
};

const indexRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/",
  component: HomePage,
});

const productsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/products",
  component: ProductsPage,
});

const productDetailRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/products/$productId",
  component: ProductDetailPage,
});

const ordersRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/orders",
  component: OrdersPage,
});

const orderNewRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/orders/new",
  component: NewOrderPage,
});

const orderDetailRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/orders/$orderId",
  component: OrderDetailPage,
});

const alertsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/alerts",
  component: AlertsPage,
});

const transfersRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/transfers",
  component: TransfersPage,
});

const warehousesRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/warehouses",
  beforeLoad: adminOnly,
  component: WarehousesPage,
});

const reportsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/reports",
  beforeLoad: adminOnly,
  component: ReportsPage,
});

const usersRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/users",
  beforeLoad: adminOnly,
  component: UsersPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  registerRoute,
  authedRoute.addChildren([
    indexRoute,
    productsRoute,
    productDetailRoute,
    ordersRoute,
    orderNewRoute,
    orderDetailRoute,
    alertsRoute,
    transfersRoute,
    warehousesRoute,
    reportsRoute,
    usersRoute,
  ]),
]);

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultNotFoundComponent: () => <p className="p-6">Page not found.</p>,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
