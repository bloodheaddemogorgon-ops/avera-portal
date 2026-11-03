type RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
};

// Calls the local SQLite-backed API on loopback, identifying the caller by userId.
// The API re-checks ownership itself, so a bug here cannot expose another user's records.
export async function portalRequest<T>(
  path: string,
  userId: string,
  { method = "GET", body }: RequestOptions = {},
): Promise<T> {
  const port = Number(process.env.PORTAL_API_PORT || 3003);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORTAL_API_PORT must be an integer between 1 and 65535.");
  }

  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        "x-dev-user-id": userId,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
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
