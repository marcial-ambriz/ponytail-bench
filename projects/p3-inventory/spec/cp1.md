# Stockly — Inventory management

Build an inventory management app for a small distributor in the existing monorepo scaffold. The app is delivered in
**checkpoints**; each one is revealed when the previous one is done. Each checkpoint must leave the app working end to
end, and everything from earlier checkpoints must keep working (data, API and UI).

## Fixed constraints (do not change)

- Monorepo: pnpm workspaces + Turbo. `apps/api` (Hono + Zod, Node 22, TypeScript) and `apps/web` (React 19 + Vite +
  Tailwind 4 + TanStack Router + TanStack Query).
- Database: **SQLite**, single file. Path comes from env `DB_PATH` (default `./data/stockly.db`). The schema must be
  created or migrated automatically on API start. Data-access library is your choice.
- Auth: **better-auth** (email + password), session cookie, httpOnly.
- API listens on env `API_PORT` (default 3000). Web dev server on env `WEB_PORT` (default 5173) and proxies `/api` to
  the API. `pnpm dev` starts both. `pnpm test` runs your tests. `pnpm lint` passes with zero warnings.
- **Time zone: the whole app operates in UTC.** Store timestamps as ISO 8601 UTC; show dates and times in UTC.
- **Quantities** are whole units (integers). **Money** is stored and sent as integer cents.
- **Visual quality:** the UI must look clean and consistent (clear hierarchy, spacing, readable tables and forms,
  visible empty and error states) and be usable on desktop (1280px) and mobile (390px) without horizontal page
  scrolling. Styling approach is your choice within Tailwind 4.
- **Usability:** every action that talks to the server gives visible feedback (pending state, then success or error);
  destructive actions ask for confirmation in an in-page dialog (never `window.confirm`); forms keep the user's input
  when the server rejects it.
- On start, if no user exists, seed an admin: `admin@stockly.test` / `Admin1234!` (name "Admin").

## Contracts (the acceptance suite depends on them)

**UI:** use accessible markup. Tests select elements by **role + accessible name**, by label, by the routes below, and
by the exact visible texts in quotes. Validation and request errors are rendered in an element with `role="alert"`.
Do not rely only on native browser validation (`required`, `min`, `pattern`): the server-side error must be shown.
Dialog close buttons are labeled "Close" (never "Cancel").

**API:** JSON over the paths below (all under `/api`). Status codes: `401` no session · `403` insufficient role ·
`404` not found · `409` conflict (duplicate, insufficient stock, wrong state) · `422` validation error · `201` created ·
`200` otherwise. Error bodies are `{ "error": "<readable message>" }`. Auth endpoints are whatever better-auth mounts
under `/api/auth/*`, with better-auth's own status codes and error bodies (the UI must show their message). Unknown
fields in request bodies are ignored. Ids are opaque strings or numbers of your choice.

## Checkpoint 1 — Auth, roles and product catalog

### Auth and roles

- **R1.1** Routes `/login`, `/register`, `/` (home, requires a session; redirect to `/login` otherwise).
- **R1.2** Register form: fields labeled "Name", "Email", "Password"; button "Create account". New users get role
  `clerk`. On success the user is signed in and redirected to `/`. A password shorter than 8 characters shows
  "Password must be at least 8 characters". A duplicate email shows an error containing "already".
- **R1.3** Login form: "Email", "Password", button "Sign in". Wrong credentials show an error containing "Invalid".
- **R1.4** Every signed-in page has a header with the user's name, a "Sign out" button (returns to `/login`) and nav
  links "Products" (everyone) and "Users" (admins only). A clerk visiting `/users` is redirected to `/`.
- **R1.5** `GET /api/me` → `{ id, name, email, role }` (401 without a session). Roles are `admin` and `clerk`, read
  from the database on every request, so a role change applies on the user's next request without signing out.
- **R1.6** `/users` (admin): table with column headers "Name", "Email", "Role"; each row has a select labeled "Role"
  (options "admin", "clerk"). Changing it saves immediately and shows "Role updated". An admin cannot change their own
  role (the API returns 422 and the UI shows the error).
  API: `GET /api/users` → `[{ id, name, email, role }]` (admin only); `PATCH /api/users/:id` with `{ role }` (admin
  only; unknown role → 422; unknown user → 404; own role → 422).

### Product catalog

- **R1.7** Product: `sku` (required; trimmed and stored upper-case; 3–32 characters from `A–Z`, `0–9`, `-`), `name`
  (required, trimmed, 2–80 characters), `description` (optional, ≤ 500 characters). SKUs are unique
  (case-insensitive) → 409 with an error containing "already exists". The SKU cannot be changed after creation: a
  `PATCH` that sends a different `sku` → 422.
- **R1.8** API: `GET /api/products` (any signed-in user; ordered by SKU; optional `q` matches SKU or name,
  case-insensitive substring), `GET /api/products/:id`, `POST /api/products` → 201 `{ id, sku, name, description,
  createdAt }`, `PATCH /api/products/:id` (partial update, returns the product), `DELETE /api/products/:id` → 200.
  Writes are **admin only** (403 for clerks, nothing changes). Unknown id → 404.
- **R1.9** `/products` (everyone): table with column headers "SKU" and "Name", ordered by SKU. Each SKU is a link to
  `/products/:id`. A search box labeled "Search" filters by SKU or name on change (no submit button). When nothing
  matches, the page shows "No products found".
- **R1.10** Admins see a "New product" button that opens an in-page dialog with fields "SKU", "Name", "Description" and
  a "Save" button; on success the dialog closes and the product is listed. Each row has "Edit" (same dialog,
  prefilled, SKU read-only or disabled) and "Delete" buttons; "Delete" opens an in-page dialog with "Confirm delete".
  Clerks see none of these controls.
- **R1.11** `/products/:id`: a heading with the product name and the text "SKU: <sku>".
