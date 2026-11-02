# AVeRA Class Portal — Product Requirements

## Purpose

AVeRA helps teachers keep classroom records and learner progress organized, private, and usable for everyday decisions. The new web application is being built alongside the existing desktop/Node portal so that records and workflows can be migrated deliberately.

## Users

- **Teachers:** create and manage classroom records, review progress, and produce reports.
- **Parents/guardians:** access only records belonging to their linked learner. Parent-facing screens are planned, not yet implemented in the new app.
- **Administrators:** manage access and school-wide configuration. Administrative workflows are planned, not yet implemented in the new app.

## Product requirements

1. Provide a responsive web application using Next.js, React, TypeScript, and Tailwind CSS.
2. Authenticate users with Supabase Auth; do not implement a second password store in the new app.
3. Store normalized classroom and learner records in Supabase Database and protect them with row-level security (RLS).
4. Store learner documents in a private Supabase Storage bucket with access checked against the linked learner.
5. Support classroom, learner, grade, attendance, and reading-assessment workflows as the migration progresses.
6. Provide useful classroom summaries, reading-level visualizations with Recharts, and downloadable reports using jsPDF/html2canvas.
7. Preserve the existing portal and data until migration is verified. Never imply that the new app has imported legacy records automatically.
8. Surface authentication, data, and export failures clearly; do not silently show fabricated data as real records.

## Current release scope

Implemented in the new app:

- Teacher registration and email/password sign-in via Supabase Auth.
- Authenticated teacher dashboard and sign-out.
- Create one classroom and view its summary.
- Dashboard counts/grade average/reading-level chart from the new Supabase tables.
- PDF export of the dashboard view.
- Normalized starter schema with RLS and private student-document storage.

Not yet implemented:

- Legacy database/workbook import and reconciliation.
- Full learner, grade, attendance, and assessment CRUD interfaces.
- Parent enrollment and parent-facing portal.
- Admin tools, school configuration, and complete legacy feature parity.
- Production Supabase configuration and end-to-end testing against a real project.

## Acceptance criteria

- Local development and production builds pass the repository's type/build checks.
- Unauthenticated users cannot access the teacher dashboard.
- Supabase RLS, not UI filtering alone, enforces data access.
- Parent access (when implemented) is limited to the learner explicitly linked to that parent.
- Exports represent the visible data and report export errors to the user.
- Existing legacy workflows and database remain available until replacement workflows and a verified migration are delivered.
