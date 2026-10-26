# Ledgerly — Checkpoint 1: accounts, organizations, roles and invitations

Ledgerly is a multi-tenant invoicing and payments app. Several companies (organizations) use the same installation;
each one sees only its own data. The app is delivered in **5 checkpoints**. Each checkpoint must leave the app working
end to end, and every later checkpoint must keep earlier ones working. This file holds the constraints and contracts
that apply to **every** checkpoint, followed by the requirements of checkpoint 1.

Requirement IDs (`R1.4`) are referenced by later checkpoints and by reviewers.

## Fixed constraints (all checkpoints, do not change)

- Monorepo: pnpm workspaces + Turbo. `apps/api` (Hono + Zod, Node 22, TypeScript) and `apps/web` (React 19 + Vite +
  Tailwind 4 + TanStack Router + TanStack Query).
- Database: **SQLite**, single file. Path comes from env `DB_PATH` (default `./data/ledgerly.db`). The schema is
  created or migrated automatically when the API starts. Data-access library is your choice.
- Auth: **better-auth** (email + password), session cookie, httpOnly.
- API listens on env `API_PORT` (default 3000). Web dev server on env `WEB_PORT` (default 5173) and proxies `/api` to
  the API. `pnpm dev` starts both. `pnpm test` runs your tests. `pnpm lint` passes with zero warnings.
- **Time zone: the whole app operates in UTC.** "Today" is the current UTC date. Dates are `YYYY-MM-DD`; timestamps are
  ISO 8601 UTC.
- **Visual quality:** the UI looks clean and consistent (clear hierarchy, spacing, readable tables and forms, visible
  empty and error states) and is usable on desktop (1280px) and mobile (390px) without horizontal page scrolling.
  Styling approach is your choice within Tailwind 4.
- **Usability:** every action that talks to the server gives visible feedback (pending state, then success or error);
  destructive or irreversible actions ask for confirmation in an in-page dialog (never `window.confirm`); forms keep
  the user's input when the server rejects it.

## Contracts (all checkpoints; the acceptance suite depends on them)

**UI.** Use accessible markup. Elements are found by **role + accessible name**, by label, by the routes listed, and
by the exact visible texts in quotes. Validation and request errors are rendered in an element with `role="alert"`.
Do not rely only on native browser validation (`required`, `min`, `pattern`): the server-side error must be shown.
Dialog close buttons are labeled "Close" (never "Cancel"). Dialogs move focus inside when they open and close with
Escape.

**API.** JSON over the paths listed, all under `/api`. Status codes: `401` no session · `403` signed in but the role
does not allow the action · `404` not found **or not visible to the caller** · `409` conflict (duplicate, already
done) · `422` validation or business-rule violation · `201` created · `200` otherwise. Error bodies are
`{ "error": "<readable message>" }`. Auth endpoints are whatever better-auth mounts under `/api/auth/*`, with
better-auth's own status codes and error bodies (the UI must show their message). Unknown fields in a request body
are ignored. Ids are opaque strings.

**Tenancy (R1.1).** Every organization's data is visible only to that organization's members. Any request under
`/api/orgs/:orgId/…` by a signed-in user who is not a member of `:orgId` returns **404** (the same answer as for an
organization that does not exist), whatever the method, and changes nothing. A record id that belongs to another
organization is treated exactly like an id that does not exist.

**Roles (R1.2).** Each membership has one role:

| Role | May |
|---|---|
| `owner` | everything, including managing members, roles and invitations |
| `accountant` | everything except managing members, roles, invitations and organization settings |
| `viewer` | read only: every `GET` the other roles can do, unless a requirement says otherwise; every write returns **403** |

Roles are read from the database on every request: a role change takes effect on the member's next request without
signing out. A request that is both unauthorized and invalid returns 403 (authorization is checked first); a 403 or
404 request changes nothing.

**Money (R1.3, used from checkpoint 2).** Every money amount in the API is an integer number of **cents** (JSON
integer; fields end in `Cents`). The UI shows amounts as US dollars with two decimals and thousands separators:
`$1,234.56`. Wherever the UI asks for an amount it accepts a plain decimal with at most two decimals (`1234.5`,
`1234.56`, `19.99`) and must convert it to cents exactly.

## Checkpoint 1 requirements

### Accounts

- **R1.4** Routes `/login`, `/register`. Every other page requires a session; without one the user is redirected to
  `/login`. A signed-in user visiting `/login` or `/register` is sent to `/`.
