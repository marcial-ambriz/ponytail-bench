export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
}

function messageFrom(payload: unknown, status: number): string {
  if (payload && typeof payload === "object") {
    if ("error" in payload && typeof payload.error === "string") return payload.error;
    if ("message" in payload && typeof payload.message === "string") return payload.message;
  }
  return `Request failed (${status})`;
}

// oxlint-disable-next-line typescript/no-explicit-any -- JSON from our own API; callers declare the shape.
function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** JSON fetch against the API. Non-2xx responses throw an ApiError carrying the server's message. */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const hasBody = options.body !== undefined;
  const res = await fetch(path, {
    method: options.method ?? (hasBody ? "POST" : "GET"),
    credentials: "include",
    headers: hasBody ? { "content-type": "application/json" } : undefined,
    body: hasBody ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  const payload: T = text ? parseJson(text) : null;
  if (!res.ok) throw new ApiError(res.status, messageFrom(payload, res.status));
  return payload;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong";
}
