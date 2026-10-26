# Blind code review judge — C3 (economy), C4 (readability), C2 invariant ownership

You review ONE implementation, alias $alias, at checkpoint $cp_id: `$diff_path` (everything the implementer added on
top of the starting scaffold, lockfiles and generated files excluded). Some words were masked as `[x]` / `[run]` for
blinding; ignore that and never try to infer which model or configuration built it. The specification is in
`$spec_dir`. English only. Every implementation targets the same spec and hidden tests, so judge HOW it is built.

## Pass A — C3 Code economy (0–5)
What does not need to exist? One-implementation interfaces, speculative config, unused exports, duplicated logic,
hand-rolled versions of platform/library features already available, layers that only forward calls, dead code.
NOT waste: validation at trust boundaries, transactions, error handling that prevents data loss, accessibility,
anything the spec requires. Diff size is context only: a small diff that skips required behavior is not economical
(cap C3 at 2 if required behavior was skipped to save code). Anchors: 0 pervasive scaffolding · 3 a few deletable
pieces · 5 nothing obviously deletable.

## Pass B — C4 Readability & fit (0–5), separately from A
Naming, function size, control flow, cohesion, consistency with the scaffold's conventions, comments only where they
help. Penalize golfing equally with sprawl. Anchors: 0 cryptic or golfed · 3 uneven · 5 obvious on first read.

## C2 invariant ownership
For each invariant the spec marks as a rule (uniqueness, balances, idempotency, stock, numbering...): enforced by the
DB (constraint / unique index / transaction with proper locking) / app code inside a transaction / app code without
transaction / missing. `c2_cap`: 5 if the DB owns every invariant, 4 if a process-local lock or app-level check is
the only guard of any, 3 if any is unguarded under concurrency.

## Output
Write `$out_path`:
{"alias": "$alias", "cp": "$cp_id", "judge": "$judge", "c3": <0-5>, "c4": <0-5>, "c2_cap": <3|4|5>,
 "c3_deletable": [{"file", "lines", "what", "why"}], "skipped_required": [...], "c4_problems": [{"file", "lines", "what"}],
 "invariants": [{"rule", "owner", "evidence": "file:lines"}], "summary": "<= 3 sentences"}
Cite real paths and line ranges for every claim. Reply with "$alias $cp_id: C3=<n> C4=<n> C2cap=<n>".
