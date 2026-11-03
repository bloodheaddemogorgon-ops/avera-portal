// Single swap point for identity. Every Server Action gets its user from here and never from client input.
// TODO: replace with the signed-in session user once authentication is wired to Server Actions.
const MOCK_USER_ID = "dev-user-123";

export async function getCurrentUserId(): Promise<string> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Unauthorized");
  }
  return MOCK_USER_ID;
}
