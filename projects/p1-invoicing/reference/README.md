# ledgerly

Starting scaffold: a pnpm + Turbo monorepo with a Hono API (`apps/api`) and a React 19 + Vite web app
(`apps/web`). The product to build is specified one checkpoint at a time in `SPEC/` (`cp1.md`, `cp2.md`, …, added as each
checkpoint starts; `cp1.md` holds the constraints that apply to all of them).

## Getting started

Requires Node 22 (see `.nvmrc`) and pnpm 10.

```sh
pnpm i
pnpm dev
```

Other scripts: `pnpm test`, `pnpm lint`, `pnpm format`, `pnpm build`, `pnpm typecheck`.

## Environment variables

| Variable   | Default | Purpose                                                         |
| ---------- | ------- | --------------------------------------------------------------- |
| `API_PORT` | `3000`  | Port the API listens on; the web dev server proxies `/api` here |
| `WEB_PORT` | `5173`  | Port of the web dev server (strict)                             |
| `DB_PATH`  | —       | Path to the database file (to be used by the app)               |
