# P2 mutations (C6)

Each patch applies to the reference tree (planted base + reference overlay) with `git apply`. In agent mode the
mutation agent applies the same *behavior* to the run's own code.

- m1: per-team member limit ignored on join (only the global team size is enforced).
- m2: database uniqueness of solves removed (one challenge can be solved twice by the same team/user).
- m3: wrong-answer penalty no longer capped at the team's current score (score can go negative).
- m4: challenge solve counts exclude hidden/banned users instead of hidden/banned teams (teams mode counts hidden teams).
