# P1 mutations (C6)

Predefined semantic mutations of the reference server (`git apply` from the reference/working-copy root). For a model's
run they are applied by behavior, not by line (see harness `prompts/mutation-agent.md`): find the code that enforces
the rule and make the equivalent minimal change. Each one breaks at least one hidden acceptance or hazard test on the
reference (verified; see the bottom of this file).

- m1: Tax rounding: line tax is truncated (rounded down) instead of rounded half up per line (R2.7).
- m2: Webhook idempotency: an already processed event id is no longer recognized, so a reused event id with different content is accepted instead of 409 (R3.12).
- m3: Overpayment guard: a payment larger than the invoice balance is accepted, so the balance can go negative (R3.1, R3.4).
- m4: Tenant isolation: invoices are looked up by id without restricting them to the caller's organization (R1.1).

## Verification against the reference

| Mutant | Hidden tests that fail on the reference |
|---|---|
| m1 | 5: cp2.06, cp2.09, cp2.26, cp4.03, cp4.24 |
| m2 | 2: cp3.33, hz3.03 |
| m3 | 8: cp3.02, cp3.21, cp3.29, cp3.40, cp4.29, hz3.10, hz3.11, hz3.12 |
| m4 | 5: cp2.16, cp2.34, cp3.29, hz2.01, hz3.07 |

Verified 2026-10-25: reference + `git apply mN.patch`, fresh DB, full `acceptance/run.sh cp5` + `hazards/run.sh cp5`.
