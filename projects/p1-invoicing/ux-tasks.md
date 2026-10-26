# UX task script (C10 usability), P1 Ledgerly: identical for every run

The exploratory agent runs these against a freshly seeded app (`seed/seed.py`: organization "Northwind Supplies" with
owner `owner@ledgerly.test`, accountant `accountant@ledgerly.test`, viewer `viewer@ledgerly.test`, all with password
`Ledgerly123!`). For each task record: completed (yes / with workaround / no), steps taken (clicks + typed fields),
the reference step count given in brackets, where it hesitated or got stuck, and one screenshot of the end state.
Never read the source code; judge only what a user sees. Sign out between roles.

## CP3 (after payments)

1. As the accountant, add a customer "UX Bakery" (ux@bakery.test). [6]
2. As the accountant, create an invoice for "UX Bakery" due in 30 days with two lines: 3 × "Croissant box" at 12.50
   with 8.25% tax and 1 × "Delivery" at 4.99 with no tax; save it as a draft and read its total. [16]
3. As the accountant, issue that invoice and note its number. [3]
4. As the accountant, record a partial payment of 20.00 by card on it and read the remaining balance. [6]
5. As the accountant, try to record a payment larger than the remaining balance and understand why it fails. [5]
6. As the viewer, find invoice INV-0002 and say how much was paid and whether any payment was refunded. [4]
7. As the owner, invite `ux.helper@ledgerly.test` as a viewer and find the link to send them. [5]

## CP5 (full app)

1–7 above, then:

8. As the owner, find the total amount overdue and the amount more than 90 days overdue. [2]
9. As the accountant, import customers from a CSV file the agent writes itself with one invalid email row; understand
   which row failed, fix the file and import it again. [8]
10. As the owner, find who issued INV-0003 and when (audit log). [3]
11. As the viewer, download the invoices CSV export. [2]
12. Repeat tasks 2 and 4 at 390 px width. [22]

## Heuristic scoring (0 / 3 / 5 each, with one line of evidence)

Visibility of system status · Match with the real world · User control and freedom · Consistency and standards ·
Error prevention · Recognition rather than recall · Flexibility and efficiency · Aesthetic and minimalist design ·
Help users recognize, diagnose and recover from errors · Help and documentation (inline hints only).

Usability rating (0–5) = 60% task results (completion and steps vs. reference) + 40% heuristic mean.
