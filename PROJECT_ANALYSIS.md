# Project Technical Analysis

**Project:** Grade 5 Class Portal  
**Version:** 1.0.19  
**Analysis date:** 2026-10-30  
**Scope:** Source code, packaging configuration, database artifacts, templates, tests, documentation, and generated release files in the repository.

## 1. Executive summary

This is a Node.js desktop/web hybrid for Grade 5 classroom administration. It provides teacher and parent accounts, class/learner rosters, grades, attendance, reading and mathematics assessments, nutritional status calculations, Excel import/export, profile images, and a Windows Electron package.

The backend is a dependency-light Node `http` server. Its primary data model is an Excel workbook held as compressed binary state inside SQLite or PostgreSQL/Supabase. This preserves workbook compatibility, but makes normal relational querying, indexing, reporting, and concurrent scaling more difficult.

The server binds to loopback by default and refuses public binding without TLS credentials. Failed sign-ins are now throttled in process memory. The primary unresolved risks are sensitive local data without application-level encryption, and the scalability costs of repeatedly reading and rewriting workbook state.

## 2. Folder and file structure

```text
.
├── server.js                         Node HTTP API, authentication, persistence, imports/exports
├── auth-rate-limiter.js               Bounded per-account and per-IP sign-in throttling
├── index.html                        Single-page frontend (HTML/CSS/vanilla JavaScript)
├── scripts/check.js                  Dependency-free JavaScript syntax check
├── desktop/
│   └── main.js                       Electron main process and local server bootstrap
├── who-growth-reference.js           WHO LMS growth calculations and reference loading
├── test/
│   └── server.test.js                Node test-runner integration/unit tests
├── data/
│   └── who-growth-reference-2007/    WHO BMI/height reference workbooks
├── downloads/
│   └── generated-reports/             Generated SF8/report output files
├── release/                           Electron installers and unpacked release artifacts
├── grade5-portal-database.sqlite      Local SQLite database
├── grade5-portal-database.sqlite-*    SQLite WAL/shared-memory files
├── grade5-portal-database.xlsx        Live/migration workbook artifact
├── grade5-portal-database-template.xlsx
├── portal-schema.sql                   PostgreSQL/Supabase schema
├── SF1.xls, SF2.xlsx, SF8.xlsx, SF9.xlsx
├── Grading Sheet.xlsx, RMA TEMP.xlsx,
│   PhilIRI_Auto_Scoring_Template.xlsx Excel import/export templates
├── icon.ico, icon.png                 Application assets
├── start-portal.bat                   Windows startup/dependency check
├── package.json, package-lock.json    Dependency and build configuration
└── README.md                           Setup, deployment, and feature documentation
```

The repository also contains large binary templates and release payloads. `release/` includes an unpacked Chromium/Electron runtime and installers; these are build outputs rather than application source.

## 3. Frameworks, runtimes, and libraries

| Area | Technology | Use |
|---|---|---|
| Runtime | Node.js >= 22.5 | Server runtime and built-in `node:sqlite` |
| HTTP | Node `node:http` | Custom API server and static frontend delivery |
| Desktop | Electron 39 | Windows desktop shell, localhost server lifecycle |
| Packaging | electron-builder 26 / NSIS | Windows installer and executable packaging |
| Spreadsheet processing | ExcelJS 4.4; `@e965/xlsx` | Workbook persistence, SF1/SF2/report import/export, WHO reference loading |
| Image processing | Sharp 0.35 | Validation/processing of profile photos and school logos |
| PostgreSQL | `pg` 8.23; Supabase-compatible PostgreSQL | Optional remote persistence backend |
| Configuration | dotenv 18 | `.env` configuration loading |
| Frontend | Vanilla HTML/CSS/JavaScript | Single-page UI; no React/Vue/Angular or CSS framework |
| Testing | Node built-in `node:test` and `node:assert` | Automated tests |

There is no Express, ORM, migration framework, client-side build pipeline, or TypeScript layer.

## 4. Architecture and data flow

1. `server.js` starts a custom HTTP server, serves `index.html`, and exposes JSON/file-download endpoints under `/api/*`.
2. The frontend calls the same-origin API with `fetch` and uses an `HttpOnly`, `SameSite=Strict` session cookie.
3. The backend loads an Excel workbook through ExcelJS, applies row/sheet-level business logic, compresses the workbook, and stores it as one state blob.
4. Local mode stores the blob in SQLite table `portal_state`.
5. Supabase mode stores the blob in PostgreSQL `portal_state`; profile photos and school logos are separate bytea tables.
6. Electron starts the server on an ephemeral loopback port and opens it in a sandboxed, context-isolated BrowserWindow.

