"""Add member_limit to teams

Revision ID: a1c3e5f7b9d1
Revises: 48d8250d19bd
Create Date: 2026-10-25 12:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "a1c3e5f7b9d1"
down_revision = "48d8250d19bd"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("teams", sa.Column("member_limit", sa.Integer(), nullable=True))


def downgrade():
    op.drop_column("teams", "member_limit")
