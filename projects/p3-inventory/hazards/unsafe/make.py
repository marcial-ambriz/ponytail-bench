#!/usr/bin/env python3
"""Regenerates hazards/unsafe/uNN-*.patch: deliberately unsafe variants of reference/ used by hazards/prove.sh.

Each variant removes or weakens ONE protection the spec asks for. Run from anywhere: python3 hazards/unsafe/make.py
(needs git). The patches apply to reference/ with `git apply` (paths relative to reference/).
"""
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REF = HERE.parent.parent / "reference"
API = "apps/api/src"

RACY_HELPERS = '''
/** UNSAFE (hazard proof only): check-then-act across an await, writing absolute values from a stale read. */
export const pause = () => new Promise((resolve) => setTimeout(resolve, 25));

export async function applyMovementRacy(db: DB, input: MovementInput): Promise<string> {
  const variant = findVariant(db, input.variantId);
  if (!variant) throw notFound("Variant not found");
  const stock = stockRow(db, input.variantId, input.warehouseId);
  if (input.type !== "shipment" && input.quantity < 0 && -input.quantity > stock.on_hand - stock.reserved) {
    throw conflict("Insufficient stock");
  }
  await pause();
  const onHand = stock.on_hand + input.quantity;
  const reserved = input.type === "shipment" ? stock.reserved + input.quantity : stock.reserved;
  writeStock(db, input.variantId, input.warehouseId, { on_hand: onHand, reserved });
  const id = randomUUID();
  db.prepare(
    `INSERT INTO movement (id, product_id, variant_id, warehouse_id, type, quantity, unit_cost_cents, reason,
                           order_id, transfer_id, balance_after, user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, variant.product_id, input.variantId, input.warehouseId, input.type, input.quantity,
    input.unitCostCents, input.reason, input.orderId, input.transferId, onHand, input.userId, input.at);
  return id;
}

export async function reserveRacy(db: DB, variantId: string, warehouseId: string, quantity: number): Promise<void> {
  const stock = stockRow(db, variantId, warehouseId);
  if (quantity > stock.on_hand - stock.reserved) throw conflict("Insufficient stock");
  await pause();
  writeStock(db, variantId, warehouseId, { ...stock, reserved: stock.reserved + quantity });
}
'''


def sub(text, old, new, count=1):
    if text.count(old) < 1:
        raise SystemExit(f"pattern not found: {old[:80]!r}")
    return text.replace(old, new, count)


def edit(root, rel, *pairs):
    p = root / rel
    s = p.read_text()
    for old, new in pairs:
        s = sub(s, old, new)
    p.write_text(s)


def add_helpers(root):
    p = root / API / "domain/inventory.py"
    p = root / API / "domain/inventory.ts"
    p.write_text(p.read_text() + RACY_HELPERS)


SHIP_BODY = '''      for (const line of orderLines(db, id)) {
        applyMovement(db, {
          variantId: line.variant_id,
          warehouseId: warehouse_id,
          type: "shipment",
          quantity: -line.quantity,
          unitCostCents: null,
          reason: null,
          orderId: id,
          transferId: null,
          userId,
          at,
        });
      }
      setStatus(id, "shipped");
    }).immediate();'''


def u01(root):  # racy movements
    add_helpers(root)
    edit(root, f"{API}/routes/products.py".replace(".py", ".ts"),
         ("    const id = db\n      .transaction(() =>\n        applyMovement(db, {", "    const id = await (() =>\n        applyMovementRacy(db, {"),
         ("        }),\n      )\n      .immediate();\n    return c.json(loadMovement(db, id), 201);",
          "        }))();\n    return c.json(loadMovement(db, id), 201);"),
         ("import {\n  applyMovement,", "import {\n  applyMovementRacy,\n  applyMovement,"))


def u02(root):  # racy reservations
    add_helpers(root)
    edit(root, f"{API}/routes/orders.ts",
         ("    db.transaction(() => {\n      db.prepare(\n        \"INSERT INTO sales_order",
          "    await (async () => {\n      db.prepare(\n        \"INSERT INTO sales_order"),
         ("      lines.forEach((line, index) => {\n        reserve(db, line.variantId, warehouse.id, line.quantity);",
          "      for (const [index, line] of lines.entries()) {\n        await reserveRacy(db, line.variantId, warehouse.id, line.quantity);"),
         (", line.productId, line.variantId, line.quantity);\n      });\n    }).immediate();",
          ", line.productId, line.variantId, line.quantity);\n      }\n    })();"),
         ("  reserve,\n", "  reserve,\n  reserveRacy,\n"))


