# UX task script (C10 usability), P3 Stockly: identical for every run

The exploratory agent runs these against a freshly seeded app (`seed/seed.mjs`, default stage: products HW-BOLT,
HW-WASH, HW-TIE, HW-LBL, HW-GONE; an open order for "Northwind DEMO"; users `admin@stockly.test` / `Admin1234!`,
clerk `clerk@stockly.test` / `Clerk-pass-123`, admin `manager@stockly.test` / `Manager-pass-123`). For each task
record: completed (yes / with workaround / no), steps taken (clicks + typed fields), the reference step count given
in brackets, where it hesitated or got stuck, and one screenshot of the end state. Never read the source code; judge
only what a user sees. Sign out between roles.

## CP3 (after orders and alerts)

1. As the admin, add a product "UX-PEN" named "Ballpoint pen" with reorder point 10. [6]
2. As the clerk, receive 25 "UX-PEN" at 0.40 each and read the stock on hand. [6]
3. As the clerk, try to issue 30 "UX-PEN" and understand why it fails; then issue 5. [7]
4. As the clerk, place an order for "UX Stationery" with 12 "UX-PEN" and 3 "HW-BOLT"; read its status. [9]
5. As the clerk, find which products are low on stock and say how many "HW-TIE" are available. [2]
6. As the admin, ship the "Northwind DEMO" order and confirm the stock of "HW-BOLT" went down. [5]
7. As the admin, make the clerk an admin and then a clerk again. [4]

## CP5 (full app)

1–7 above, then:

8. As the admin, add a variant "UX-PEN-RED" ("Red") to "Ballpoint pen" and receive 10 of it into "East depot". [10]
9. As the clerk, move 5 "HW-BOLT" from "Main warehouse" to "East depot" and find the transfer in the history. [7]
10. As the admin, read the total inventory value and the value held in "East depot". [3]
11. As the admin, find how many "HW-BOLT" were shipped today and download the movements CSV. [4]
12. Repeat tasks 2 and 9 at 390 px width. [13]
