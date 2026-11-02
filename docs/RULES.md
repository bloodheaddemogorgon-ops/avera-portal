# AVeRA Class Portal — Development Rules

## Framework and implementation

- Follow the installed Next.js version, not assumptions from older releases. Before changing Next.js APIs or routing behavior, read the relevant guide under `node_modules/next/dist/docs/`.
- Use TypeScript for the new app and follow existing App Router, server-action, and Supabase client patterns.
- Keep server-only credentials and privileged operations out of browser bundles. Use the publishable key with RLS for user-facing queries.
- Validate all form input on the server. UI validation improves usability but does not replace server validation.
- Preserve existing legacy workflows unless a replacement has been implemented and verified. Do not mix the legacy workbook-blob schema with the new normalized tables.

## Privacy and data safety

- Treat learner names, identifiers, birth dates, grades, attendance, and assessments as sensitive education records.
- Enforce tenant and learner-level access in Supabase RLS and Storage policies. Test direct unauthorized reads/writes as well as visible UI behavior.
- Keep real student records, credentials, `.env` files, database snapshots, and generated reports out of Git.
- Do not use real learner details in screenshots, fixtures, logs, or tests; use synthetic examples.
- Keep Storage private. Validate ownership and learner links when reading or writing objects.
- Never weaken policies to make a frontend query succeed. Diagnose the policy and data relationship instead.

## Reliability and UX

- Show actionable errors for failed saves, authentication, and exports. Avoid success-shaped fallbacks or silent errors.
- Do not represent an empty result or failed query as populated/valid data.
- Make screens usable with keyboard navigation, labels, accessible names, and responsive layouts.
- Keep chart labels and exported report content consistent with the data displayed.

## Verification

- Run the narrowest applicable check, then `npm run typecheck`, `npm run build`, and relevant tests when the change warrants them.
- For database changes, verify schema consistency and exercise relevant RLS scenarios.
- For legacy-impacting changes, run `npm run check` and the relevant `node --test` tests.
- Update the relevant docs whenever architecture, setup, data handling, or product scope changes.
