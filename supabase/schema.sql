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
  unique (classroom_id, lrn),
  unique (id, classroom_id)
);

create table public.grades (
  id uuid primary key default gen_random_uuid(),
  classroom_id uuid not null references public.classrooms (id) on delete cascade,
  student_id uuid not null,
  term smallint not null check (term between 1 and 3),
  subject text not null check (char_length(subject) between 1 and 80),
  score numeric(5, 2) not null check (score between 0 and 100),
  updated_at timestamptz not null default now(),
  unique (student_id, term, subject),
  foreign key (student_id, classroom_id) references public.students (id, classroom_id) on delete cascade
);

create table public.attendance (
  id uuid primary key default gen_random_uuid(),
  classroom_id uuid not null references public.classrooms (id) on delete cascade,
  student_id uuid not null,
  attendance_date date not null,
  status text not null check (status in ('present', 'absent', 'tardy', 'excused', 'no_class')),
  reason text,
  updated_at timestamptz not null default now(),
  unique (student_id, attendance_date),
  foreign key (student_id, classroom_id) references public.students (id, classroom_id) on delete cascade
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
  unique (student_id, cycle, language, assessed_at),
  foreign key (student_id, classroom_id) references public.students (id, classroom_id) on delete cascade
);

create index classrooms_owner_id_idx on public.classrooms (owner_id);
create index classroom_members_user_id_idx on public.classroom_members (user_id);
create index students_classroom_id_idx on public.students (classroom_id);
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

insert into storage.buckets (id, name, public, file_size_limit)
values ('student-documents', 'student-documents', false, 10485760)
on conflict (id) do nothing;

create policy "Classroom members read stored documents" on storage.objects for select to authenticated
  using (bucket_id = 'student-documents' and public.can_access_student(((storage.foldername(name))[1])::uuid));
create policy "Teachers manage stored documents" on storage.objects for all to authenticated
  using (bucket_id = 'student-documents' and public.can_manage_student(((storage.foldername(name))[1])::uuid))
  with check (bucket_id = 'student-documents' and public.can_manage_student(((storage.foldername(name))[1])::uuid));