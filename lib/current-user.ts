import { cookies } from "next/headers";
import { portalRequest, type PortalRequestIdentity } from "@/lib/portal-api";

const MOCK_USER_ID = "dev-user-123";
const TEACHER_SESSION_COOKIE = "grade5_session_teacher";

export async function getCurrentUser(): Promise<PortalRequestIdentity & { userId: string }> {
  if (process.env.NODE_ENV !== "production") {
    return { userId: MOCK_USER_ID };
  }

  const sessionCookie = (await cookies()).get(TEACHER_SESSION_COOKIE);
  if (!sessionCookie?.value) throw new Error("Unauthorized");

  const identity = {
    sessionCookie: `${TEACHER_SESSION_COOKIE}=${sessionCookie.value}`,
  };
  const { user } = await portalRequest<{
    user?: { userId?: string; role?: string };
  }>("/api/auth/session", identity);

  if (!user?.userId || user.role !== "teacher") throw new Error("Unauthorized");
  return { ...identity, userId: user.userId };
}
