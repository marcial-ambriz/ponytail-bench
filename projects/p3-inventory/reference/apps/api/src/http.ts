import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";

/** An error that maps directly to an HTTP response with an `{ error }` body. */
export class HttpError extends Error {
  readonly status: ContentfulStatusCode;

  constructor(status: ContentfulStatusCode, message: string) {
    super(message);
    this.status = status;
  }
}

export const badRequest = (message: string) => new HttpError(422, message);
export const notFound = (message = "Not found") => new HttpError(404, message);
export const conflict = (message: string) => new HttpError(409, message);
export const forbidden = (message = "Forbidden") => new HttpError(403, message);
export const unauthorized = (message = "Unauthorized") => new HttpError(401, message);

/** Reads and validates a JSON body, turning any failure into a 422. */
export async function readJson<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest("Request body must be valid JSON");
  }
  return parse(schema, raw);
}

/** Validates a value against a schema, turning the first issue into a 422. */
export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw badRequest(result.error.issues[0]?.message ?? "Invalid request");
  }
  return result.data;
}
