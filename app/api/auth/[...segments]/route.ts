import type { NextRequest } from "next/server";

const allowedMethods = new Map<string, readonly string[]>([
  ["login", ["POST"]],
  ["logout", ["POST"]],
  ["register", ["POST"]],
  ["session", ["GET"]],
]);

async function forwardAuthRequest(
  request: NextRequest,
  context: { params: Promise<{ segments: string[] }> },
) {
  const { segments } = await context.params;
  const endpoint = segments.length === 1 ? segments[0] : "";
  const methods = allowedMethods.get(endpoint);
  if (!methods) {
    return Response.json({ error: "Authentication endpoint not found." }, { status: 404 });
  }
  if (!methods.includes(request.method)) {
    return Response.json({ error: "Method not allowed." }, {
      status: 405,
      headers: { Allow: methods.join(", ") },
    });
  }

  const apiPort = Number(process.env.PORTAL_API_PORT || 3003);
  if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) {
    return Response.json({ error: "PORTAL_API_PORT must be an integer between 1 and 65535." }, { status: 500 });
  }
  const apiBase = new URL(`http://127.0.0.1:${apiPort}`);

  const headers = new Headers({
    "x-portal-entry": "teacher",
  });
  const cookie = request.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);

  let body: ArrayBuffer | undefined;
  if (request.method !== "GET") {
    const declaredLength = Number(request.headers.get("content-length") || 0);
    if (declaredLength > 16_384) {
      return Response.json({ error: "The request is too large." }, { status: 413 });
    }
    body = await request.arrayBuffer();
    if (body.byteLength > 16_384) {
      return Response.json({ error: "The request is too large." }, { status: 413 });
    }
    headers.set("content-type", request.headers.get("content-type") || "application/json");
  }

  let upstream: Response;
  try {
    upstream = await fetch(new URL(`/api/auth/${endpoint}`, apiBase), {
      method: request.method,
      headers,
      body,
      cache: "no-store",
    });
  } catch {
    return Response.json(
      { error: "The local authentication service is unavailable. Start the portal and try again." },
      { status: 502 },
    );
  }

  const responseHeaders = new Headers({
    "cache-control": "no-store",
    "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  const setCookie = upstream.headers.get("set-cookie");
  if (setCookie) responseHeaders.set("set-cookie", setCookie);
  const retryAfter = upstream.headers.get("retry-after");
  if (retryAfter) responseHeaders.set("retry-after", retryAfter);

  return new Response(await upstream.arrayBuffer(), {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export const GET = forwardAuthRequest;
export const POST = forwardAuthRequest;