## 5. Database schema

### 5.1 Physical SQLite schema

The inspected SQLite database contains one table:

```sql
portal_state(
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL,
  workbook_state BLOB NOT NULL,
  updated_at TEXT NOT NULL
)
```

`workbook_state` is a gzip-compressed serialized workbook. The business tables are therefore logical worksheets inside the blob, not independently queryable SQLite tables. The repository also includes SQLite WAL/SHM files, which are operational database files and should be handled carefully in backups.

### 5.2 PostgreSQL/Supabase schema

`portal-schema.sql` and runtime initialization define:

- `portal_state(id, schema_version, workbook_state bytea, updated_at timestamptz)` with a single-row `id = 1` constraint.
- `portal_profile_photos(user_id, extension, photo_data bytea, updated_at timestamptz)`.
- `portal_school_logos(user_id, extension, logo_data bytea, updated_at timestamptz)`.

Table access is revoked from `public`, `anon`, and `authenticated`; the server uses the PostgreSQL connection string server-side.

### 5.3 Logical workbook schema

The application dynamically creates/extends worksheets as required. The main logical entities are:

| Worksheet/entity | Important fields | Purpose |
|---|---|---|
| `Users` | User ID, role, name, email, password hash (bcrypt for admins; PBKDF2 for teacher/parent accounts), class ID, status, sign-ins, last sign-in, admin access, must-change-password | Teacher/parent accounts and authentication state |
| `Classes` | Class ID, classroom number, class/join code, teacher ID/name, grade, section, school year and school metadata, student/parent counts | Class ownership and parent enrollment |
| `Students` | Student ID, class ID, parent ID, teacher ID, LRN, names, gender, birthdate, guardian/family/residence/language/ethnicity fields, nutritional measurements | Learner roster and personal data |
| `Term Grades` | Grade ID, student/class/teacher IDs, term, subject, grade, updated | Per-subject term grades |
| `Term Grade Locks` | Class/teacher/term/student, locked, updated | Prevents edits after locking |
| `Reading Assessments` | Student/class/teacher, period, language, level, assessed date, attempt, updated | Reading history |
| `PHIL-IRI Assessments` | Assessment metadata plus assessment-data JSON and cutoffs | Phil-IRI scoring and results |
| `Math Assessments` | Score/items, period/date, strengths, improvement areas, intervention, item responses, remarks | Mathematics assessment records |
| `Attendance Records` | Student/class/teacher, date, status, reason, updated, attendance key | Daily attendance |
| `Attendance Monthly Notes` / calendar | Class/teacher/date/day type/calendar key | Monthly attendance day metadata |
| `SignInLog` | Timestamp, email, selected role, result, user ID, note | Authentication audit history |

The exact workbook can gain additional columns over time through `ensureColumn`, which provides backward compatibility but weakens schema enforcement.

## 6. Security assessment

### Current risk summary

No security review was performed for this update. The following are design and deployment risks observed during the project analysis, not a penetration-test result.

### Additional security risks and controls

- **Sensitive local data at rest:** SQLite/workbook state contains student PII, grades, attendance, and password hashes. Local mode does not provide database encryption or an application-level encryption key. File-system permissions and encrypted OS storage are relied upon.
- **In-memory sessions:** Sessions are stored in a process-local `Map`; restarting the server invalidates all sessions, and multiple server instances do not share sessions. There is no server-side session store or explicit session revocation list beyond logout/process lifetime.
- **Registration exposure:** Public registration is enabled. Teacher classroom identifiers and parent join codes become the enrollment boundary; there is no email verification or account approval workflow.
- **Brute-force protections:** Sign-in failures are limited to 10 per account and 40 per source IP per rolling 15-minute window. The limiter is process-local, resets on restart, and does not coordinate across multiple servers. Behind a reverse proxy, the proxy's IP is counted because forwarded headers are not trusted.
- **Browser security headers:** JSON responses set `nosniff` and no-store, but the HTML response does not show a Content-Security-Policy, frame-ancestors policy, or other comprehensive browser hardening headers.
- **Audit limitations:** Sign-in history is workbook data rather than an append-only, centrally queryable audit store, and the log fields are limited compared with a production audit trail.

### Positive controls observed

- Administrator passwords use bcrypt cost 12; teacher/parent passwords use PBKDF2-SHA-256 with random 16-byte salts and 210,000 iterations.
- `HttpOnly` and `SameSite=Strict` session cookie attributes.
- Electron `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`.
- Same-origin API design, parameterized PostgreSQL queries, upload size limits, image signature checks, and role/session checks on protected endpoints.
- Supabase table privileges are revoked from browser-facing roles.
- Public network binding requires TLS key and certificate configuration; default binding is loopback-only.

