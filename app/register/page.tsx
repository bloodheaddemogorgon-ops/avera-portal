import Link from "next/link";
import { signUp } from "@/app/actions/auth";

type RegisterPageProps = { searchParams: Promise<{ error?: string }> };

export default async function RegisterPage({ searchParams }: RegisterPageProps) {
  const { error } = await searchParams;
  return (
    <main className="auth-layout">
      <section className="auth-story"><span className="eyebrow" style={{ color: "#f2bd78" }}>AVeRA · Class Portal</span><div><h1>Your class, in good order.</h1><p>Create a teacher account, then set up a private classroom workspace.</p></div><span className="auth-footer" style={{ color: "#c2d6cf" }}>Learner information is protected by Supabase row-level security.</span></section>
      <section className="auth-panel"><div className="auth-card"><span className="eyebrow">Teacher access</span><h2>Create account</h2><p>Use your school email address. You can add your class after signing in.</p>
        {error && <div className="notice" role="alert">{error === "invalid" ? "Enter your name and email, and choose a password with at least 12 characters." : "We could not create that account. The email may already be registered."}</div>}
        <form action={signUp}>
          <label className="field">Full name<input name="display_name" autoComplete="name" maxLength={120} required /></label>
          <label className="field">School email<input name="email" type="email" autoComplete="email" required /></label>
          <label className="field">Password<input name="password" type="password" autoComplete="new-password" minLength={12} required /></label>
          <button className="primary-button" type="submit">Create teacher account</button>
        </form>
        <p className="auth-footer">Already registered? <Link href="/login">Sign in</Link></p>
      </div></section>
    </main>
  );
}