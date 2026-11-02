# AVeRA Class Portal — Architecture

## Active local runtime

| Layer | Technology | Responsibility |
|---|---|---|
| Web application | Node.js portal frontends | Teacher, parent, and admin portal pages |
| API | Node.js HTTP server | Authentication, authorization, and portal operations |
| Local data | SQLite (`node:sqlite`) | Workbook-backed portal state and synchronization metadata |
| Reports and records | Existing portal implementation | Attendance, grades, learner records, imports, and exports |

`npm run dev`, `npm start`, `npm run start:legacy`, and the Electron app use this local SQLite runtime by default. Set `SUPABASE_DB_URL` only to intentionally select the legacy PostgreSQL storage mode. `NEXT_PUBLIC_SUPABASE_*` browser settings do not select the active backend.

The SQLite database defaults to `grade5-portal-database.sqlite` in the project directory. Configure `PORTAL_DATABASE_PATH` to choose another local file path.

## Optional Next.js/Supabase scaffold

The separate Next.js prototype can still be run explicitly with `npm run dev:next` and is not the default app. It uses Supabase Auth, Database, and Storage through files under `app/`, `lib/supabase/`, and `supabase/`.

The Supabase project is not modified or cleared by switching the active runtime to SQLite. Existing Supabase tables and data remain online.

## Key locations

- `server.js`, `portal-*.js`, `desktop/`: active local portal backend and clients.
- `grade5-portal-database.sqlite`: default local database (created/used by the backend).
- `app/`, `components/`, `lib/supabase/`, `supabase/`: optional Next.js/Supabase prototype.
