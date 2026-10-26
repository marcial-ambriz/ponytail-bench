from sqlalchemy import and_, func, select

from CTFd.models import Teams, Users, db
from CTFd.utils import get_config


def get_member_limit(member_limit):
    """Seat limit for a team given its own override (0 means unlimited)."""
    if member_limit:
        return int(member_limit)
    return int(get_config("team_size", default=0) or 0)


def join_team(user_id, team_id):
    """Atomically put a team-less user on a team if the team still has a free seat.

    The seat check and the membership write happen in one conditional UPDATE, so
    simultaneous joins cannot overfill a team (SQLite serialises writers for the whole
    statement). On databases with row locks the team row is locked first so the seat
    count cannot be read stale by a concurrent transaction.

    Returns True when the user joined, False when the team is full or the user already
    belongs to a team.
    """
    row = (
        db.session.query(Teams.id, Teams.member_limit, Teams.captain_id)
        .filter(Teams.id == team_id)
        .with_for_update()
        .first()
    )
    if row is None:
        db.session.rollback()
        return False
    limit = get_member_limit(row.member_limit)

    users = Users.__table__
    conditions = [users.c.id == user_id, users.c.team_id.is_(None)]
    if limit:
        seat_users = users.alias("seat_users")
        seats_taken = (
            select(func.count(seat_users.c.id))
            .where(seat_users.c.team_id == team_id)
            .scalar_subquery()
        )
        conditions.append(seats_taken < limit)

    result = db.session.execute(
        users.update().where(and_(*conditions)).values(team_id=team_id)
    )
    joined = result.rowcount == 1
    if joined and row.captain_id is None:
        db.session.execute(
            Teams.__table__.update()
            .where(Teams.__table__.c.id == team_id)
            .values(captain_id=user_id)
        )
    db.session.commit()
    db.session.expire_all()
    return joined
