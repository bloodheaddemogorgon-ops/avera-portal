"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server-client";

export async function createClassroom(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  const gradeLevel = Number(formData.get("grade_level"));
  const section = String(formData.get("section") ?? "").trim();
  if (!name || !Number.isInteger(gradeLevel) || gradeLevel < 1 || gradeLevel > 12) {
    redirect("/dashboard?classError=invalid");
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { error } = await supabase.from("classrooms").insert({
    owner_id: user.id,
    name,
    grade_level: gradeLevel,
    section: section || null,
  });
  if (error) redirect("/dashboard?classError=save");

  revalidatePath("/dashboard");
  redirect("/dashboard");
}