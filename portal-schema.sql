create table if not exists public.portal_state (
  id smallint primary key check (id = 1),
  schema_version integer not null,
  workbook_state bytea not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.portal_profile_photos (
  user_id text primary key,
  extension text not null check (extension in ('jpg', 'png', 'webp')),
  photo_data bytea not null,
  updated_at timestamptz not null default now()
);

revoke all on table public.portal_state, public.portal_profile_photos
  from public, anon, authenticated;
