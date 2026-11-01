create table if not exists public.portal_state (
  id smallint primary key check (id = 1),
  schema_version integer not null,
  workbook_state bytea not null,
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now()
);

alter table public.portal_state
  add column if not exists revision bigint not null default 1;

create table if not exists public.portal_profile_photos (
  user_id text primary key,
  extension text not null check (extension in ('jpg', 'png', 'webp')),
  photo_data bytea not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.portal_school_logos (
  user_id text primary key,
  extension text not null check (extension in ('jpg', 'png', 'webp')),
  logo_data bytea not null,
  updated_at timestamptz not null default now()
);

revoke all on table public.portal_state, public.portal_profile_photos, public.portal_school_logos
  from public;

-- Supabase only: also revoke from its API roles (these roles do not exist on plain PostgreSQL/Neon).
-- revoke all on table public.portal_state, public.portal_profile_photos, public.portal_school_logos
--   from anon, authenticated;
