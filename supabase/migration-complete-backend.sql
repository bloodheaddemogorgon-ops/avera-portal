-- Supabase migration for the complete Grade Portal backend
-- Safe to review in SQL Editor before running.

create table if not exists public.subjects (
  id uuid primary key default gen_random_uuid(),
  classroom_id uuid not null references public.classrooms(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  code text check (code is null or char_length(code) <= 20),
  created_at timestamptz not null default now(),
  constraint subjects_name_unique unique (classroom_id, name),
  constraint subjects_id_classroom_unique unique (id, classroom_id)
);

alter table public.subjects enable row level security;

create table if not exists public.competencies (
  id uuid primary key default gen_random_uuid(),
  classroom_id uuid not null references public.classrooms(id) on delete cascade,
  subject_id uuid not null,
  code text check (code is null or char_length(code) <= 30),
  description text not null check (char_length(description) between 1 and 1000),
  term smallint check (term is null or term between 1 and 3),
  created_at timestamptz not null default now(),
  constraint competencies_subject_classroom_fkey
    foreign key (subject_id, classroom_id)
    references public.subjects(id, classroom_id)
    on delete cascade
);

create table if not exists public.assessments (
  id uuid primary key default gen_random_uuid(),
  classroom_id uuid not null references public.classrooms(id) on delete cascade,
  subject_id uuid not null,
  title text not null check (char_length(title) between 1 and 150),
  assessment_type text not null check (assessment_type in ('written_work', 'performance_task', 'quarterly_assessment')),
  term smallint not null check (term between 1 and 3),
  administered_at date,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  constraint assessments_id_classroom_unique unique (id, classroom_id),
  constraint assessments_subject_classroom_fkey
    foreign key (subject_id, classroom_id)
    references public.subjects(id, classroom_id)
    on delete cascade
);

create table if not exists public.assessment_items (
  id uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references public.assessments(id) on delete cascade,
  competency_id uuid,
  item_number smallint not null check (item_number > 0),
  max_points numeric(7, 2) not null default 1 check (max_points >= 0),
  correct_answer text,
  created_at timestamptz not null default now(),
  constraint assessment_items_unique_number unique (assessment_id, item_number),
  constraint assessment_items_id_assessment_unique unique (id, assessment_id),
  constraint assessment_items_competency_fkey
    foreign key (competency_id)
    references public.competencies(id)
    on delete set null
);

create table if not exists public.student_answers (
  id uuid primary key default gen_random_uuid(),
  classroom_id uuid not null references public.classrooms(id) on delete cascade,
  assessment_id uuid not null,
  student_id uuid not null,
  item_id uuid not null,
  answer text,
  points numeric(7, 2) check (points >= 0),
  is_correct boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint student_answers_unique_entry unique (assessment_id, student_id, item_id),
  constraint student_answers_assessment_classroom_fkey
    foreign key (assessment_id, classroom_id)
    references public.assessments(id, classroom_id)
    on delete cascade,
  constraint student_answers_student_classroom_fkey
    foreign key (student_id, classroom_id)
    references public.students(id, classroom_id)
    on delete cascade,
  constraint student_answers_item_assessment_fkey
    foreign key (item_id, assessment_id)
    references public.assessment_items(id, assessment_id)
    on delete cascade
);

create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  classroom_id uuid not null references public.classrooms(id) on delete cascade,
  author_id uuid not null references public.profiles(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 150),
  content text not null check (char_length(content) between 1 and 5000),
  audience text not null default 'all' check (audience in ('all', 'parents', 'teachers')),
  published_at timestamptz not null default now(),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

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
  photo_data bytea,
  photo_url text,
  updated_at timestamptz not null default now()
);

create table if not exists public.portal_school_logos (
  user_id text primary key,
  extension text not null check (extension in ('jpg', 'png', 'webp')),
  logo_data bytea,
  logo_url text,
  updated_at timestamptz not null default now()
);

alter table public.portal_profile_photos add column if not exists photo_url text;
alter table public.portal_school_logos add column if not exists logo_url text;

