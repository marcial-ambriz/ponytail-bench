from sqlalchemy.sql.expression import union_all

from CTFd.cache import cache
from CTFd.models import Awards, Brackets, Challenges, Solves, Teams, Users, db
from CTFd.utils import get_config
from CTFd.utils.dates import unix_time_to_utc
from CTFd.utils.modes import get_model


@cache.memoize(timeout=60)
def get_standings(count=None, bracket_id=None, admin=False, fields=None):
    """
    Get standings as a list of tuples containing account_id, name, and score e.g. [(account_id, team_name, score)].

    Ties are broken by who reached a given score first based on the solve ID. Two users can have the same score but one
    user will have a solve ID that is before the others. That user will be considered the tie-winner.

    Challenges & Awards with a value of zero are filtered out of the calculations to avoid incorrect tie breaks.
    """
    if fields is None:
        fields = []
    Model = get_model()

    scores = (
        db.session.query(
            Solves.account_id.label("account_id"),
            db.func.sum(Challenges.value).label("score"),
            db.func.max(Solves.id).label("id"),
            db.func.max(Solves.date).label("date"),
        )
        .join(Challenges)
        .filter(Challenges.value != 0)
        .group_by(Solves.account_id)
    )

    awards = (
        db.session.query(
            Awards.account_id.label("account_id"),
            db.func.sum(Awards.value).label("score"),
            db.func.max(Awards.id).label("id"),
            db.func.max(Awards.date).label("date"),
        )
        .filter(Awards.value != 0)
        .group_by(Awards.account_id)
    )

    """
    Filter out solves and awards that are before a specific time point.
    """
    freeze = get_config("freeze")
    if not admin and freeze:
        scores = scores.filter(Solves.date < unix_time_to_utc(freeze))
        awards = awards.filter(Awards.date < unix_time_to_utc(freeze))

    """
    Combine awards and solves with a union. They should have the same amount of columns
    """
    results = union_all(scores, awards).alias("results")

    """
    Sum each of the results by the team id to get their score.
    """
    sumscores = (
        db.session.query(
            results.columns.account_id,
            db.func.sum(results.columns.score).label("score"),
            db.func.max(results.columns.id).label("id"),
            db.func.max(results.columns.date).label("date"),
        )
        .group_by(results.columns.account_id)
        .subquery()
    )

    """
    Admins can see scores for all users but the public cannot see banned users.

    Filters out banned users.
    Properly resolves value ties by ID.

    Different databases treat time precision differently so resolve by the row ID instead.
    """
    if admin:
        standings_query = (
            db.session.query(
                Model.id.label("account_id"),
                Model.oauth_id.label("oauth_id"),
                Model.name.label("name"),
                Model.bracket_id.label("bracket_id"),
                Brackets.name.label("bracket_name"),
                Model.hidden,
                Model.banned,
                sumscores.columns.score,
                *fields,
            )
            .join(sumscores, Model.id == sumscores.columns.account_id)
            .join(Brackets, isouter=True)
            .order_by(
                sumscores.columns.score.desc(),
                sumscores.columns.date.asc(),
                sumscores.columns.id.asc(),
            )
        )
    else:
        standings_query = (
            db.session.query(
                Model.id.label("account_id"),
                Model.oauth_id.label("oauth_id"),
                Model.name.label("name"),
                Model.bracket_id.label("bracket_id"),
                Brackets.name.label("bracket_name"),
                sumscores.columns.score,
                *fields,
            )
            .join(sumscores, Model.id == sumscores.columns.account_id)
            .join(Brackets, isouter=True)
            .filter(Model.banned == False, Model.hidden == False)
            .order_by(
                sumscores.columns.score.desc(),
                sumscores.columns.date.asc(),
                sumscores.columns.id.asc(),
            )
        )

    # Filter on a bracket if asked
    if bracket_id is not None:
        standings_query = standings_query.filter(Model.bracket_id == bracket_id)

    # Only select a certain amount of users if asked.
    if count is None:
        standings = standings_query.all()
    else:
        standings = standings_query.limit(count).all()

    return standings


@cache.memoize(timeout=60)
def get_team_standings(count=None, bracket_id=None, admin=False, fields=None):
    if fields is None:
        fields = []
    scores = (
        db.session.query(
            Solves.team_id.label("team_id"),
            db.func.sum(Challenges.value).label("score"),
            db.func.max(Solves.id).label("id"),
            db.func.max(Solves.date).label("date"),
        )
        .join(Challenges)
        .filter(Challenges.value != 0)
        .group_by(Solves.team_id)
    )

    awards = (
        db.session.query(
            Awards.team_id.label("team_id"),
            db.func.sum(Awards.value).label("score"),
            db.func.max(Awards.id).label("id"),
            db.func.max(Awards.date).label("date"),
        )
        .filter(Awards.value != 0)
        .group_by(Awards.team_id)
    )

    freeze = get_config("freeze")
    if not admin and freeze:
        scores = scores.filter(Solves.date < unix_time_to_utc(freeze))
        awards = awards.filter(Awards.date < unix_time_to_utc(freeze))

    results = union_all(scores, awards).alias("results")

    sumscores = (
        db.session.query(
            results.columns.team_id,
            db.func.sum(results.columns.score).label("score"),
            db.func.max(results.columns.id).label("id"),
            db.func.max(results.columns.date).label("date"),
        )
        .group_by(results.columns.team_id)
        .subquery()
    )

    if admin:
        standings_query = (
            db.session.query(
                Teams.id.label("team_id"),
                Teams.oauth_id.label("oauth_id"),
                Teams.name.label("name"),
                Teams.bracket_id.label("bracket_id"),
                Brackets.name.label("bracket_name"),
                Teams.hidden,
                Teams.banned,
                sumscores.columns.score,
                *fields,
            )
            .join(sumscores, Teams.id == sumscores.columns.team_id)
            .join(Brackets, isouter=True)
            .order_by(
                sumscores.columns.score.desc(),
                sumscores.columns.date.asc(),
                sumscores.columns.id.asc(),
            )
        )
    else:
        standings_query = (
            db.session.query(
                Teams.id.label("team_id"),
                Teams.oauth_id.label("oauth_id"),
                Teams.name.label("name"),
                Teams.bracket_id.label("bracket_id"),
                Brackets.name.label("bracket_name"),
                sumscores.columns.score,
                *fields,
            )
            .join(sumscores, Teams.id == sumscores.columns.team_id)
            .join(Brackets, isouter=True)
            .filter(Teams.banned == False)
            .filter(Teams.hidden == False)
            .order_by(
                sumscores.columns.score.desc(),
                sumscores.columns.date.asc(),
                sumscores.columns.id.asc(),
            )
        )

    if bracket_id is not None:
        standings_query = standings_query.filter(Teams.bracket_id == bracket_id)

    if count is None:
        standings = standings_query.all()
    else:
        standings = standings_query.limit(count).all()

    return standings


