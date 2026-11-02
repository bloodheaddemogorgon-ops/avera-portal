# AVeRA Class Portal — Migration Tasks

This is the migration checklist for the new Next.js/Supabase app. Check off work only after implementation and verification; the legacy application remains supported during the migration.

## Foundation — implemented

- [x] Add Next.js, React, TypeScript, Tailwind CSS, Supabase SSR/client libraries, jsPDF, html2canvas, and Recharts.
- [x] Add teacher registration, sign-in, sign-out, and session refresh.
- [x] Add the authenticated teacher dashboard and classroom creation.
- [x] Add reading-level chart and dashboard PDF export.
- [x] Add normalized initial Supabase tables, RLS policies, and a private document bucket.
- [x] Keep the current Node/Electron application available as the legacy runtime.

## Product workflows — not yet implemented

- [ ] Add teacher classroom management, including multiple classes and membership management.
- [ ] Add learner create/read/update/archive workflows and safe roster import.
- [ ] Add grade entry, editing, validation, and grade summaries.
- [ ] Add attendance entry, calendar handling, and monthly summaries.
- [ ] Add reading-assessment entry, history, and progress views.
- [ ] Add private learner-document upload, download, and removal workflows.
- [ ] Add parent linking, invitation/enrollment, and parent-facing learner views.
- [ ] Add administrator access management and school settings.
- [ ] Replace dashboard placeholder navigation with functional routes.
- [ ] Implement report selection, filtering, and tested multipage print/export layouts.
- [ ] Review accessibility and responsive behavior across all completed workflows.

## Data transition and release — not yet implemented

- [ ] Define a field-by-field mapping from the legacy workbook model to normalized Supabase records.
- [ ] Build a repeatable, dry-run-capable importer with clear validation and error reporting.
- [ ] Back up source data, import a representative copy, and reconcile row counts and key totals.
- [ ] Decide and document account migration/reset and parent-linking procedures.
- [ ] Test RLS and Storage access for teacher, linked parent, unrelated parent, and unauthenticated users.
- [ ] Run end-to-end tests against a dedicated Supabase project without production learner data.
- [ ] Document rollback, backup, deployment, and incident-response procedures before cutover.
- [ ] Cut over only after feature parity requirements, data reconciliation, and user acceptance are satisfied.
