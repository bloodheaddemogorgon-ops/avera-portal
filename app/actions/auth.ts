"use server";

import { redirect } from "next/navigation";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server-client";

export async function signUp(formData: FormData) {
  if (!isSupabaseConfigured()) redirect("/register?error=config");

  const displayName = String(formData.get("display_name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!displayName || !email || password.length < 12) redirect("/register?error=invalid");

  const supabase = await createClient();
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { display_name: displayName },
      emailRedirectTo: new URL("/auth/callback", siteUrl).toString(),
    },
  });
  if (error) {
    const message = error.message.toLowerCase();
    console.error("Supabase sign-up failed:", error.message);
    if (message.includes("already registered") || error.code === "user_already_exists") {
      redirect("/register?error=exists");
    }
    if (message.includes("email") && message.includes("rate")) {
      redirect("/register?error=rate-limit");
    }
    redirect("/register?error=signup");
  }
  if (data.session) redirect("/dashboard");
  redirect("/login?registered=1");
}

export async function signIn(formData: FormData) {
  if (!isSupabaseConfigured()) redirect("/login?error=config");

  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) redirect("/login?error=missing");

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    const message = error.message.toLowerCase();
    console.error("Supabase sign-in failed:", error.message);
    if (message.includes("email not confirmed")) {
      redirect("/login?error=unconfirmed");
    }
    redirect("/login?error=invalid");
  }
  redirect("/dashboard");
}

export async function signOut() {
  if (!isSupabaseConfigured()) redirect("/login");
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}