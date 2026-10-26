export const MAX_UNIT_PRICE_CENTS = 100_000_000;
export const MAX_QUANTITY = 1000;
export const MAX_TAX_RATE_BPS = 10_000;

export interface LineInput {
  description: string;
  quantity: number;
  unitPriceCents: number;
  taxRateBps: number;
}

export interface LineAmounts {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}

/** Line amounts in integer cents; tax is rounded half up per line. */
export function lineAmounts(
  line: Pick<LineInput, "quantity" | "unitPriceCents" | "taxRateBps">,
): LineAmounts {
  const subtotalCents = line.quantity * line.unitPriceCents;
  // subtotal <= 1e11 and rate <= 1e4, so the product stays far below 2^53.
  const taxCents = Math.floor((subtotalCents * line.taxRateBps + 5000) / 10_000);
  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}

/** Invoice totals are the sums of the (already rounded) line amounts. */
export function invoiceAmounts(lines: LineAmounts[]): LineAmounts {
  return lines.reduce(
    (acc, l) => ({
      subtotalCents: acc.subtotalCents + l.subtotalCents,
      taxCents: acc.taxCents + l.taxCents,
      totalCents: acc.totalCents + l.totalCents,
    }),
    { subtotalCents: 0, taxCents: 0, totalCents: 0 },
  );
}

/**
 * Parses a plain decimal with at most two decimals ("19.99", "5", "0.5") into hundredths,
 * using string arithmetic only (no floating point). Returns null when the text is not such a decimal.
 */
export function parseHundredths(text: string): number | null {
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  return whole * 100 + fraction;
}

/** Cents as a plain two-decimal string ("1234.50"). */
export function centsToDecimal(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
