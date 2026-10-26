# CP1 Items
R1.1 POST /items {name, qty} creates an item (201, returns id). R1.2 GET /items lists items.
R1.3 qty must be a positive integer, else 422. R1.4 GET / renders an HTML list ("No items" when empty).
