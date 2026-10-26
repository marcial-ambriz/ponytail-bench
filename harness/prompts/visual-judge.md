# Blind visual judge — C10 visual (absolute scale, one checkpoint)

You rate the rendered UI of ONE implementation, alias $alias, at checkpoint $cp_id. Screenshots (desktop 1280 and
mobile 390) are in `$shots_dir`; their list and what each screen should show is `$index_path`. Rate against the
FIXED anchor screenshots in `$anchors_dir` (0.png = score 0, 3.png = score 3, 5.png = score 5; the same anchors are
used for every run of this project). Never compare against other runs. Only screens of checkpoints implemented so far
are included. Grade the rendered result only: visual hierarchy, consistency, spacing, legibility, responsive layout,
feedback states (empty / error / loading), clarity of destructive actions. Do not reward heavy UI kits or decoration
for its own sake. English only.

Write `$out_path`: {"alias": "$alias", "cp": "$cp_id", "judge": "$judge", "score": <0-5, one decimal>,
"per_screen": [{"id", "score", "evidence"}], "top_issues": [max 5]}. Reply with "$alias $cp_id: <score>".
