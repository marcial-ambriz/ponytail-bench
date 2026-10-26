# P3 mutations (C6)

Four semantic mutations of the reference server, one protection each. `mN.patch` applies to `reference/` (and to the
dry-run working copy) with `git apply`; for model code the mutation agent applies the same behavior by description.
Every mutant breaks at least one hidden acceptance or hazard test of the reference (checked by `benchctl.py selftest`).

- m1: stock may leave beyond what is available: issues and negative adjustments skip the insufficient-stock check (stock can go below zero or eat reserved units).
- m2: orders reserve without checking availability: an order for more than the available units is accepted.
- m3: admin-only endpoints accept clerks (catalog, warehouse, variant and report routes); only user-role changes stay admin-only.
- m4: low-stock alerts ignore reservations: a variant is compared on stock on hand instead of available units.
