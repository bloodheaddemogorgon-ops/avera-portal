"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

type AuthFormProps = {
  mode: "login" | "register";
};

type AuthResponse = {
  error?: string;
};

const grades = Array.from({ length: 12 }, (_, index) => `Grade ${index + 1}`);
const strands = ["STEM", "ABM", "HUMSS", "GAS", "TVL", "Arts and Design", "Sports"];

export default function AuthForm({ mode }: AuthFormProps) {
  const router = useRouter();
  const isRegister = mode === "register";
  const [role, setRole] = useState<"teacher" | "parent">("teacher");
  const [grade, setGrade] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const isSeniorHigh = grade === "Grade 11" || grade === "Grade 12";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setPending(true);

    const formData = new FormData(event.currentTarget);
    const payload = {
      name: String(formData.get("name") || "").trim(),
      email: String(formData.get("email") || "").trim().toLowerCase(),
      password: String(formData.get("password") || ""),
      role,
      extra: role === "parent" ? String(formData.get("classCode") || "").trim() : "",
      grade,
      strand: String(formData.get("strand") || ""),
    };

    try {
      const response = await fetch(`/api/auth/${mode === "register" ? "register" : "login"}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify(payload),
      });
      const result = await response.json() as AuthResponse;
      if (!response.ok) {
        setError(result.error || "Authentication failed. Please try again.");
        return;
      }

      router.replace("/auth/callback");
      router.refresh();
    } catch {
      setError("Could not reach the local authentication service. Check that the portal is running and try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="auth-layout">
      <section className="auth-story">
        <div className="eyebrow">GraceDesk · Class Portal</div>
        <div>
          <h1>Every learner’s progress, in one place.</h1>
          <p>
            {isRegister
              ? "Create a local account to manage classroom records or follow your child’s learning."
              : "Sign in to securely continue to your classroom or your child’s learning updates."}
          </p>
        </div>
        <p className="auth-footer">Your account is stored in this portal’s local SQLite database. Passwords are protected and never saved in browser storage.</p>
      </section>

      <section className="auth-panel">
        <div className="auth-card">
          <span className="eyebrow">{isRegister ? "Get started" : "Welcome back"}</span>
          <h2>{isRegister ? "Create your account" : "Sign in"}</h2>
          <p>{isRegister ? "Choose your account type and enter your details." : "Use the email and password for your portal account."}</p>

          <form onSubmit={submit}>
            <label className="field">
              Account type
              <select
                value={role}
                onChange={(event) => setRole(event.target.value === "parent" ? "parent" : "teacher")}
              >
                <option value="teacher">Teacher</option>
                <option value="parent">Parent / Guardian</option>
              </select>
            </label>

            {isRegister && (
              <label className="field">
                Full name
                <input name="name" type="text" autoComplete="name" maxLength={120} required />
              </label>
            )}

            <label className="field">
              Email
              <input name="email" type="email" autoComplete="email" maxLength={254} required />
            </label>

            <label className="field">
              Password
              <input
                name="password"
                type="password"
                autoComplete={isRegister ? "new-password" : "current-password"}
                minLength={6}
                maxLength={256}
                required
              />
            </label>

            {isRegister && role === "teacher" && (
              <>
                <label className="field">
                  Grade level
                  <select name="grade" value={grade} onChange={(event) => setGrade(event.target.value)} required>
                    <option value="">Choose grade level</option>
                    {grades.map((item) => <option key={item}>{item}</option>)}
                  </select>
                </label>
                {isSeniorHigh && (
                  <label className="field">
                    Senior High School strand
                    <select name="strand" defaultValue="" required>
                      <option value="">Choose strand</option>
                      {strands.map((strand) => <option key={strand}>{strand}</option>)}
                    </select>
                  </label>
                )}
              </>
            )}

            {isRegister && role === "parent" && (
              <label className="field">
                Class code
                <input name="classCode" autoComplete="off" maxLength={100} required />
                <span>Ask your child’s teacher for the class code.</span>
              </label>
            )}

            {error && <p className="notice" role="alert">{error}</p>}
            <button className="primary-button" type="submit" disabled={pending}>
              {pending
                ? (isRegister ? "Saving account…" : "Signing in…")
                : (isRegister ? "Create account" : "Sign in")}
            </button>
          </form>

          <p className="auth-footer">
            {isRegister ? "Already have an account? " : "New to GraceDesk? "}
            <Link href={isRegister ? "/login" : "/register"}>
              {isRegister ? "Sign in" : "Create an account"}
            </Link>
          </p>
        </div>
      </section>
    </main>
  );
}