@cache.memoize(timeout=60)
def get_user_standings(count=None, bracket_id=None, admin=False, fields=None):
    if fields is None:
        fields = []
    scores = (
        db.session.query(
            Solves.user_id.label("user_id"),
            db.func.sum(Challenges.value).label("score"),
            db.func.max(Solves.id).label("id"),
            db.func.max(Solves.date).label("date"),
        )
        .join(Challenges)
        .filter(Challenges.value != 0)
        .group_by(Solves.user_id)
    )

    awards = (
        db.session.query(
            Awards.user_id.label("user_id"),
            db.func.sum(Awards.value).label("score"),
            db.func.max(Awards.id).label("id"),
            db.func.max(Awards.date).label("date"),
        )
        .filter(Awards.value != 0)
        .group_by(Awards.user_id)
    )

    freeze = get_config("freeze")
    if not admin and freeze:
        scores = scores.filter(Solves.date < unix_time_to_utc(freeze))
        awards = awards.filter(Awards.date < unix_time_to_utc(freeze))

    results = union_all(scores, awards).alias("results")

    sumscores = (
        db.session.query(
            results.columns.user_id,
            db.func.sum(results.columns.score).label("score"),
            db.func.max(results.columns.id).label("id"),
            db.func.max(results.columns.date).label("date"),
        )
        .group_by(results.columns.user_id)
        .subquery()
    )

    if admin:
        standings_query = (
            db.session.query(
                Users.id.label("user_id"),
                Users.oauth_id.label("oauth_id"),
                Users.name.label("name"),
                Users.team_id.label("team_id"),
                Users.bracket_id.label("bracket_id"),
                Brackets.name.label("bracket_name"),
                Users.hidden,
                Users.banned,
                sumscores.columns.score,
                *fields,
            )
            .join(sumscores, Users.id == sumscores.columns.user_id)
            .join(Brackets, isouter=True)
            .order_by(
                sumscores.columns.score.desc(),
                sumscores.columns.date.asc(),
                sumscores.columns.id.asc(),
            )
        )
    else:
        standings_query = (
            db.session.query(
                Users.id.label("user_id"),
                Users.oauth_id.label("oauth_id"),
                Users.name.label("name"),
                Users.team_id.label("team_id"),
                Users.bracket_id.label("bracket_id"),
                Brackets.name.label("bracket_name"),
                sumscores.columns.score,
                *fields,
            )
            .join(sumscores, Users.id == sumscores.columns.user_id)
            .join(Brackets, isouter=True)
            .filter(Users.banned == False, Users.hidden == False)
            .order_by(
                sumscores.columns.score.desc(),
                sumscores.columns.date.asc(),
                sumscores.columns.id.asc(),
            )
        )

    if bracket_id is not None:
        standings_query = standings_query.filter(Users.bracket_id == bracket_id)

    if count is None:
        standings = standings_query.all()
    else:
        standings = standings_query.limit(count).all()

    return standings


def lock_account_row(user, team=None):
    """Serialise score-changing writes for one account inside the current transaction.

    Issues a no-op UPDATE on the account's row: it takes the row lock on PostgreSQL/MySQL
    and the database write lock on SQLite, and both are held until the caller commits or
    rolls back. Callers must do their reads *after* this so they see committed data.
    """
    model = Teams if team is not None else Users
    account_id = team.id if team is not None else user.id
    table = model.__table__
    db.session.execute(
        table.update().where(table.c.id == account_id).values(id=table.c.id)
    )


def get_uncached_account_score(user, team=None):
    """Current full score (solves + awards, ignoring freeze) read straight from the DB."""
    if team is not None:
        solve_cond = Solves.team_id == team.id
        award_cond = Awards.team_id == team.id
    else:
        solve_cond = Solves.user_id == user.id
        award_cond = Awards.user_id == user.id
    solves = (
        db.session.query(db.func.coalesce(db.func.sum(Challenges.value), 0))
        .select_from(Solves)
        .join(Challenges, Solves.challenge_id == Challenges.id)
        .filter(solve_cond)
        .scalar()
    )
    awards = (
        db.session.query(db.func.coalesce(db.func.sum(Awards.value), 0))
        .filter(award_cond)
        .scalar()
    )
    return int(solves or 0) + int(awards or 0)