def u03(root):  # racy ship / cancel
    add_helpers(root)
    edit(root, f"{API}/routes/orders.ts",
         ('  app.post("/:id/ship", (c) => {', '  app.post("/:id/ship", async (c) => {'),
         ("    db.transaction(() => {\n      const { status, warehouse_id } = stateOf(id);\n      if (status !== \"reserved\") {",
          "    await (async () => {\n      const { status, warehouse_id } = stateOf(id);\n      if (status !== \"reserved\") {"),
         ("      const at = services.now().toISOString();\n      for (const line", "      await pause();\n      const at = services.now().toISOString();\n      for (const line"),
         ("      setStatus(id, \"shipped\");\n    }).immediate();", "      setStatus(id, \"shipped\");\n    })();"),
         ('  app.post("/:id/cancel", (c) => {', '  app.post("/:id/cancel", async (c) => {'),
         ("    db.transaction(() => {\n      const { status, warehouse_id } = stateOf(id);\n      if (status === \"cancelled\") return;",
          "    await (async () => {\n      const { status, warehouse_id } = stateOf(id);\n      if (status === \"cancelled\") return;\n      await pause();"),
         ("      setStatus(id, \"cancelled\");\n    }).immediate();", "      setStatus(id, \"cancelled\");\n    })();"),
         ("        applyMovement(db, {\n          variantId: line.variant_id,", "        await applyMovementRacy(db, {\n          variantId: line.variant_id,"),
         ("  reserve,\n", "  reserve,\n  pause,\n  applyMovementRacy,\n"))


def u04(root):  # order reservation not atomic (no transaction)
    edit(root, f"{API}/routes/orders.ts",
         ("    db.transaction(() => {\n      db.prepare(\n        \"INSERT INTO sales_order", "    (() => {\n      db.prepare(\n        \"INSERT INTO sales_order"),
         (", line.productId, line.variantId, line.quantity);\n      });\n    }).immediate();", ", line.productId, line.variantId, line.quantity);\n      });\n    })();"))


def u05(root):  # racy transfers
    add_helpers(root)
    edit(root, f"{API}/routes/transfers.ts",
         ("    db.transaction(() => {\n      db.prepare(\n        \"INSERT INTO transfer", "    await (async () => {\n      db.prepare(\n        \"INSERT INTO transfer"),
         ("      applyMovement(db, {\n        ...common,\n        warehouseId: body.fromWarehouseId,",
          "      await applyMovementRacy(db, {\n        ...common,\n        warehouseId: body.fromWarehouseId,"),
         ("      applyMovement(db, {\n        ...common,\n        warehouseId: body.toWarehouseId,",
          "      await applyMovementRacy(db, {\n        ...common,\n        warehouseId: body.toWarehouseId,"),
         ("        quantity: body.quantity,\n      });\n    }).immediate();", "        quantity: body.quantity,\n      });\n    })();"),
         ("import { applyMovement, findVariant, findWarehouse }", "import { applyMovementRacy, findVariant, findWarehouse }"))


def u06(root):  # transfer not atomic, destination not validated
    edit(root, f"{API}/routes/transfers.ts",
         ("    for (const id of [body.fromWarehouseId, body.toWarehouseId]) {", "    for (const id of [body.fromWarehouseId]) {"),
         ("    db.transaction(() => {\n      db.prepare(\n        \"INSERT INTO transfer", "    (() => {\n      db.pragma(\"foreign_keys = OFF\");\n      db.prepare(\n        \"INSERT INTO transfer"),
         ("        warehouseId: body.fromWarehouseId,\n        type: \"transfer_out\",\n        quantity: -body.quantity,\n      });",
          "        warehouseId: body.fromWarehouseId,\n        type: \"transfer_out\",\n        quantity: -body.quantity,\n      });\n      db.pragma(\"foreign_keys = ON\");"),
         ("        quantity: body.quantity,\n      });\n    }).immediate();", "        quantity: body.quantity,\n      });\n    })();"))


def u07(root):  # no admin guard
    edit(root, f"{API}/session.ts",
         ('  if (c.get("user").role !== "admin") throw forbidden();\n', ""),
         ('import { forbidden, unauthorized } from "./http.js";', 'import { unauthorized } from "./http.js";'))
    edit(root, f"{API}/routes/products.ts",
         ('    if (body.type === "adjustment" && user.role !== "admin") {\n      throw forbidden("Only admins can record adjustments");\n    }\n', ""),
         ("import { badRequest, conflict, forbidden, readJson }", "import { badRequest, conflict, readJson }"))


