create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '',
  role text not null default 'teacher' check (role in ('teacher', 'parent', 'admin')),
  created_at timestamptz not null default now()
);

create table public.classrooms (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  grade_level smallint not null check (grade_level between 1 and 12),
  section text check (section is null or char_length(section) <= 80),
  school_year text,
  created_at timestamptz not null default now()
);

create table public.classroom_members (
  classroom_id uuid not null references public.classrooms (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  member_role text not null check (member_role in ('teacher', 'parent')),
  created_at timestamptz not null default now(),
  primary key (classroom_id, user_id)
);

create table public.subjects (
  id uuid primary key default gen_random_uuid(),
  classroom_id uuid not null references public.classrooms (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  code text check (code is null or char_length(code) <= 20),
  created_at timestamptz not null default now(),
  constraint subjects_name_unique unique (classroom_id, name),
  constraint subjects_id_classroom_unique unique (id, classroom_id)
);

create table public.students (
  id uuid primary key default gen_random_uuid(),
  classroom_id uuid not null references public.classrooms (id) on delete cascade,
  parent_id uuid references public.profiles (id) on delete set null,
  lrn text,
  first_name text not null,
  middle_name text,
  last_name text not null,
  sex text check (sex is null or sex in ('Female', 'Male')),
  birth_date date,
  created_at timestamptz not null default now(),
  constraint students_id_classroom_unique unique (id, classroom_id)
);

create unique index students_lrn_unique
  on public.students (lrn)
  where lrn is not null;

create table public.grades (
  id uuid primary key default gen_random_uuid(),
  classroom_id uuid not null references public.classrooms (id) on delete cascade,
  student_id uuid not null,
  subject_id uuid not null,
  term smallint not null check (term between 1 and 3),
  score numeric(5, 2) not null check (score between 0 and 100),
  updated_at timestamptz not null default now(),
  constraint grades_unique_entry unique (student_id, term, subject_id),
  constraint grades_student_classroom_fkey
    foreign key (student_id, classroom_id)
    references public.students (id, classroom_id)
    on delete cascade,
  constraint grades_subject_classroom_fkey
    foreign key (subject_id, classroom_id)
    references public.subjects (id, classroom_id)
    on delete cascade
);

create table public.attendance (
  id uuid primary key default gen_random_uuid(),
  classroom_id uuid not null references public.classrooms (id) on delete cascade,
  student_id uuid not null,
  attendance_date date not null,
  status text not null check (status in ('present', 'absent', 'tardy', 'excused', 'no_class')),
  reason text,
  updated_at timestamptz not null default now(),
  constraint attendance_unique_entry unique (student_id, attendance_date),
  constraint attendance_student_classroom_fkey
    foreign key (student_id, classroom_id)
    references public.students (id, classroom_id)
    on delete cascade
);

create table public.reading_assessments (
  id uuid primary key default gen_random_uuid(),
  classroom_id uuid not null references public.classrooms (id) on delete cascade,
  student_id uuid not null,
  cycle text not null check (cycle in ('BOSY', 'MOSY', 'EOSY')),
  language text not null check (language in ('English', 'Filipino')),
  reading_level text not null check (reading_level in ('Non-reader', 'Frustration', 'Instructional', 'Independent')),
  assessed_at date not null default current_date,
  assessor_id uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  constraint reading_assessment_unique_entry unique (student_id, cycle, language),
  constraint reading_assessment_student_classroom_fkey
    foreign key (student_id, classroom_id)
    references public.students (id, classroom_id)
    on delete cascade
);

create table public.competencies (
  id uuid primary key default gen_random_uuid(),
  classroom_id uuid not null references public.classrooms (id) on delete cascade,
  subject_id uuid not null,
  code text check (code is null or char_length(code) <= 30),
  description text not null check (char_length(description) between 1 and 1000),
  term smallint check (term is null or term between 1 and 3),
  created_at timestamptz not null default now(),
  constraint competencies_subject_classroom_fkey
    foreign key (subject_id, classroom_id)
    references public.subjects (id, classroom_id)
    on delete cascade
);

create table public.assessments (
  id uuid primary key default gen_random_uuid(),
  classroom_id uuid not null references public.classrooms (id) on delete cascade,
  subject_id uuid not null,
  title text not null check (char_length(title) between 1 and 150),
  assessment_type text not null check (assessment_type in ('written_work', 'performance_task', 'quarterly_assessment')),
  term smallint not null check (term between 1 and 3),
  administered_at date,
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  constraint assessments_id_classroom_unique unique (id, classroom_id),
  constraint assessments_subject_classroom_fkey
    foreign key (subject_id, classroom_id)
    references public.subjects (id, classroom_id)
    on delete cascade
);

create table public.assessment_items (
  id uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references public.assessments (id) on delete cascade,
  competency_id uuid,
  item_number smallint not null check (item_number > 0),
  max_points numeric(7, 2) not null default 1 check (max_points >= 0),
  correct_answer text,
  created_at timestamptz not null default now(),
  constraint assessment_items_unique_number unique (assessment_id, item_number),
  constraint assessment_items_id_assessment_unique unique (id, assessment_id),
  constraint assessment_items_competency_fkey
    foreign key (competency_id)
    references public.competencies (id)
    on delete set null
);

create table public.student_answers (
  id uuid primary key default gen_random_uuid(),
  classroom_id uuid not null references public.classrooms (id) on delete cascade,
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
    references public.assessments (id, classroom_id)
    on delete cascade,
  constraint student_answers_student_classroom_fkey
    foreign key (student_id, classroom_id)
    references public.students (id, classroom_id)
    on delete cascade,
  constraint student_answers_item_assessment_fkey
    foreign key (item_id, assessment_id)
    references public.assessment_items (id, assessment_id)
    on delete cascade
);

create table public.announcements (
  id uuid primary key default gen_random_uuid(),
  classroom_id uuid not null references public.classrooms (id) on delete cascade,
  author_id uuid not null references public.profiles (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 150),
  content text not null check (char_length(content) between 1 and 5000),
  audience text not null default 'all' check (audience in ('all', 'parents', 'teachers')),
  published_at timestamptz not null default now(),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index classrooms_owner_id_idx on public.classrooms (owner_id);
create index classroom_members_user_id_idx on public.classroom_members (user_id);
create index students_classroom_id_idx on public.students (classroom_id);
create index subjects_classroom_id_idx on public.subjects (classroom_id);
create index grades_classroom_term_idx on public.grades (classroom_id, term);
create index attendance_classroom_date_idx on public.attendance (classroom_id, attendance_date);
create index reading_assessments_classroom_cycle_idx on public.reading_assessments (classroom_id, cycle);

create or replace function public.create_teacher_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, role)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', ''), 'teacher');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.create_teacher_profile();

create or replace function public.can_access_classroom(target_classroom uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.classrooms c
    where c.id = target_classroom and c.owner_id = (select auth.uid())
  ) or exists (
    select 1 from public.classroom_members m
    where m.classroom_id = target_classroom and m.user_id = (select auth.uid())
  );
$$;

create or replace function public.can_manage_classroom(target_classroom uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.classrooms c
    where c.id = target_classroom and c.owner_id = (select auth.uid())
  ) or exists (
    select 1 from public.classroom_members m
    where m.classroom_id = target_classroom
      and m.user_id = (select auth.uid()) and m.member_role = 'teacher'
  );
$$;

create or replace function public.can_access_student(target_student uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.students s
    where s.id = target_student
      and (public.can_manage_classroom(s.classroom_id) or s.parent_id = (select auth.uid()))
  );
$$;

create or replace function public.can_manage_student(target_student uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.students s
    where s.id = target_student and public.can_manage_classroom(s.classroom_id)
  );
$$;

create or replace function public.prevent_profile_role_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.role is distinct from old.role and (select auth.uid()) = old.id then
    raise exception 'Profile role cannot be changed by the account owner';
  end if;
  return new;
end;
$$;

create trigger protect_profile_role
  before update on public.profiles
  for each row execute procedure public.prevent_profile_role_change();

alter table public.profiles enable row level security;
alter table public.classrooms enable row level security;
alter table public.classroom_members enable row level security;
alter table public.students enable row level security;
alter table public.subjects enable row level security;
alter table public.grades enable row level security;
alter table public.attendance enable row level security;
alter table public.reading_assessments enable row level security;

create policy "Users read own profile" on public.profiles for select to authenticated using (id = (select auth.uid()));
create policy "Users update own display name" on public.profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));
revoke update on public.profiles from authenticated;
grant update (display_name) on public.profiles to authenticated;

