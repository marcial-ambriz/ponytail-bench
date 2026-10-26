import { createApp } from "./app.js";
import { createServices, SEED_ADMIN, type Services } from "./services.js";

export interface TestContext {
  services: Services;
  app: ReturnType<typeof createApp>;
  clock: { now: Date };
  request: (
    path: string,
    init?: { method?: string; body?: unknown; cookie?: string },
  ) => Promise<Response>;
  signUp: (name: string, email: string, password?: string) => Promise<string>;
  signIn: (email: string, password: string) => Promise<string>;
  adminCookie: () => Promise<string>;
}

const ORIGIN = "http://localhost:5173";

function cookieFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

export async function createTestContext(
  now = new Date("2030-01-07T08:00:00.000Z"),
): Promise<TestContext> {
  const clock = { now };
  const services = await createServices({
    dbPath: ":memory:",
    secret: "test-secret-test-secret-test-secret-1234",
    webPort: 5173,
    now: () => clock.now,
  });
  const app = createApp(services);

  const request: TestContext["request"] = (path, init = {}) => {
    const headers: Record<string, string> = { origin: ORIGIN };
    if (init.cookie) headers.cookie = init.cookie;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    return Promise.resolve(
      app.request(`http://localhost:5173${path}`, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      }),
    );
  };

  const signUp: TestContext["signUp"] = async (name, email, password = "Password123!") => {
    const res = await request("/api/auth/sign-up/email", { body: { name, email, password } });
    if (res.status !== 200) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
    return cookieFrom(res);
  };

  const signIn: TestContext["signIn"] = async (email, password) => {
    const res = await request("/api/auth/sign-in/email", { body: { email, password } });
    if (res.status !== 200) throw new Error(`sign-in failed: ${res.status} ${await res.text()}`);
    return cookieFrom(res);
  };

  return {
    services,
    app,
    clock,
    request,
    signUp,
    signIn,
    adminCookie: () => signIn(SEED_ADMIN.email, SEED_ADMIN.password),
  };
}

/** Reads a JSON response body for assertions. */
// oxlint-disable-next-line typescript/no-explicit-any -- test convenience
export const body = (res: Response): Promise<any> => res.json();