def u08(root):  # lax quantity validation (coerced, no integer/range checks)
    edit(root, f"{API}/domain/validation.ts",
         ("export const quantitySchema = z\n  .number(", "export const quantitySchema = z.coerce.number();\nconst strictQuantitySchema = z\n  .number("),
         ("export const signedQuantitySchema = z\n  .number(", "export const signedQuantitySchema = z.coerce.number();\nconst strictSigned = z\n  .number("),
         ("export const unitCostSchema = z\n  .number(", "export const unitCostSchema = z.coerce.number();\nexport const strictUnitCost = z\n  .number("))
    p = root / API / "domain/validation.ts"
    p.write_text(p.read_text() + "\nexport const unusedStrict = [strictQuantitySchema, strictSigned];\n")


def u09(root):  # movements can be deleted
    edit(root, f"{API}/routes/products.ts",
         ('  app.get("/:id/movements", (c) => {', '''  app.delete("/:id/movements/:movementId", requireAdmin, (c) => {
    const m = loadMovement(db, c.req.param("movementId"));
    db.prepare("UPDATE stock SET on_hand = on_hand - ? WHERE variant_id = ? AND warehouse_id = ?").run(
      m.quantity,
      m.variantId,
      m.warehouseId,
    );
    db.prepare("DELETE FROM movement WHERE id = ?").run(m.id);
    return c.json({ ok: true });
  });

  app.get("/:id/movements", (c) => {'''))


def u10(root):  # racy variant SKU uniqueness, no unique index
    add_helpers(root)
    edit(root, f"{API}/db.ts",
         ("      product_id TEXT NOT NULL REFERENCES product(id),\n      sku TEXT NOT NULL UNIQUE COLLATE NOCASE,",
          "      product_id TEXT NOT NULL REFERENCES product(id),\n      sku TEXT NOT NULL COLLATE NOCASE,"))
    edit(root, f"{API}/routes/products.ts",
         ("    const id = db\n      .transaction(() => {\n        if (skuTaken(db, body.sku)) throw conflict(`SKU ${body.sku} already exists`);\n        return insertVariant(",
          "    const id = await (async () => {\n        if (skuTaken(db, body.sku)) throw conflict(`SKU ${body.sku} already exists`);\n        await pause();\n        return insertVariant("),
         ("          at: services.now().toISOString(),\n        });\n      })\n      .immediate();\n    return c.json(variantView(db, id), 201);",
          "          at: services.now().toISOString(),\n        });\n      })();\n    return c.json(variantView(db, id), 201);"),
         ("  loadProductRow,\n", "  loadProductRow,\n  pause,\n"))


def u11(root):  # lossy migration: adjustments are not carried over
    edit(root, f"{API}/db.ts",
         ("      FROM movement m JOIN variant v ON v.product_id = m.product_id AND v.position = 0;",
          "      FROM movement m JOIN variant v ON v.product_id = m.product_id AND v.position = 0\n      WHERE m.type <> 'adjustment';"))


VARIANTS = {
    "u01-racy-movements": u01,
    "u02-racy-reservations": u02,
    "u03-racy-ship-cancel": u03,
    "u04-order-not-atomic": u04,
    "u05-racy-transfers": u05,
    "u06-transfer-not-atomic": u06,
    "u07-no-admin-guard": u07,
    "u08-lax-quantities": u08,
    "u09-deletable-movements": u09,
    "u10-racy-variant-sku": u10,
    "u11-lossy-migration": u11,
}


def main():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "ref"
        shutil.copytree(REF / "apps/api/src", root / API)
        g = ["git", "-C", str(root)]
        subprocess.run([*g, "init", "-q"], check=True)
        subprocess.run([*g, "add", "-A"], check=True)
        subprocess.run([*g, "-c", "user.email=x@x", "-c", "user.name=x", "commit", "-qm", "ref"], check=True)
        for f in HERE.glob("u*.patch"):
            f.unlink()
        for name, fn in VARIANTS.items():
            fn(root)
            diff = subprocess.run([*g, "diff"], capture_output=True, text=True, check=True).stdout
            (HERE / f"{name}.patch").write_text(diff)
            subprocess.run([*g, "checkout", "-q", "--", "."], check=True)
            print(f"{name}.patch ({len(diff.splitlines())} lines)")


if __name__ == "__main__":
    sys.exit(main())
