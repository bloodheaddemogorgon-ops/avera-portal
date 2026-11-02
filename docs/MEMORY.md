# AVeRA Class Portal — Project Memory

This file records durable project context for future development. Do not store credentials, real learner data, personal account details, or temporary debugging output here.

## Project identity

- The application is the AVeRA Class Portal for classroom administration.
- The repository has an established Node.js/Electron portal used for teacher, parent, and administrator workflows.
- The new default web application is a staged rewrite using Next.js, React, TypeScript, Tailwind CSS, and Supabase.

## Important existing behavior

- Legacy records are stored in workbook-backed state in SQLite or PostgreSQL; do not assume there are normalized legacy SQL tables.
- Legacy runtime entry points include `npm run start:legacy` and `npm run desktop`.
- New app entry points include `npm run dev`, `npm run build`, and `npm start`.
- The new Supabase schema is applied separately using `supabase/schema.sql`.
- No legacy-to-new data importer has been implemented. Existing data remains in the legacy app.

## Current new-app checkpoint

- Implemented: teacher registration/sign-in, auth callback/session refresh, teacher dashboard, creation of a classroom, dashboard aggregates, reading-level chart, and PDF export.
- Schema includes profiles, classrooms, classroom membership, students, grades, attendance, reading assessments, RLS, and a private `student-documents` bucket.
- Full learner/grade/attendance CRUD, parent/admin portals, migration tooling, and production Supabase end-to-end verification remain outstanding. See `TASKS.md`.

## Working agreements

- Read the installed Next.js documentation before making framework changes.
- Keep data access policies in Supabase RLS; frontend visibility is not authorization.
- Use synthetic data in tests and examples. Keep credentials and school records private.
- Preserve the legacy app until replacements and a verified importer are ready.
- See `ARCHITECTURE.md`, `RULES.md`, and `DESIGN.md` for current technical and UX guidance.
