"""Regenerates base/planted.patch from a clean CTFd 3.8.9 checkout.

Usage: python3 base/make_planted.py <ctfd-checkout-at-pinned-commit>
Edits the checkout in place (B1 + B2 plants). Then: git -C <checkout> diff > base/planted.patch
"""
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])


def edit(rel, old, new, count=1):
    p = root / rel
    s = p.read_text()
    if s.count(old) != count:
        raise SystemExit(f"{rel}: expected {count} match(es), found {s.count(old)}:\n{old}")
    p.write_text(s.replace(old, new))


def drop_function(rel, name):
    p = root / rel
    s = p.read_text()
    m = re.search(rf"\n\ndef {name}\(.*?(?=\n\n\ndef |\Z)", s, re.S)
    if not m:
        raise SystemExit(f"{rel}: {name} not found")
    p.write_text(s[: m.start()] + s[m.end():])


# ---- B1: duplicate solves possible (revert of upstream #2920 + no DB uniqueness)
edit(
    "CTFd/models/__init__.py",
    '''    __tablename__ = "solves"
    __table_args__ = (
        db.UniqueConstraint("challenge_id", "user_id"),
        db.UniqueConstraint("challenge_id", "team_id"),
        {},
    )
''',
    '''    __tablename__ = "solves"
''',
)
edit("CTFd/plugins/challenges/__init__.py", "from sqlalchemy.exc import IntegrityError\n", "")
edit(
    "CTFd/plugins/challenges/__init__.py",
    "    ChallengeCreateException,\n    ChallengeSolveException,\n",
    "    ChallengeCreateException,\n",
)
edit(
    "CTFd/plugins/challenges/__init__.py",
    '''
        try:
            db.session.add(solve)
            db.session.commit()
        except IntegrityError as e:
            db.session.rollback()
            raise ChallengeSolveException(
                f"Duplicate solve for user {user.id} on challenge {challenge.id}"
            ) from e
''',
    '''        db.session.add(solve)
        db.session.commit()
''',
)
edit(
    "CTFd/exceptions/challenges.py",
    "\n\nclass ChallengeSolveException(Exception):\n    pass\n",
    "\n",
)
edit(
    "CTFd/api/v1/challenges.py",
    "    ChallengeCreateException,\n    ChallengeSolveException,\n",
    "    ChallengeCreateException,\n",
)
edit(
    "CTFd/api/v1/challenges.py",
    '''                        try:
                            chal_class.solve(
                                user=user,
                                team=team,
                                challenge=challenge,
                                request=request,
                            )

                        # ChallengeSoleException is raised on duplicate solve - so treat it as already_solved
                        except ChallengeSolveException:
                            log(
                                "submissions",
                                "[{date}] {name} submitted {submission} on {challenge_id} with kpm {kpm} [ALREADY SOLVED]",
                                name=user.name,
                                submission=request_data.get("submission", "").encode(
                                    "utf-8"
                                ),
                                challenge_id=challenge_id,
                                kpm=kpm,
                            )

                            return {
                                "success": True,
                                "data": {
                                    "status": "already_solved",
                                    "message": f"{message} but you already solved this",
                                },
                            }

''',
    '''                        chal_class.solve(
                            user=user, team=team, challenge=challenge, request=request
                        )
''',
)
# upstream tests that only exist for the reverted fix
drop_function("tests/challenges/test_base_challenge.py", "test_base_challenge_solve_raises_on_duplicate_solve")
edit("tests/challenges/test_base_challenge.py", "import pytest\n", "")
edit("tests/challenges/test_base_challenge.py", "from sqlalchemy.exc import IntegrityError\n\n", "\n")
edit("tests/challenges/test_base_challenge.py", "from CTFd.exceptions.challenges import ChallengeSolveException\n", "")
edit("tests/challenges/test_base_challenge.py", "    gen_solve,\n    gen_team,\n", "")
drop_function("tests/api/v1/test_challenges.py", "test_api_challenge_attempt_post_duplicate_solve_race_condition")
edit("tests/api/v1/test_challenges.py", "from unittest.mock import patch\n", "")
edit("tests/api/v1/test_challenges.py", "from sqlalchemy.exc import IntegrityError\n", "")
edit("tests/api/v1/test_challenges.py", "from CTFd.exceptions.challenges import ChallengeSolveException\n", "")

# ---- B2: solve counts join on Users, so hidden/banned *teams* are counted in teams mode
edit(
    "CTFd/utils/challenges/__init__.py",
    '''    AccountModel = get_model()
    freeze = get_config("freeze")
    if freeze and not admin:
        freeze_cond = Solves.date < unix_time_to_utc(freeze)
    else:
        freeze_cond = true()
    exclude_solves_cond = and_(
        AccountModel.banned == false(),
        AccountModel.hidden == false(),
    )
    solves_q = (
        db.session.query(
            Solves.challenge_id,
            sa_func.count(Solves.challenge_id),
        )
        .join(AccountModel)
''',
    '''    freeze = get_config("freeze")
    if freeze and not admin:
        freeze_cond = Solves.date < unix_time_to_utc(freeze)
    else:
        freeze_cond = true()
    # Solves from hidden or banned players (e.g. admins testing) are not counted
    exclude_solves_cond = and_(
        Users.banned == false(),
        Users.hidden == false(),
    )
    solves_q = (
        db.session.query(
            Solves.challenge_id,
            sa_func.count(Solves.challenge_id),
        )
        .join(Users, Solves.user_id == Users.id)
''',
)
print("planted")