create policy "Classroom members read classrooms" on public.classrooms for select to authenticated using (public.can_access_classroom(id));
create policy "Teachers create own classrooms" on public.classrooms for insert to authenticated with check (owner_id = (select auth.uid()));
create policy "Teachers update own classrooms" on public.classrooms for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "Teachers delete own classrooms" on public.classrooms for delete to authenticated using (owner_id = (select auth.uid()));

create policy "Members read classroom links" on public.classroom_members for select to authenticated using (user_id = (select auth.uid()) or public.can_manage_classroom(classroom_id));
create policy "Teachers manage classroom links" on public.classroom_members for all to authenticated using (public.can_manage_classroom(classroom_id)) with check (public.can_manage_classroom(classroom_id));

create policy "Members read linked students" on public.students for select to authenticated using (public.can_access_student(id));
create policy "Teachers manage students" on public.students for all to authenticated using (public.can_manage_classroom(classroom_id)) with check (public.can_manage_classroom(classroom_id));

create policy "Members read linked learner grades" on public.grades for select to authenticated using (public.can_access_student(student_id));
create policy "Teachers manage grades" on public.grades for all to authenticated using (public.can_manage_classroom(classroom_id)) with check (public.can_manage_classroom(classroom_id));

create policy "Members read linked learner attendance" on public.attendance for select to authenticated using (public.can_access_student(student_id));
create policy "Teachers manage attendance" on public.attendance for all to authenticated using (public.can_manage_classroom(classroom_id)) with check (public.can_manage_classroom(classroom_id));

