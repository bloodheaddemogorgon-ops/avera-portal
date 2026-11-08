"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/current-user";
import { portalRequest } from "@/lib/portal-api";

export type Classroom = {
  id: string;
  classroom: string;
  classCode: string;
  grade: string;
  strand: string;
  section: string;
};

export type ClassroomInput = {
  classroom: string;
  grade: string;
  strand?: string;
  section?: string;
};

// Every action: 1) resolve the user on the server, 2) send only that identity,
// 3) let the API filter by Teacher User ID. Ownership is never taken from the arguments.

export async function createClassroom(input: ClassroomInput): Promise<Classroom> {
  const identity = await getCurrentUser();
  const { classroom } = await portalRequest<{ classroom: Classroom }>("/api/classrooms", identity, {
    method: "POST",
    body: input,
  });
  revalidatePath("/dashboard");
  return classroom;
}

export async function listClassrooms(): Promise<Classroom[]> {
  const identity = await getCurrentUser();
  const { classrooms } = await portalRequest<{ classrooms: Classroom[] }>("/api/classrooms", identity);
  return classrooms;
}

export async function getClassroom(classId: string): Promise<Classroom> {
  const identity = await getCurrentUser();
  const { classroom } = await portalRequest<{ classroom: Classroom }>(
    `/api/classrooms/${encodeURIComponent(classId)}`,
    identity,
  );
  return classroom;
}

export async function updateClassroom(
  classId: string,
  changes: Partial<ClassroomInput>,
): Promise<Classroom> {
  const identity = await getCurrentUser();
  const { classroom } = await portalRequest<{ classroom: Classroom }>(
    `/api/classrooms/${encodeURIComponent(classId)}`,
    identity,
    { method: "PATCH", body: changes },
  );
  revalidatePath("/dashboard");
  return classroom;
}

export async function deleteClassroom(classId: string): Promise<void> {
  const identity = await getCurrentUser();
  await portalRequest(`/api/classrooms/${encodeURIComponent(classId)}`, identity, { method: "DELETE" });
  revalidatePath("/dashboard");
}
