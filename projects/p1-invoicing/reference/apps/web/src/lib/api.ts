export class ApiError extends Error {
  readonly status: number;
  /** Parsed error body (may carry extra fields such as import row errors). */
  readonly payload: unknown;

  constructor(status: number, message: string, payload: unknown = null) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /** Sends text as-is (for example a CSV file) instead of JSON. */
  text?: { content: string; contentType: string };
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
  const hasBody = options.body !== undefined || options.text !== undefined;
  const res = await fetch(path, {
    method: options.method ?? (hasBody ? "POST" : "GET"),
    credentials: "include",
    headers: options.text
      ? { "content-type": options.text.contentType }
      : hasBody
        ? { "content-type": "application/json" }
        : undefined,
    body: options.text ? options.text.content : hasBody ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  const payload: T = text ? parseJson(text) : null;
  if (!res.ok) throw new ApiError(res.status, messageFrom(payload, res.status), payload);
  return payload;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong";
}
