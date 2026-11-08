type RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
};

export type PortalRequestIdentity = {
  userId?: string;
  sessionCookie?: string;
};

// The API authenticates production callers from their teacher session and re-checks ownership.
export async function portalRequest<T>(
  path: string,
  identity: PortalRequestIdentity,
  { method = "GET", body }: RequestOptions = {},
): Promise<T> {
  const port = Number(process.env.PORTAL_API_PORT || 3003);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORTAL_API_PORT must be an integer between 1 and 65535.");
  }

  const headers: Record<string, string> = {};
  if (identity.sessionCookie) {
    headers.cookie = identity.sessionCookie;
    headers["x-portal-entry"] = "teacher";
  } else if (process.env.NODE_ENV === "production") {
    throw new Error("Unauthorized");
  } else if (identity.userId) {
    headers["x-dev-user-id"] = identity.userId;
  } else {
    throw new Error("Unauthorized");
  }
  if (body !== undefined) headers["content-type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    throw new Error("The local portal service is unavailable.");
  }

  const result = await response.json().catch(() => ({})) as { error?: string };
  if (response.status === 401 || response.status === 403) throw new Error("Unauthorized");
  if (!response.ok) throw new Error(result.error || "The request could not be completed.");
  return result as T;
}
