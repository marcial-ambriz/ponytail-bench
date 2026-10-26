const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** Formats integer cents as "$1,234.56" (integer division keeps it exact). */
export function formatCents(cents: number): string {
  return usd.format(cents / 100);
}

/**
 * Parses a plain decimal with at most two decimals ("19.99", "5", "0.5") into hundredths
 * using string arithmetic only, so 19.99 becomes exactly 1999. Returns null when invalid.
 */
export function parseHundredths(text: string): number | null {
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

/** Cents back into an editable decimal string ("19.99", "5.00"). */
export function centsToInput(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** Basis points into an editable percentage ("16", "8.25"). */
export function bpsToInput(bps: number): string {
  const whole = Math.floor(bps / 100);
  const frac = bps % 100;
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}`;
}

export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}