- **R1.5** Register form: fields labeled "Name", "Email", "Password"; button "Create account". On success the user is
  signed in and redirected to `/`. A password shorter than 8 characters shows "Password must be at least 8
  characters" and creates no account. A duplicate email shows an error containing "already".
- **R1.6** Login form: "Email", "Password", button "Sign in". Wrong credentials show an error containing "Invalid".
- **R1.7** Every signed-in page has a header with the app name "Ledgerly", the user's name and a "Sign out" button.
  Sign out ends the session (the old cookie no longer authenticates) and returns to `/login`.
- **R1.8** `GET /api/me` → `{ id, name, email }` (401 without a session).

### Organizations

- **R1.9** `POST /api/orgs` with `{ name }` → 201 `{ id, name, role: "owner" }`. The name is trimmed and must be 2–80
  characters (else 422). The creator becomes the organization's `owner`. Names need not be unique.
- **R1.10** `GET /api/orgs` → the caller's organizations, `[{ id, name, role }]` with the caller's role in each.
  `GET /api/orgs/:orgId` → `{ id, name, role }`.
- **R1.11** `/` lists the user's organizations under a heading "Your organizations"; each organization name is a link
  to `/orgs/:orgId`. When the user has none, the page shows "You are not a member of any organization yet". A form
  with the field "Organization name" and the button "Create organization" creates one and navigates to `/orgs/:orgId`.
- **R1.12** Every page under `/orgs/:orgId` shows the organization's name as a heading and a
  navigation landmark labeled "Organization" that contains the organization's sections (a link "Members" from this
  checkpoint; later checkpoints add more). A link "All organizations" returns to `/`. A user who is not a member of
  the organization (or an unknown id) sees the text "Organization not found" and none of its data.

### Members and roles

- **R1.13** `GET /api/orgs/:orgId/members` (any member) → `[{ userId, name, email, role }]`.
- **R1.14** `PATCH /api/orgs/:orgId/members/:userId` with `{ role }` (owner only) → 200 with the updated member.
  `role` must be `owner`, `accountant` or `viewer` (else 422). Unknown member → 404.
- **R1.15** `DELETE /api/orgs/:orgId/members/:userId` (owner only) → 200; the user loses access to the organization
  immediately. Unknown member → 404.
- **R1.16** An organization always keeps at least one owner: demoting or removing its last owner → 422 with an error
  containing "at least one owner". An owner may change their own role or remove themselves if another owner remains.
- **R1.17** `/orgs/:orgId/members`: a table with column headers "Name", "Email", "Role" listing every member.
  For an owner, each row has a select labeled "Role" (options "Owner", "Accountant", "Viewer") that saves on change
  and shows "Role updated", and a "Remove" button that opens a dialog with "Confirm remove". Server errors (for
  example the last-owner rule) are shown and the select returns to the stored role. Accountants and viewers see the
  same table read-only: no role selects, no "Remove" buttons, no invitation form.

### Invitations

- **R1.18** `POST /api/orgs/:orgId/invitations` with `{ email, role }` (owner only) → 201
  `{ id, email, role, token }`. `email` must be a valid address and `role` one of the three roles (else 422).
  Inviting an email that already belongs to a member, or that already has a pending invitation to this organization,
  → 409. Emails compare case-insensitively.
- **R1.19** `GET /api/orgs/:orgId/invitations` (owner only) → pending invitations `[{ id, email, role, token }]`.
- **R1.20** `GET /api/invitations/:token` (any signed-in user) → `{ orgName, email, role, status }` with `status`
  `"pending"` or `"accepted"`. Unknown token → 404.
- **R1.21** `POST /api/invitations/:token/accept` → 200 `{ orgId, role }` and the caller becomes a member with the
  invited role. Only a signed-in user whose email equals the invited email may accept (else 403). An invitation can
  be accepted once: accepting again, or accepting when already a member → 409. Unknown token → 404.
- **R1.22** On `/orgs/:orgId/members` an owner sees a form "Invite member" with fields "Email" and "Role" (options
  "Owner", "Accountant", "Viewer") and a button "Send invitation". On success it shows "Invitation created" and the
  pending invitations table (column headers "Email", "Role", "Link") lists it; the link column shows the full
  invitation URL `<web origin>/invitations/<token>` as text.
- **R1.23** `/invitations/:token` (signed in) shows the text "You have been invited to join <org name> as <role>"
  (role in lower case) and a button "Accept invitation". Accepting navigates to `/orgs/:orgId`. Server errors are
  shown.

## Definition of done

The features work in the browser, `pnpm lint` and `pnpm test` pass.
