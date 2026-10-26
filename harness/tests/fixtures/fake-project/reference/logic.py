import sqlite3


def connect(path):
    db = sqlite3.connect(path, timeout=30, isolation_level=None)
    db.execute("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, qty INTEGER NOT NULL)")
    return db


def validate_item(d):
    if not isinstance(d, dict) or not isinstance(d.get("name"), str) or not d["name"]:
        return "name required"
    q = d.get("qty")
    if not isinstance(q, int) or isinstance(q, bool) or q <= 0:
        return "qty must be a positive integer"
    return None


def take(db, item_id, qty):
    db.execute("BEGIN IMMEDIATE")
    try:
        row = db.execute("SELECT qty FROM items WHERE id = ?", (item_id,)).fetchone()
        if row is None:
            return 404
        if row[0] < qty:
            return 409
        db.execute("UPDATE items SET qty = qty - ? WHERE id = ?", (qty, item_id))
        return 200
    finally:
        db.execute("COMMIT")
