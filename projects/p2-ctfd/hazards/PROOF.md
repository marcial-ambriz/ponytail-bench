# Hazard proof (P2)

Every hazard test passes on the reference (`reference/`) and fails on a deliberately unsafe variant. Variants are the
patches in `hazards/proof/` (applied on base + reference overlay), plus the planted base itself. Re-run with:

    python3 -I hazards/proof/prove.py <path-to-a-CTFd-.venv> [variant ...]

(builds each variant under `tmp/`, boots it exactly like `project.json` start, runs the listed hazard ids.)
Concurrency hazards repeat their race 6 times (12 joiners / 6-10 submitters per round) and fail on the first bad round.

| Hazard | Cat. | Sev. | Unsafe variant | Why it is unsafe |
|---|---|---|---|---|
| hz.t1.concurrent_join_password | concurrency | 3 | v_t1_racy_join | original check-then-act seat check |
| hz.t1.concurrent_join_invite | concurrency | 3 | v_t1_racy_join | same, invite-link path |
| hz.t1.concurrent_join_global_size | concurrency | 3 | v_t1_racy_join, planted base | global Team Size is also check-then-act upstream |
| hz.t1.captain_cannot_set_limit | authz | 3 | v_t1_captain_limit | `member_limit` exposed in the captain's "self" schema |
| hz.t1.invalid_limits_rejected | validation | 2 | v_t1_no_validation | no range/type check |
| hz.t1.lowering_limit_keeps_members | data-loss | 2 | v_t1_lower_trims | enforcing a lower limit by kicking members |
| hz.t2.same_member_double_submit | concurrency | 3 | planted base | no DB uniqueness on solves |
| hz.t2.different_teams_all_count | concurrency | 2 | v_t2_overstrict | over-fix: unique on challenge only |
| hz.t3.simultaneous_wrong_never_negative | concurrency | 3 | v_t3_nolock | score read before any write, no account lock |
| hz.t3.simultaneous_identical_wrong_once | idempotency | 3 | v_t3_nolock | duplicate-answer check not serialised |
| hz.t3.invalid_penalty_rejected | validation | 2 | v_t3_no_validation | negative/odd penalties accepted |
| hz.t3.player_cannot_change_penalty | authz | 3 | v_t3_open_patch | challenge PATCH without `@admins_only` |
| hz.t3.penalty_keeps_history | data-loss | 2 | v_t3_mutate_award | penalty folded into an existing award |
| hz.t4.hidden_team_not_exposed | authz | 2 | planted base | hidden team's solve leaks through counts |
| hz.t5.simultaneous_first_solves_one_bonus | concurrency | 3 | v_t5_racy | "nobody solved yet" counted before insert, no lock |
| hz.t5.same_team_race_one_bonus | idempotency | 3 | v_t5_racy_no_unique | same + no solve uniqueness |
| hz.t5.player_cannot_change_bonus | authz | 3 | v_t5_open_configs | configs PATCH without `@admins_only` |
| hz.regression.ctfd_suite | regression | 3 | v_regression | breaks `ordinalize` (7 upstream tests fail) |

Note: an implementation that only reads the score *after* its first write is accidentally serialised by SQLite's
write lock (autoflush), which is why v_t3_nolock reads the score first. The hidden suite cannot tell such code from a
correct one; on PostgreSQL it would race.

## Last proof run (2026-10-25, macOS arm64, gunicorn gthread 1x64)

```
v_t1_racy_join         hz.t1.concurrent_join_password                FAILS (ok)  round 0: 10 simultaneous joins into 3 free seats left 13 members (expected 4)
v_t1_racy_join         hz.t1.concurrent_join_invite                  FAILS (ok)  round 0: invite-link rush left 8 members (expected 3)
v_t1_racy_join         hz.t1.concurrent_join_global_size             FAILS (ok)  round 0: global team size 3 but 13 members after simultaneous joins
v_t1_captain_limit     hz.t1.captain_cannot_set_limit                FAILS (ok)  <Resp 200 '{"success": true, "data": {"country": null, "bracket_id": null, "oauth_id": null, "captain_id": 2, 
v_t1_no_validation     hz.t1.invalid_limits_rejected                 FAILS (ok)  member_limit=0 answered 200, expected 400
v_t1_lower_trims       hz.t1.lowering_limit_keeps_members            FAILS (ok)  lowering the limit removed members
planted_base           hz.t1.concurrent_join_global_size             FAILS (ok)  round 0: global team size 3 but 13 members after simultaneous joins
planted_base           hz.t2.same_member_double_submit               FAILS (ok)  round 0: one player double-submitting produced 4 solves
planted_base           hz.t4.hidden_team_not_exposed                 FAILS (ok)  
v_t2_overstrict        hz.t2.different_teams_all_count               FAILS (ok)  team t-5ea5e2-2 lost its solve ((200, 'already_solved'))
v_t3_nolock            hz.t3.simultaneous_wrong_never_negative       FAILS (ok)  round 0: 8 simultaneous wrong answers (30 pts, penalty 25) left score -25, expected 0
v_t3_nolock            hz.t3.simultaneous_identical_wrong_once       FAILS (ok)  round 1: one wrong answer sent 10x at once cost 20 points, expected 10
v_t3_no_validation     hz.t3.invalid_penalty_rejected                FAILS (ok)  penalty=-1 answered 200, expected 400
v_t3_open_patch        hz.t3.player_cannot_change_penalty            FAILS (ok)  player PATCH challenge answered 200
v_t3_mutate_award      hz.t3.penalty_keeps_history                   FAILS (ok)  penalty altered an award
v_t5_racy              hz.t5.simultaneous_first_solves_one_bonus     FAILS (ok)  round 0: 2 teams got first blood for one challenge
v_t5_racy_no_unique    hz.t5.same_team_race_one_bonus                FAILS (ok)  round 0: 2 bonuses, score 300
v_t5_open_configs      hz.t5.player_cannot_change_bonus              FAILS (ok)  player PATCH configs answered 200
v_regression           hz.regression.ctfd_suite                      FAILS (ok)  7 failed, 667 passed, 802 warnings in 121.45s (0:02:01); failed: ['tests/api/v1/teams/test_scoring.py::test_ap

19/19 hazards fail on their unsafe variant
```
