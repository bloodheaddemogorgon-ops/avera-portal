"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

type PortalUser = {
  name: string;
  role: string;
  classCode?: string;
  mustChangePassword?: boolean;
};

export default function DashboardHome() {
  const router = useRouter();
  const [user, setUser] = useState<PortalUser | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        if (response.status === 401) {
          router.replace("/login");
          return null;
        }
        const result = await response.json() as { user?: PortalUser; error?: string };
        if (!response.ok) throw new Error(result.error || "Could not verify your session.");
        return result.user || null;
      })
      .then((sessionUser) => {
        if (active && sessionUser) setUser(sessionUser);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "Could not verify your session.");
      });

    return () => {
      active = false;
    };
  }, [router]);

  async function signOut() {
    setError("");
    try {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) {
        const result = await response.json() as { error?: string };
        throw new Error(result.error || "Could not sign out.");
      }
      router.replace("/login");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sign out.");
    }
  }

  if (error) {
    return <main className="auth-panel"><p className="notice" role="alert">{error}</p></main>;
  }
  if (!user) {
    return <main className="auth-panel" aria-live="polite">Checking your local account…</main>;
  }

  return (
    <div className="portal-shell">
      <aside className="portal-sidebar">
        <div className="brand-lockup"><img className="brand-mark" src="/icon.png" alt="GraceDesk" /><span>GraceDesk</span></div>
        <div className="side-caption">Account</div>
        <div className="side-link" aria-current="page"><span className="side-symbol">◈</span>Overview</div>
        <div className="sidebar-bottom">Saved in the local portal database.</div>
      </aside>
      <div className="main-column">
        <header className="topbar">
          <div>
            <div className="topbar-label">Signed in as</div>
            <div className="topbar-name">{user.name}</div>
          </div>
          <button className="quiet-button" type="button" onClick={signOut}>Sign out</button>
        </header>
        <main className="content">
          <div className="page-heading">
            <div>
              <span className="eyebrow">{user.role === "parent" ? "Family access" : "Classroom access"}</span>
              <h1>Welcome, {user.name}</h1>
              <p>Your local account is signed in and ready.</p>
            </div>
          </div>
          {user.mustChangePassword && (
            <p className="notice" role="status">Your account requires a password change before you can access portal records.</p>
          )}
          {user.classCode && <section className="panel"><h2>Connected class</h2><p className="panel-subtitle">{user.classCode}</p></section>}
        </main>
      </div>
    </div>
  );
}
