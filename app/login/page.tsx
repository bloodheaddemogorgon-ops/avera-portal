import { redirect } from "next/navigation";
import { signIn } from "@/app/actions/auth";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server-client";

type LoginPageProps = { searchParams: Promise<{ error?: string; registered?: string }> };

export default async function LoginPage({ searchParams }: LoginPageProps) {
  if (!isSupabaseConfigured()) {
    return (
      <main className="auth-layout">
        <section className="auth-story"><span className="eyebrow" style={{ color: "#f2bd78" }}>AVeRA · Class Portal</span><h1>Every learner, seen.</h1><p>A calmer place to keep classroom records, attendance, and progress together.</p></section>
        <section className="auth-panel"><div className="auth-card"><span className="eyebrow">Setup needed</span><h2>Connect Supabase</h2><p>Add the project URL and publishable key to your local environment to enable sign-in.</p><div className="notice">Set <strong>NEXT_PUBLIC_SUPABASE_URL</strong> and <strong>NEXT_PUBLIC_SUPABASE_ANON_KEY</strong> in <strong>.env.local</strong>, then restart the Next.js server.</div><p className="auth-footer">Never put a Supabase service-role key in a <code>NEXT_PUBLIC_</code> variable.</p></div></section>
      </main>
    );
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (user) redirect("/dashboard");

  const { error, registered } = await searchParams;
  return (
    <main className="auth-layout">
      <section className="auth-story">
        <span className="eyebrow" style={{ color: "#f2bd78" }}>AVeRA · Class Portal</span>
        <div><h1>Every learner, seen.</h1><p>Keep attendance, class records, and learner progress in one thoughtful workspace.</p></div>
        <span className="auth-footer" style={{ color: "#c2d6cf" }}>A classroom record system for the work that matters every day.</span>
      </section>
      <section className="auth-panel">
        <div className="auth-card">
          <span className="eyebrow">Welcome back</span>
          <h2>Sign in</h2>
          <p>Use your AVeRA account to continue to your classroom.</p>
          {registered && <div className="notice" role="status">Your account is ready. Check your email if confirmation is enabled for this Supabase project.</div>}
          {error === "invalid" && <div className="notice" role="alert">That email and password combination could not be verified.</div>}
          {error === "missing" && <div className="notice" role="alert">Enter your email and password to continue.</div>}
          <form action={signIn}>
            <label className="field">Email address<input name="email" type="email" autoComplete="email" required /></label>
            <label className="field">Password<input name="password" type="password" autoComplete="current-password" required /></label>
            <button className="primary-button" type="submit">Sign in to your class</button>
          </form>
          <p className="auth-footer">New teacher? <a href="/register">Create an account</a></p>
          <p className="auth-footer">Accounts are managed through your school’s Supabase Auth project. Contact your administrator if you need access.</p>
        </div>
      </section>
    </main>
  );
}