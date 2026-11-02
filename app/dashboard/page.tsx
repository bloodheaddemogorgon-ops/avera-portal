import { redirect } from "next/navigation";
import { createClassroom } from "@/app/actions/classrooms";
import { signOut } from "@/app/actions/auth";
import { ReadingChart, type ReadingLevelPoint } from "@/components/reading-chart";
import { ReportExport } from "@/components/report-export";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server-client";

const readingLevels = ["Non-reader", "Frustration", "Instructional", "Independent"] as const;

type DashboardPageProps = { searchParams: Promise<{ classError?: string }> };

export default async function DashboardPage({ searchParams }: DashboardPageProps) {
  if (!isSupabaseConfigured()) redirect("/login");
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: profile }, { data: classroom }, query] = await Promise.all([
    supabase.from("profiles").select("display_name, role").eq("id", user.id).maybeSingle(),
    supabase.from("classrooms").select("id, name, grade_level, section").eq("owner_id", user.id).order("created_at").limit(1).maybeSingle(),
    searchParams,
  ]);

  let studentCount = 0;
  let attendanceCount = 0;
  let averageGrade: string | null = null;
  let chartData: ReadingLevelPoint[] = readingLevels.map((level) => ({ level, english: 0, filipino: 0 }));

  if (classroom) {
    const monthStart = new Date();
    monthStart.setDate(1);
    const [students, attendance, grades, reading] = await Promise.all([
      supabase.from("students").select("id", { count: "exact", head: true }).eq("classroom_id", classroom.id),
      supabase.from("attendance").select("status").eq("classroom_id", classroom.id).gte("attendance_date", monthStart.toISOString().slice(0, 10)),
      supabase.from("grades").select("score").eq("classroom_id", classroom.id),
      supabase.from("reading_assessments").select("reading_level, language").eq("classroom_id", classroom.id),
    ]);
    studentCount = students.count ?? 0;
    attendanceCount = attendance.data?.length ?? 0;
    const scores = (grades.data ?? []).map((row) => Number(row.score)).filter(Number.isFinite);
    averageGrade = scores.length ? (scores.reduce((sum, score) => sum + score, 0) / scores.length).toFixed(1) : null;
    chartData = readingLevels.map((level) => ({
      level,
      english: reading.data?.filter((row) => row.reading_level === level && row.language === "English").length ?? 0,
      filipino: reading.data?.filter((row) => row.reading_level === level && row.language === "Filipino").length ?? 0,
    }));
  }

  const displayName = profile?.display_name || user.email || "Teacher";
  const classError = query.classError;

  return (
    <main className="portal-shell">
      <aside className="portal-sidebar">
        <div className="brand-lockup"><span className="brand-mark">A</span><span>AVeRA <small style={{ display: "block", color: "#a7c0b9", fontSize: 10, fontWeight: 500 }}>CLASS PORTAL</small></span></div>
        <span className="side-caption">Classroom</span>
        <nav aria-label="Main navigation">
          <a className="side-link" aria-current="page" href="/dashboard"><span className="side-symbol">⌂</span>Overview</a>
          <span className="side-link"><span className="side-symbol">▦</span>Learners</span>
          <span className="side-link"><span className="side-symbol">◷</span>Attendance</span>
          <span className="side-link"><span className="side-symbol">↗</span>Grades &amp; progress</span>
          <span className="side-caption">Workspace</span>
          <span className="side-link"><span className="side-symbol">▤</span>Reports</span>
        </nav>
        <div className="sidebar-bottom">Class records stay private to your school account.</div>
      </aside>
      <section className="main-column">
        <header className="topbar"><div><div className="topbar-label">Classroom workspace</div><div className="topbar-name">{classroom ? `${classroom.name} · Grade ${classroom.grade_level}` : "Your classroom"}</div></div><form action={signOut}><button className="quiet-button" type="submit">Sign out</button></form></header>
        <div className="content" id="dashboard-report">
          <div className="page-heading"><div><span className="eyebrow">Teacher overview</span><h1>Good day, {displayName.split(" ")[0]}.</h1><p>A quick look at your learners and this month’s classroom activity.</p></div><ReportExport /></div>
          <section className="stat-grid" aria-label="Classroom summary">
            <article className="stat-card"><span className="stat-label">Learners</span><strong className="stat-value">{classroom ? studentCount : "—"}</strong><span className="stat-note">In your active class</span></article>
            <article className="stat-card"><span className="stat-label">Attendance records</span><strong className="stat-value">{classroom ? attendanceCount : "—"}</strong><span className="stat-note">Saved this month</span></article>
            <article className="stat-card"><span className="stat-label">Grade average</span><strong className="stat-value">{averageGrade ?? "—"}</strong><span className="stat-note">Across saved subject grades</span></article>
            <article className="stat-card"><span className="stat-label">Reading assessments</span><strong className="stat-value">{classroom ? chartData.reduce((sum, row) => sum + row.english + row.filipino, 0) : "—"}</strong><span className="stat-note">Recorded across languages</span></article>
          </section>
          <section className="panel-grid">
            <article className="panel"><h2>Reading levels</h2><p className="panel-subtitle">Assessment records by language and level</p><ReadingChart data={chartData} /></article>
            <article className="panel"><h2>Class at a glance</h2><p className="panel-subtitle">Your current classroom record</p>
              {classroom ? <div className="table-wrap"><table className="data-table"><tbody><tr><th>Class</th><td>{classroom.name}</td></tr><tr><th>Grade</th><td>{classroom.grade_level}</td></tr><tr><th>Section</th><td>{classroom.section || "Not set"}</td></tr><tr><th>Account</th><td><span className="status-dot" />{profile?.role ?? "Teacher"}</td></tr></tbody></table></div> : <div className="empty-chart">Create a classroom to start adding learner records.</div>}
            </article>
          </section>
          {!classroom && <section className="class-empty"><div><strong>Set up your classroom</strong><p>This creates your private class workspace in Supabase.</p>{classError && <p role="alert">{classError === "invalid" ? "Enter a class name and valid grade." : "The classroom could not be saved. Check the Supabase schema and try again."}</p>}</div><form action={createClassroom} className="class-form"><label className="field">Class name<input name="name" placeholder="Class 5 - Sampaguita" maxLength={100} required /></label><label className="field">Grade<select name="grade_level" defaultValue="5">{Array.from({ length: 12 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}</option>)}</select></label><label className="field">Section<input name="section" placeholder="Sampaguita" maxLength={80} /></label><button className="primary-button" type="submit">Create class</button></form></section>}
        </div>
      </section>
    </main>
  );
}