create policy "Members read linked learner assessments" on public.reading_assessments for select to authenticated using (public.can_access_student(student_id));
create policy "Teachers manage reading assessments" on public.reading_assessments for all to authenticated using (public.can_manage_classroom(classroom_id)) with check (public.can_manage_classroom(classroom_id));

alter table public.competencies enable row level security;
alter table public.assessments enable row level security;
alter table public.assessment_items enable row level security;
alter table public.student_answers enable row level security;
alter table public.announcements enable row level security;

create policy "Members read subjects" on public.subjects for select to authenticated using (public.can_access_classroom(classroom_id));
create policy "Teachers manage subjects" on public.subjects for all to authenticated using (public.can_manage_classroom(classroom_id)) with check (public.can_manage_classroom(classroom_id));

create policy "Members read competencies" on public.competencies for select to authenticated using (public.can_access_classroom(classroom_id));
create policy "Teachers manage competencies" on public.competencies for all to authenticated using (public.can_manage_classroom(classroom_id)) with check (public.can_manage_classroom(classroom_id));

create policy "Members read assessments" on public.assessments for select to authenticated using (public.can_access_classroom(classroom_id));
create policy "Teachers manage assessments" on public.assessments for all to authenticated using (public.can_manage_classroom(classroom_id)) with check (public.can_manage_classroom(classroom_id));

create policy "Members read assessment items" on public.assessment_items for select to authenticated
  using (exists (select 1 from public.assessments a where a.id = assessment_items.assessment_id and public.can_access_classroom(a.classroom_id)));
create policy "Teachers manage assessment items" on public.assessment_items for all to authenticated
  using (exists (select 1 from public.assessments a where a.id = assessment_items.assessment_id and public.can_manage_classroom(a.classroom_id)))
  with check (exists (select 1 from public.assessments a where a.id = assessment_items.assessment_id and public.can_manage_classroom(a.classroom_id)));

create policy "Members read linked learner answers" on public.student_answers for select to authenticated using (public.can_access_student(student_id));
create policy "Teachers manage learner answers" on public.student_answers for all to authenticated using (public.can_manage_classroom(classroom_id)) with check (public.can_manage_classroom(classroom_id));

create policy "Members read announcements" on public.announcements for select to authenticated using (
  public.can_access_classroom(classroom_id)
  and (audience = 'all' or (audience = 'parents' and exists (select 1 from public.students s where s.classroom_id = announcements.classroom_id and s.parent_id = auth.uid()))
       or (audience = 'teachers' and public.can_manage_classroom(classroom_id)))
);
create policy "Teachers manage announcements" on public.announcements for all to authenticated using (public.can_manage_classroom(classroom_id)) with check (public.can_manage_classroom(classroom_id));

-- Legacy portal workbook state and synchronization storage
create table if not exists public.portal_state (
  id smallint primary key check (id = 1),
  schema_version integer not null,
  workbook_state bytea not null,
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.portal_profile_photos (
  user_id text primary key,
  extension text not null check (extension in ('jpg', 'png', 'webp')),
  photo_data bytea not null,
  photo_url text,
  updated_at timestamptz not null default now()
);

create table if not exists public.portal_school_logos (
  user_id text primary key,
  extension text not null check (extension in ('jpg', 'png', 'webp')),
  logo_data bytea not null,
  logo_url text,
  updated_at timestamptz not null default now()
);

alter table public.portal_state
  add column if not exists revision bigint not null default 1;

alter table public.portal_profile_photos
  add column if not exists photo_url text;

alter table public.portal_school_logos
  add column if not exists logo_url text;

alter table public.portal_state enable row level security;
alter table public.portal_profile_photos enable row level security;
alter table public.portal_school_logos enable row level security;

revoke all on table
  public.portal_state,
  public.portal_profile_photos,
  public.portal_school_logos
  from public;

revoke all on table
  public.portal_state,
  public.portal_profile_photos,
  public.portal_school_logos
  from anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit)
values ('student-documents', 'student-documents', false, 10485760)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('profile-photos', 'profile-photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp']),
  ('school-logos', 'school-logos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "Classroom members read stored documents" on storage.objects for select to authenticated
  using (bucket_id = 'student-documents' and public.can_access_student(((storage.foldername(name))[1])::uuid));
create policy "Teachers manage stored documents" on storage.objects for all to authenticated
  using (bucket_id = 'student-documents' and public.can_manage_student(((storage.foldername(name))[1])::uuid))
  with check (bucket_id = 'student-documents' and public.can_manage_student(((storage.foldername(name))[1])::uuid));

create policy "Users manage their profile photos" on storage.objects for all to authenticated
  using (bucket_id = 'profile-photos' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'profile-photos' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Users manage their school logos" on storage.objects for all to authenticated
  using (bucket_id = 'school-logos' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'school-logos' and (storage.foldername(name))[1] = auth.uid()::text);