"use strict";

require("dotenv").config();

const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { URL } = require("node:url");

const ROOT_DIRECTORY = __dirname;
const INDEX_PATH = path.join(ROOT_DIRECTORY, "index.html");
const APP_VERSION = require("./package.json").version;
const PORTAL_ENTRIES = new Map([
  ["teacher", "main"],
  ["parents", "parents"],
  ["admin", "admin"],
]);
const STATIC_ASSETS = new Map([
  ["/icon.png", { filename: "icon.png", contentType: "image/png" }],
  ["/sf10-deped-seal.png", { filename: "sf10-deped-seal.png", contentType: "image/png" }],
  ["/sf10-deped-logo.gif", { filename: "sf10-deped-logo.gif", contentType: "image/gif" }],
]);
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const DEFAULT_PORTS = {
  teacher: 3004,
  parents: 3005,
  admin: 3006,
};

function sendJson(response, status, body) {
  const content = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": content.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(content);
}

function escapeHtmlAttribute(value) {
  return String(value).replace(/[&"<>]/g, (character) => ({
    "&": "&amp;",
    "\"": "&quot;",
    "<": "&lt;",
    ">": "&gt;",
  })[character]);
}

function normalizePortalUrl(value, fallback) {
  const portalUrl = value || fallback;
  if (portalUrl.startsWith("/") && !portalUrl.startsWith("//")) return portalUrl;
  const parsedUrl = new URL(portalUrl);
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("Portal URLs must use HTTP or HTTPS.");
  }
  return portalUrl;
}

function getLastHeaderValue(request, headerName) {
  const header = request.headers[headerName];
  const value = Array.isArray(header) ? header.join(",") : header;
  return typeof value === "string" ? value.split(",").pop().trim() : "";
}

// In combined mode one process serves every portal; API calls carry no entry in their path,
// so the portal is identified from the page that issued the (same-origin) request.
function getEntryFromPath(pathname) {
  const segment = pathname.split("/")[1] || "";
  const name = segment.replace(/\.html$/, "");
  if (name === "" || name === "index" || name === "teacher") return "teacher";
  return name === "parents" || name === "admin" ? name : null;
}

function getRequestEntry(request) {
  try {
    const referer = request.headers.referer;
    if (referer) return getEntryFromPath(new URL(referer).pathname) || "teacher";
  } catch {
    // An unparsable Referer falls back to the teacher portal cookie.
  }
  return "teacher";
}

function getPortalUrls(options) {
  if (options.entry === "all") {
    return { teacher: "/", parents: "/parents", admin: "/admin" };
  }
  const publicHost = process.env.PORTAL_PUBLIC_HOST || "127.0.0.1";
  const formatHost = publicHost.includes(":") && !publicHost.startsWith("[")
    ? `[${publicHost}]`
    : publicHost;
  const protocol = process.env.PORTAL_TLS_KEY ? "https" : "http";
  const defaults = Object.fromEntries(
    Object.entries(DEFAULT_PORTS).map(([entry, port]) => {
      const configuredPort = Number(process.env[`PORTAL_${entry.toUpperCase()}_PORT`] || port);
      return [entry, `${protocol}://${formatHost}:${configuredPort}`];
    }),
  );
  const configuredUrls = options.portalUrls || {};
  return {
    teacher: normalizePortalUrl(configuredUrls.teacher || process.env.PORTAL_TEACHER_URL, defaults.teacher),
    parents: normalizePortalUrl(configuredUrls.parents || process.env.PORTAL_PARENTS_URL, defaults.parents),
    admin: normalizePortalUrl(configuredUrls.admin || process.env.PORTAL_ADMIN_URL, defaults.admin),
  };
}

function renderPortalPage(entry, portalUrls) {
  const htmlEntry = PORTAL_ENTRIES.get(entry);
  if (!htmlEntry) throw new Error(`Unknown portal entry: ${entry}`);
  return fsPromises.readFile(INDEX_PATH, "utf8").then((source) => {
    let html = source.replace(
      'data-portal-entry="main"',
      `data-portal-entry="${htmlEntry}"`,
    );
    const destinations = {
      main: portalUrls.teacher,
      parents: portalUrls.parents,
      admin: portalUrls.admin,
    };
    for (const [linkEntry, destination] of Object.entries(destinations)) {
      const escapedUrl = escapeHtmlAttribute(destination);
      const linkPattern = new RegExp(
        `(<a class="portal-entry-link" data-entry="${linkEntry}" href=")[^"]*(")`,
      );
      html = html.replace(linkPattern, (match, prefix, suffix) => `${prefix}${escapedUrl}${suffix}`);
    }
    if (entry === "admin") {
      html = html.replace(
        '<button class="tab" role="tab" data-mode="up"',
        '<button class="tab" role="tab" data-mode="up" hidden',
      );
    }
    return html.replace(
      /(<span class="sidebar-footer-version">GraceDesk · Version )[^<]*(<\/span>)/,
      `$1${APP_VERSION}$2`,
    );
  });
}

function filterHopByHopHeaders(headers) {
  const filteredHeaders = { ...headers };
  for (const headerName of HOP_BY_HOP_HEADERS) {
    delete filteredHeaders[headerName];
  }
  return filteredHeaders;
}

