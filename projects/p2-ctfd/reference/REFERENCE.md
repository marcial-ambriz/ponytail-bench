# P2 reference implementation (all five tasks)

Overlay tree: every other file in this folder replaces/adds the same path in the base (`base/ctfd/`).
`REFERENCE.patch` is the same change as a unified diff against the planted base (`git apply` from the base root).
Written without any skill. Highlights:

- t1: `Teams.member_limit` (+ migration), schema validation (admins only, 1..1000, numeric strings), atomic
  `CTFd/utils/teams.join_team()` (single conditional UPDATE + team row lock) used by `/teams/join`, `/teams/invite`
  and the MLC OAuth path; seat usage on team pages; admin form fields.
- t2: Solves uniqueness restored; `ChallengeSolveException` handling restored; admin submission create/patch handle
  duplicates (account-level check + IntegrityError -> 400).
- t3: `Challenges.penalty` (+ migration, schema validation); `BaseChallenge.fail` locks the account row, dedups on
  the same (account, challenge, answer), caps at the uncached current score, records an `Awards` row
  "Penalty: <name>"; penalty shown in challenge window and admin forms.
- t4: `get_solve_counts_for_challenges` joins on `get_model()` again.
- t5: config `first_blood_bonus` (admin Accounts form); `BaseChallenge.solve` locks the challenge row, and the
  earliest visible solve gets an `Awards` row "First blood: <name>" (reuses Configs + Awards, so every score surface
  updates for free).