create unique index if not exists students_lrn_unique
  on public.students(lrn)
  where lrn is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'students_id_classroom_unique'
      and conrelid = 'public.students'::regclass
  ) then
    alter table public.students
      add constraint students_id_classroom_unique unique (id, classroom_id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'grades_student_classroom_fkey'
      and conrelid = 'public.grades'::regclass
  ) and exists (
    select 1 from pg_constraint
    where conname = 'students_id_classroom_unique'
      and conrelid = 'public.students'::regclass
  ) then
    alter table public.grades
      add constraint grades_student_classroom_fkey
      foreign key (student_id, classroom_id)
      references public.students(id, classroom_id)
      on delete cascade;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'attendance_student_classroom_fkey'
      and conrelid = 'public.attendance'::regclass
  ) then
    alter table public.attendance
      add constraint attendance_student_classroom_fkey
      foreign key (student_id, classroom_id)
      references public.students(id, classroom_id)
      on delete cascade;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'reading_assessment_student_classroom_fkey'
      and conrelid = 'public.reading_assessments'::regclass
  ) then
    alter table public.reading_assessments
      add constraint reading_assessment_student_classroom_fkey
      foreign key (student_id, classroom_id)
      references public.students(id, classroom_id)
      on delete cascade;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'attendance_unique_entry'
      and conrelid = 'public.attendance'::regclass
  ) then
    alter table public.attendance
      add constraint attendance_unique_entry unique (student_id, attendance_date);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'reading_assessment_unique_entry'
      and conrelid = 'public.reading_assessments'::regclass
  ) then
    alter table public.reading_assessments
      add constraint reading_assessment_unique_entry unique (student_id, cycle, language);
  end if;
end $$;

alter table public.competencies enable row level security;
alter table public.assessments enable row level security;
alter table public.assessment_items enable row level security;
alter table public.student_answers enable row level security;
alter table public.announcements enable row level security;
alter table public.portal_state enable row level security;
alter table public.portal_profile_photos enable row level security;
alter table public.portal_school_logos enable row level security;

revoke all on table public.portal_state, public.portal_profile_photos, public.portal_school_logos from public;
revoke all on table public.portal_state, public.portal_profile_photos, public.portal_school_logos from anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('student-documents', 'student-documents', false, 10485760, array['application/pdf','image/jpeg','image/png','image/webp']),
  ('profile-photos', 'profile-photos', false, 5242880, array['image/jpeg','image/png','image/webp']),
  ('school-logos', 'school-logos', false, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Members read subjects" on public.subjects;
create policy "Members read subjects" on public.subjects
  for select to authenticated
  using (public.can_access_classroom(classroom_id));

drop policy if exists "Teachers manage subjects" on public.subjects;
create policy "Teachers manage subjects" on public.subjects
  for all to authenticated
  using (public.can_manage_classroom(classroom_id))
  with check (public.can_manage_classroom(classroom_id));

drop policy if exists "Members read competencies" on public.competencies;
create policy "Members read competencies" on public.competencies
  for select to authenticated
  using (public.can_access_classroom(classroom_id));

drop policy if exists "Teachers manage competencies" on public.competencies;
create policy "Teachers manage competencies" on public.competencies
  for all to authenticated
  using (public.can_manage_classroom(classroom_id))
  with check (public.can_manage_classroom(classroom_id));

drop policy if exists "Members read assessments" on public.assessments;
create policy "Members read assessments" on public.assessments
  for select to authenticated
  using (public.can_access_classroom(classroom_id));

drop policy if exists "Teachers manage assessments" on public.assessments;
create policy "Teachers manage assessments" on public.assessments
  for all to authenticated
  using (public.can_manage_classroom(classroom_id))
  with check (public.can_manage_classroom(classroom_id));

drop policy if exists "Members read assessment items" on public.assessment_items;
create policy "Members read assessment items" on public.assessment_items
  for select to authenticated
  using (exists (
    select 1 from public.assessments a
    where a.id = assessment_items.assessment_id
      and public.can_access_classroom(a.classroom_id)
  ));

drop policy if exists "Teachers manage assessment items" on public.assessment_items;
create policy "Teachers manage assessment items" on public.assessment_items
  for all to authenticated
  using (exists (
    select 1 from public.assessments a
    where a.id = assessment_items.assessment_id
      and public.can_manage_classroom(a.classroom_id)
  ))
  with check (exists (
    select 1 from public.assessments a
    where a.id = assessment_items.assessment_id
      and public.can_manage_classroom(a.classroom_id)
  ));

drop policy if exists "Members read linked learner answers" on public.student_answers;
create policy "Members read linked learner answers" on public.student_answers
  for select to authenticated
  using (public.can_access_student(student_id));

drop policy if exists "Teachers manage learner answers" on public.student_answers;
create policy "Teachers manage learner answers" on public.student_answers
  for all to authenticated
  using (public.can_manage_classroom(classroom_id))
  with check (public.can_manage_classroom(classroom_id));

drop policy if exists "Members read announcements" on public.announcements;
create policy "Members read announcements" on public.announcements
  for select to authenticated
  using (
    public.can_access_classroom(classroom_id)
    and (
      audience = 'all'
      or (audience = 'parents' and exists (
        select 1 from public.students s
        where s.classroom_id = announcements.classroom_id
          and s.parent_id = auth.uid()
      ))
      or (audience = 'teachers' and public.can_manage_classroom(classroom_id))
    )
  );

drop policy if exists "Teachers manage announcements" on public.announcements;
create policy "Teachers manage announcements" on public.announcements
  for all to authenticated
  using (public.can_manage_classroom(classroom_id))
  with check (public.can_manage_classroom(classroom_id));