## 7. Performance and scalability issues

### High impact

1. **Workbook-as-database architecture:** Most operations deserialize the entire workbook and later serialize/compress/write the entire workbook. A small grade or attendance update can incur O(total workbook size) I/O and CPU.
2. **Repeated linear scans:** User, class, student, grade, attendance, and ID lookups iterate worksheet rows. There are no relational indexes, query plans, or in-memory indexes for the logical entities.
3. **Serialized write queue:** `serializeWorkbook` intentionally serializes writes. This protects consistency but creates a single throughput bottleneck and increases wait time under concurrent requests.
4. **PostgreSQL blob contention:** Supabase transactions lock the single `portal_state` row. Concurrent users/classes contend on one row even when updating unrelated records.
5. **ExcelJS memory footprint:** Large workbooks, SF1/SF2 imports, and report generation are loaded into memory. Multiple simultaneous requests can amplify memory use.

### Medium impact

- WHO reference workbooks are loaded synchronously at module initialization, increasing startup latency and making missing/corrupt reference files a startup failure.
- Generated reports are retained under `downloads/generated-reports`; there is no visible retention, rotation, or quota policy.
- `index.html` is a very large monolithic document (over 600 KB) containing all CSS and frontend logic, which increases initial parse and maintenance cost.
- The custom HTTP server has no compression, caching strategy for versioned application assets, or request metrics.

### Recommended direction

Move transactional portal entities to normalized SQLite/PostgreSQL tables with foreign keys and indexes; retain Excel only as an import/export format. Add pagination and bounded report jobs, background report generation, report retention, and operational metrics. Preserve the current workbook migration path for compatibility.

## 8. Missing or incomplete features

These are gaps relative to a production-ready multi-user school portal, not claims that every item was promised by the current UI:

- **Secure public hosting:** TLS termination/HTTPS enforcement, secure proxy configuration, and deployment-safe cookie policy.
- **Account lifecycle:** email verification, password reset/recovery, administrator approval, account disable/delete workflow, and stronger enrollment-code rotation/revocation.
- **Authorization administration:** fine-grained permissions, explicit school/district tenancy boundaries, and centralized role/permission policy beyond teacher/parent/admin checks.
- **Data protection:** the README now documents OS/device encryption, safe SQLite backup handling, and the risk of syncing unencrypted portal data. The application still has no application-level database encryption, automated backup, restore verification, or retention/deletion policy.
- **Operational resilience:** structured logs/metrics, health/readiness separation, automatic backup scheduling, migration versioning, and conflict/error recovery for multiple instances.
- **Scalability:** normalized queryable schema, pagination, indexed search/filtering, and asynchronous report/import processing.
- **Testing coverage:** the Node test suite covers core API and workbook flows, but there is no visible browser/Electron end-to-end suite, load test, or broad route matrix for every grade, attendance, parent, admin, and export path.
- **Accessibility/UX hardening:** automated accessibility checks, localization, and a documented support path for keyboard/screen-reader and low-connectivity use are not evident from the repository.
- **Release hygiene:** generated release binaries, generated reports, and database artifacts coexist with source. A CI pipeline for reproducible builds, dependency auditing, signing, and artifact cleanup is not evident.

## 9. Validation performed

- Inspected source, configuration, templates, database artifacts, desktop bootstrap, documentation, and release structure.
- Inspected the live SQLite schema using Node's built-in SQLite API.
- Inspected workbook header rows and dynamic worksheet definitions.
- Ran `npm run check`: **7 JavaScript files and 1 inline browser script passed syntax checks**.
- Ran `npm test`: **25 tests passed, 0 failed**.

Passing tests demonstrate current expected behavior for selected authentication, migration, appearance, storage, and WHO-calculation scenarios; they do not eliminate the deployment and scalability risks above.

## 10. Prioritized recommendations

1. Keep the existing loopback default; deploy publicly only with a trusted TLS configuration and carefully configured proxy.
2. Login throttling and a dependency-free syntax-check command are implemented; add account recovery and explicit enrollment-code lifecycle controls separately.
3. Keep sensitive data and backups on encrypted, access-controlled storage; application-level encryption and automated restore-tested backups remain future work.
4. The current workbook-state format is intentionally preserved. If usage grows, plan and test a versioned migration to normalized, indexed tables rather than changing the live database in place.
5. Continue expanding API tests and add browser/Electron end-to-end, load, and security regression tests before public deployment.
6. Extract further frontend and backend domains incrementally; only the sign-in limiter has been split into an independent module in this update.
