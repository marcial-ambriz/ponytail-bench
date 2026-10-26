import { z } from "zod";

export const MAX_QUANTITY = 1_000_000;
export const MAX_UNIT_COST_CENTS = 100_000_000;

export const idSchema = z
  .union([z.string().min(1), z.number().int()], { error: "Id must be a string" })
  .transform(String);

export const skuSchema = z
  .string({ error: "SKU is required" })
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9-]{3,32}$/, "SKU must be 3-32 characters using A-Z, 0-9 or -");

export const productNameSchema = z
  .string({ error: "Name is required" })
  .trim()
  .min(2, "Name must be 2-80 characters")
  .max(80, "Name must be 2-80 characters");

export const descriptionSchema = z
  .string({ error: "Description must be text" })
  .max(500, "Description must be at most 500 characters")
  .nullable()
  .optional();

export const reorderPointSchema = z
  .number({ error: "Reorder point must be a whole number" })
  .int("Reorder point must be a whole number")
  .min(0, "Reorder point must be 0 or more")
  .max(MAX_QUANTITY, "Reorder point must be at most 1,000,000");

export const quantitySchema = z
  .number({ error: "Quantity must be a whole number" })
  .int("Quantity must be a whole number")
  .min(1, "Quantity must be at least 1")
  .max(MAX_QUANTITY, "Quantity must be at most 1,000,000");

export const signedQuantitySchema = z
  .number({ error: "Quantity must be a whole number" })
  .int("Quantity must be a whole number")
  .min(-MAX_QUANTITY, "Quantity must be between -1,000,000 and 1,000,000")
  .max(MAX_QUANTITY, "Quantity must be between -1,000,000 and 1,000,000")
  .refine((n) => n !== 0, "Quantity must not be zero");

export const unitCostSchema = z
  .number({ error: "Unit cost is required (integer cents)" })
  .int("Unit cost must be whole cents")
  .min(0, "Unit cost must be 0 or more")
  .max(MAX_UNIT_COST_CENTS, "Unit cost is too large");

export const variantNameSchema = z
  .string({ error: "Variant name is required" })
  .trim()
  .min(1, "Variant name must be 1-60 characters")
  .max(60, "Variant name must be 1-60 characters");

export const warehouseCodeSchema = z
  .string({ error: "Code is required" })
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{2,10}$/, "Code must be 2-10 characters using A-Z or 0-9");

export const warehouseNameSchema = z
  .string({ error: "Name is required" })
  .trim()
  .min(2, "Name must be 2-60 characters")
  .max(60, "Name must be 2-60 characters");
