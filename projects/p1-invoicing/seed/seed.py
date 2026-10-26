#!/usr/bin/env python3
"""Seed a running Ledgerly instance with deterministic mock data through its public API (stdlib only).

    python3 -I seed/seed.py [web_base_url]        (default: env BASE_URL, else http://localhost:5173)

Used before screenshot capture (project.json visual.seed) and for the UX agent. Works at any checkpoint: a stage whose
endpoints do not exist yet (404/405) is skipped, so the same script seeds a CP1 app and a CP5 app. Prints a JSON
summary (users, organization ids, invoice ids by role in the story) to stdout. Writes nothing to disk.

Story (all amounts in cents; due dates relative to today, UTC):
  Northwind Supplies   owner Olivia, accountant Andre, viewer Vera; 8 customers; invoices issued in this order:
    INV-0001 paid in full (manual), INV-0002 partly paid (manual + PayFlow, one PayFlow refund), INV-0003 45 days
    overdue, INV-0004 100 days overdue, INV-0005 current, INV-0006 void; two drafts.
  Empty Co             owned by Olivia, no data (empty states).
  Nina Newcomer        signed-up user without organizations.
"""

import hashlib
import hmac
import http.cookiejar
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

BASE = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get("BASE_URL", "http://localhost:5173")).rstrip("/")
PASSWORD = "Ledgerly123!"
USERS = {
    "owner": ("Olivia Owner", "owner@ledgerly.test"),
    "accountant": ("Andre Accountant", "accountant@ledgerly.test"),
    "viewer": ("Vera Viewer", "viewer@ledgerly.test"),
    "newcomer": ("Nina Newcomer", "newcomer@ledgerly.test"),
}
TODAY = datetime.now(timezone.utc).date()


def day(offset):
    return (TODAY + timedelta(days=offset)).isoformat()


class Client:
    def __init__(self):
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def req(self, method, path, body=None, raw=None, headers=None):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        h = {"Content-Type": "application/json", "Origin": BASE, **(headers or {})}
        r = urllib.request.Request(BASE + path, data=data, method=method, headers=h)
        try:
            with self.opener.open(r, timeout=30) as resp:
                text = resp.read().decode()
                return resp.status, (json.loads(text) if text and text[0] in "[{" else text)
        except urllib.error.HTTPError as e:
            text = e.read().decode(errors="replace")
            try:
                return e.code, json.loads(text)
            except json.JSONDecodeError:
                return e.code, text[:200]
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            return 0, str(e)


class Skip(Exception):
    pass


def ok(res, *codes):
    status, body = res
    if status in (404, 405) or status == 0:
        raise Skip(f"{status} {str(body)[:120]}")
    if status not in codes:
        raise RuntimeError(f"unexpected {status}: {str(body)[:200]}")
    return body


def account(role):
    name, email = USERS[role]
    c = Client()
    status, _ = c.req("POST", "/api/auth/sign-up/email", {"name": name, "email": email, "password": PASSWORD})
    if status != 200:
        status, body = c.req("POST", "/api/auth/sign-in/email", {"email": email, "password": PASSWORD})
        if status != 200:
            raise RuntimeError(f"cannot sign in {email}: {status} {body}")
    return c


def wait_api(timeout_s=90):
    """The web port can answer before its API proxy target; exit 75 (temporary) if the API never does."""
    t0 = time.time()
    while time.time() - t0 < timeout_s:
        status, _ = Client().req("GET", "/api/auth/get-session")
        if status not in (0, 502, 503, 504):
            return
        time.sleep(1)
    print(f"API at {BASE} not answering after {timeout_s}s", file=sys.stderr)
    sys.exit(75)


