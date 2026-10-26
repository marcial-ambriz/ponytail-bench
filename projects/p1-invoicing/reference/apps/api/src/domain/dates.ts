const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export const DAY_MS = 86_400_000;

/** Parses a real calendar date `YYYY-MM-DD` (UTC midnight), or null. */
export function parseDate(value: string): Date | null {
  const m = DATE_RE.exec(value);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value ? d : null;
}

export function isDate(value: string): boolean {
  return parseDate(value) !== null;
}

export function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (both YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  const a = parseDate(from);
  const b = parseDate(to);
  if (!a || !b) throw new Error(`invalid dates ${from} ${to}`);
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}
