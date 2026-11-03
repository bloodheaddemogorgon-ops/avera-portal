# AVeRA Class Portal — Architecture

## Active local runtime

| Layer | Technology | Responsibility |
|---|---|---|
| Web application | Node.js portal frontends | Teacher, parent, and admin portal pages |
| API | Node.js HTTP server | Authentication, authorization, and portal operations |
| Local data | SQLite (`node:sqlite`) | Workbook-backed portal state stored on this device |
| Reports and records | Existing portal implementation | Attendance, grades, learner records, imports, and exports |

`npm run dev`, `npm start`, `npm run start:legacy`, and the Electron app use local SQLite only. The active portal does not connect to an online database or synchronize records. `SUPABASE_DB_URL`, `DATABASE_URL`, and `PORTAL_STORAGE_MODE` do not change its storage mode.

The SQLite database defaults to `grade5-portal-database.sqlite` in the project directory. Configure `PORTAL_DATABASE_PATH` to choose another local file path.

## Separate Next.js prototype

The Next.js prototype is not part of the active portal. It can still be run explicitly with `npm run dev:next` and continues to use Supabase through files under `app/`, `lib/supabase/`, and `supabase/`.

## Key locations

- `server.js`, `portal-*.js`, `desktop/`: active local portal backend and clients.
- `grade5-portal-database.sqlite`: default local database (created/used by the backend).
- `app/`, `components/`, `lib/supabase/`, `supabase/`: optional Next.js/Supabase prototype.