def main():
    wait_api()
    summary = {"base": BASE, "password": PASSWORD, "users": {r: u[1] for r, u in USERS.items()}, "skipped": []}
    owner = account("owner")
    members = {r: account(r) for r in ("accountant", "viewer", "newcomer")}

    def stage(name, fn):
        try:
            fn()
        except Skip as e:
            summary["skipped"].append(f"{name}: {e}")

    org = ok(owner.req("POST", "/api/orgs", {"name": "Northwind Supplies"}), 201)
    empty = ok(owner.req("POST", "/api/orgs", {"name": "Empty Co"}), 201)
    oid = org["id"]
    summary["orgs"] = {"main": oid, "empty": empty["id"]}
    base = f"/api/orgs/{oid}"

    def invitations():
        for role in ("accountant", "viewer"):
            inv = ok(owner.req("POST", f"{base}/invitations", {"email": USERS[role][1], "role": role}), 201)
            ok(members[role].req("POST", f"/api/invitations/{inv['token']}/accept"), 200)
        ok(owner.req("POST", f"{base}/invitations", {"email": "pending.partner@ledgerly.test", "role": "viewer"}), 201)

    stage("invitations", invitations)

    customers = {}
    invoices = {}

    def customer_data():
        for name, email in [
            ("Acme Corporation", "billing@acme.test"),
            ("Blue Harbor Cafe", "accounts@blueharbor.test"),
            ("Cedar & Pine Studio", "hello@cedarpine.test"),
            ("Delta Logistics", "ap@deltalogistics.test"),
            ("Evergreen Dental", "office@evergreen.test"),
            ("Foxglove Books", "orders@foxglove.test"),
            ("Granite Peak Gym", "finance@granitepeak.test"),
            ("Harbor View Hotel", "payables@harborview.test"),
        ]:
            customers[name] = ok(owner.req("POST", f"{base}/customers", {"name": name, "email": email}), 201)["id"]

    stage("customers", customer_data)

    def L(desc, qty, cents, bps=1600):
        return {"description": desc, "quantity": qty, "unitPriceCents": cents, "taxRateBps": bps}

    plan = [
        ("paid", "Acme Corporation", 20, [L("Website maintenance (monthly)", 1, 120_000), L("Hosting", 1, 4_999)]),
        ("partial", "Blue Harbor Cafe", 10, [L("Menu design", 1, 85_000), L("Printing", 200, 125, 800)]),
        ("overdue45", "Cedar & Pine Studio", -45, [L("Brand workshop", 2, 65_000)]),
        ("overdue100", "Delta Logistics", -100, [L("Route analysis", 1, 240_000, 0)]),
        ("current", "Evergreen Dental", 25, [L("Patient portal setup", 1, 99_900), L("Training session", 3, 15_000)]),
        ("void", "Foxglove Books", 15, [L("Duplicate order", 1, 30_000)]),
        ("draft", "Granite Peak Gym", 30, [L("Membership app (phase 1)", 1, 450_000), L("Discovery", 4, 12_500)]),
        ("draft2", "Harbor View Hotel", 30, [L("Booking widget", 1, 175_000)]),
    ]

    def invoice_data():
        for key, cust, due, lines in plan:
            if cust not in customers:
                raise Skip("no customers")
            body = {"customerId": customers[cust], "dueDate": day(due), "lines": lines}
            if key == "draft":
                body["notes"] = "Phase 2 will be quoted separately."
            invoices[key] = ok(owner.req("POST", f"{base}/invoices", body), 201)["id"]
        for key in ("paid", "partial", "overdue45", "overdue100", "current", "void"):
            ok(owner.req("POST", f"{base}/invoices/{invoices[key]}/issue"), 200)
        ok(owner.req("POST", f"{base}/invoices/{invoices['void']}/void"), 200)

    stage("invoices", invoice_data)
    summary["invoices"] = invoices

    def payments():
        if "paid" not in invoices:
            raise Skip("no invoices")
        paid = ok(owner.req("GET", f"{base}/invoices/{invoices['paid']}"), 200)
        ok(owner.req("POST", f"{base}/invoices/{invoices['paid']}/payments",
                     {"amountCents": paid["totalCents"], "method": "bank_transfer", "paidAt": day(-2),
                      "reference": "TRX-20931"}), 201)
        ok(members["accountant"].req("POST", f"{base}/invoices/{invoices['partial']}/payments",
                                     {"amountCents": 40_000, "method": "card", "paidAt": day(-1)}), 201)
        ok(owner.req("POST", f"{base}/invoices/{invoices['overdue100']}/payments",
                     {"amountCents": 50_000, "method": "cash", "paidAt": day(-30)}), 201)
        secret = ok(owner.req("GET", f"{base}/settings/webhook"), 200)["secret"]
        hook = Client()

        def deliver(event):
            raw = json.dumps(event, separators=(",", ":")).encode()
            t = int(time.time())
            sig = hmac.new(secret.encode(), f"{t}.".encode() + raw, hashlib.sha256).hexdigest()
            ok(hook.req("POST", f"/api/webhooks/payflow/{oid}", raw=raw, headers={"PayFlow-Signature": f"t={t},v1={sig}"}), 200)

        now = int(time.time())
        data = {"invoiceId": invoices["partial"], "amountCents": 15_000}
        deliver({"id": "evt_seed_0001", "type": "payment.succeeded", "created": now, "data": {**data, "paymentId": "pay_seed_1"}})
        deliver({"id": "evt_seed_0002", "type": "payment.succeeded", "created": now, "data": {**data, "paymentId": "pay_seed_2", "amountCents": 5_000}})
        deliver({"id": "evt_seed_0003", "type": "payment.refunded", "created": now, "data": {**data, "paymentId": "pay_seed_2", "amountCents": 5_000}})

    stage("payments", payments)

    def imports():
        csv = "name,email\nIris Imports,iris@imports.test\n\"Juniper, Kale & Co\",jk@juniper.test\n"
        ok(members["accountant"].req("POST", f"{base}/imports/customers", raw=csv.encode(), headers={"Content-Type": "text/csv"}), 201)

    if os.environ.get("CHECKPOINT", "cp5") >= "cp4":  # imports exist from cp4; earlier apps may answer 403
        stage("imports", imports)
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
