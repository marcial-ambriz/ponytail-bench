import { createApp } from "./app.js";
import { createServices, type Services } from "./services.js";

export interface TestContext {
  services: Services;
  request: (
    path: string,
    init?: { method?: string; body?: unknown; cookie?: string },
  ) => Promise<Response>;
  signUp: (name: string, email: string) => Promise<string>;
}

const ORIGIN = "http://localhost:5173";

export async function createTestContext(now = () => new Date()): Promise<TestContext> {
  const services = await createServices({
    dbPath: ":memory:",
    secret: "test-secret-test-secret-test-secret-1234",
    webPort: 5173,
    now,
  });
  const app = createApp(services);
  const request: TestContext["request"] = (path, init = {}) => {
    const headers: Record<string, string> = { origin: ORIGIN };
    if (init.cookie) headers.cookie = init.cookie;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    return Promise.resolve(
      app.request(`${ORIGIN}${path}`, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      }),
    );
  };
  const signUp: TestContext["signUp"] = async (name, email) => {
    const res = await request("/api/auth/sign-up/email", {
      body: { name, email, password: "Password123!" },
    });
    if (res.status !== 200) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
    return res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
  };
  return { services, request, signUp };
}

// oxlint-disable-next-line typescript/no-explicit-any -- test convenience
export const json = (res: Response): Promise<any> => res.json();
