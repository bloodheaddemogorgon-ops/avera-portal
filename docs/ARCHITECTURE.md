# AVeRA Class Portal — Architecture

## Target stack

| Layer | Technology | Responsibility |
|---|---|---|
| Web application | Next.js App Router, React, TypeScript | Routing, server-rendered pages, forms, and typed UI |
| Styling | Tailwind CSS | Utility styling and responsive presentation |
| Authentication | Supabase Auth | User registration, sign-in, and session management |
| Relational data | Supabase Database (PostgreSQL) | Profiles, classrooms, classroom membership, learners, grades, attendance, and reading assessments |
| Files | Supabase Storage | Private learner documents |
| Reports | jsPDF, html2canvas | Client-side PDF export of rendered report content |
| Charts | Recharts | Classroom reading-level summaries |

## Request and data flow

1. Next.js route components render the login, registration, and dashboard surfaces.
2. Server actions in `app/actions/` validate submitted form values and perform authenticated Supabase writes.
3. `lib/supabase/server-client.ts` creates the server-side Supabase client using request cookies.
4. Root `proxy.ts` refreshes Supabase Auth sessions and propagates updated cookies.
5. Supabase RLS policies enforce access to every protected row and object; the frontend is not an authorization boundary.
6. The dashboard reads the signed-in teacher's profile and classroom data. Recharts visualizes reading assessments; jsPDF/html2canvas exports the dashboard.

## Data model

The initial schema in `supabase/schema.sql` defines:

- `profiles`, linked to `auth.users`.
- `classrooms`, owned by a teacher.
- `classroom_members`, linking classroom users and roles.
- `students`, optionally linked to a parent profile.
- `grades`, `attendance`, and `reading_assessments`, each linked to both learner and classroom.
- A private `student-documents` storage bucket.

The schema uses foreign keys, checks, indexes, helper functions, and RLS policies. Parent-facing reads must use the learner link (`students.parent_id`) and must never grant access to all learners in a classroom merely because a parent is a classroom member.

## Runtime boundaries

- The new web app is the default `dev`, `build`, and `start` runtime.
- The legacy Node/Electron application remains available through `start:legacy`, `desktop`, and its existing scripts.
- Legacy records are workbook-backed state in SQLite/PostgreSQL and are not compatible automatically with the new normalized Supabase schema.
- No migration is complete until an importer is tested with a backup and reconciliation checks against representative legacy data.
- Browser code may use the Supabase publishable/anon key with RLS. Never place service-role keys, database passwords, or other server secrets in `NEXT_PUBLIC_*` variables.

## Key locations

- `app/`: Next.js routes and server actions.
- `components/`: chart and report-export UI.
- `lib/supabase/`: server-side client and helpers.
- `proxy.ts`: session refresh proxy.
- `supabase/schema.sql`: initial relational schema, policies, and storage setup.
- `server.js`, `portal-*.js`, `desktop/`: retained legacy system.
