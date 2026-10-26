# UX tasks — P2 (CTFd)

Seeded by `seed/seed.py`. Logins: admin `bench-admin` / `bench-admin-pass-123`; players (password
`player-pass-123`): `alice` (captain of NullPointers), `bob`, `dave` (no team).

1. As admin, give the team "NullPointers" its own member limit of 4 from its admin page, then confirm the team page
   shows how many seats are used.
2. As `dave`, try to join "NullPointers" with a wrong password, then with `teampass`. Is the outcome clear both times?
3. As admin, set a wrong-answer penalty of 15 on "Cookie Monster". As `alice`, open that challenge: can you tell
   before submitting that wrong answers cost points? Submit a wrong flag and find where the deduction is shown.
4. As `alice`, compare the solve counts on the challenge board with the solver list of "Warmup".
5. As admin, turn on a first-blood bonus of 25. As `bob`, solve "Lost in Logs" if nobody has, and check the team
   page and scoreboard for the bonus.

Report for each task: completed (yes/no), steps taken, confusion points, and any error you hit.
