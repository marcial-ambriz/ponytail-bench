# Feature: first blood per bracket

**Type:** feature request · **Area:** scoring

## Context

This CTF already awards a "first blood" bonus (Admin → Config → First Blood Bonus) to the first team that solves
each challenge. This year we split teams into brackets (e.g. "Students" and "Professionals", Admin → Brackets).
Students complain they never get first blood because professionals are faster.

## Requirements

- **M1** When the bonus is enabled, first blood is decided **per bracket**: for each challenge, the first visible
  team of each bracket to solve it gets the bonus. Teams without a bracket form their own group and also get one
  first blood per challenge among themselves.
- **M2** Each bonus is still a single line item named `First blood: <challenge name>` on the team page and counts in
  the score everywhere, exactly as today.
- **M3** Still exactly one first blood per challenge per bracket when several teams of the same bracket submit the
  correct flag at the same moment.
- **M4** Hidden or banned teams still never take first blood. With no brackets in use, behaviour is unchanged.