function proxyApiRequest(request, response, backendUrl, entry, trustProxy) {
  const transport = backendUrl.protocol === "https:" ? https : http;
  const requestHeaders = filterHopByHopHeaders(request.headers);
  requestHeaders.host = backendUrl.host;
  requestHeaders["x-portal-entry"] = entry === "all" ? getRequestEntry(request) : entry;
  if (trustProxy) {
    // Pass the real client through so the API's sign-in throttling and Secure cookies work
    // even though this hop may use the platform's private HTTP network.
    requestHeaders["x-forwarded-for"] = getLastHeaderValue(request, "x-forwarded-for")
      || request.socket.remoteAddress || "unknown";
    requestHeaders["x-forwarded-proto"] = getLastHeaderValue(request, "x-forwarded-proto") === "https"
      ? "https" : "http";
  }
  const upstreamRequest = transport.request({
    protocol: backendUrl.protocol,
    hostname: backendUrl.hostname,
    port: backendUrl.port,
    method: request.method,
    path: request.url,
    headers: requestHeaders,
  }, (upstreamResponse) => {
    response.writeHead(
      upstreamResponse.statusCode || 502,
      filterHopByHopHeaders(upstreamResponse.headers),
    );
    upstreamResponse.pipe(response);
  });
  upstreamRequest.on("error", (error) => {
    console.error(`The ${entry} portal could not reach the shared API backend:`, error.message);
    if (!response.headersSent) {
      sendJson(response, 502, { error: "The shared API backend is unavailable." });
    } else {
      response.destroy();
    }
  });
  request.pipe(upstreamRequest);
}

function createPortalFrontendServer(options = {}) {
  const entry = options.entry;
  if (entry !== "all" && !PORTAL_ENTRIES.has(entry)) {
    throw new Error("PORTAL_ENTRY must be teacher, parents, admin, or all.");
  }
  const trustProxy = options.trustProxy ?? process.env.PORTAL_TRUST_PROXY === "true";
  const rawBackendUrl = options.backendUrl || process.env.PORTAL_API_URL || "http://127.0.0.1:3003";
  // Render's private-network host:port value has no scheme.
  const backendUrl = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(rawBackendUrl) ? rawBackendUrl : `http://${rawBackendUrl}`);
  if (backendUrl.protocol !== "http:" && backendUrl.protocol !== "https:") {
    throw new Error("PORTAL_API_URL must use HTTP or HTTPS.");
  }
  const portalUrls = getPortalUrls(options);
  const tlsKeyPath = options.tlsKeyPath || process.env.PORTAL_TLS_KEY || null;
  const tlsCertPath = options.tlsCertPath || process.env.PORTAL_TLS_CERT || null;
  if ((tlsKeyPath && !tlsCertPath) || (!tlsKeyPath && tlsCertPath)) {
    throw new Error("PORTAL_TLS_KEY and PORTAL_TLS_CERT must be provided together.");
  }
  const entryPaths = new Set(["/", "/index.html", `/${entry}`, `/${entry}.html`]);

  const requestHandler = async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      if (url.pathname.startsWith("/api/")) {
        proxyApiRequest(request, response, backendUrl, entry, trustProxy);
        return;
      }

      const pageEntry = entry === "all" ? getEntryFromPath(url.pathname) : entry;
      const isPage = entry === "all"
        ? Boolean(pageEntry) && url.pathname.split("/").length <= 2
        : entryPaths.has(url.pathname);
      if (request.method === "GET" && isPage) {
        const html = await renderPortalPage(pageEntry, portalUrls);
        const content = Buffer.from(html);
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": content.length,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(content);
        return;
      }

      const asset = request.method === "GET" ? STATIC_ASSETS.get(url.pathname) : null;
      if (asset) {
        const content = await fsPromises.readFile(path.join(ROOT_DIRECTORY, asset.filename));
        response.writeHead(200, {
          "Content-Type": asset.contentType,
          "Content-Length": content.length,
          "Cache-Control": "public, max-age=86400",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(content);
        return;
      }

      sendJson(response, 404, { error: "Page not found." });
    } catch (error) {
      console.error(`The ${entry} portal could not serve the request:`, error);
      sendJson(response, 500, { error: "The portal page could not be served." });
    }
  };

  return tlsKeyPath
    ? https.createServer({
      key: fs.readFileSync(tlsKeyPath),
      cert: fs.readFileSync(tlsCertPath),
    }, requestHandler)
    : http.createServer(requestHandler);
}

if (require.main === module) {
  const entry = process.argv[2];
  const entryName = entry ? entry.toUpperCase() : "";
  const port = Number(
    process.env[`PORTAL_${entryName}_PORT`]
      || (entry === "all" ? process.env.PORT : null)
      || DEFAULT_PORTS[entry],
  );
  const host = process.env.HOST || "127.0.0.1";
  const trustProxy = process.env.PORTAL_TRUST_PROXY === "true";
  const tlsKeyPath = process.env.PORTAL_TLS_KEY;
  const tlsCertPath = process.env.PORTAL_TLS_CERT;
  const isLoopbackHost = ["127.0.0.1", "localhost", "::1"].includes(host);

  if (entry !== "all" && !PORTAL_ENTRIES.has(entry)) {
    console.error("Choose a frontend server: teacher, parents, admin, or all.");
    process.exitCode = 1;
  } else if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`Invalid ${entry} portal port: ${process.env[`PORTAL_${entryName}_PORT`]}`);
    process.exitCode = 1;
  } else if (!isLoopbackHost && !trustProxy && (!tlsKeyPath || !tlsCertPath)) {
    console.error("Refusing insecure public binding. Set PORTAL_TLS_KEY and PORTAL_TLS_CERT, set PORTAL_TRUST_PROXY=true behind an HTTPS proxy, or bind to localhost.");
    process.exitCode = 1;
  } else {
    const server = createPortalFrontendServer({ entry });
    server.once("error", (error) => {
      console.error(`Could not start the ${entry} portal on ${host}:${port}:`, error.message);
      process.exitCode = 1;
    });
    server.listen(port, host, () => {
      console.log(`${entry[0].toUpperCase()}${entry.slice(1)} Portal is running at ${tlsKeyPath ? "https" : "http"}://${host}:${port}`);
    });
  }
}

module.exports = { createPortalFrontendServer };
