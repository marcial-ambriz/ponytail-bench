"""Add penalty to challenges

Revision ID: b2d4f6a8c0e2
Revises: a1c3e5f7b9d1
Create Date: 2026-10-25 12:30:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "b2d4f6a8c0e2"
down_revision = "a1c3e5f7b9d1"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "challenges",
        sa.Column("penalty", sa.Integer(), nullable=False, server_default="0"),
    )


def downgrade():
    op.drop_column("challenges", "penalty")
