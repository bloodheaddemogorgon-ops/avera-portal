"use strict";

require("dotenv").config();

const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const crypto = require("node:crypto");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { URL } = require("node:url");
const zlib = require("node:zlib");

const ROOT_DIRECTORY = __dirname;
const INDEX_PATH = path.join(ROOT_DIRECTORY, "index.html");
const APP_VERSION = require("./package.json").version;
const COMPRESSED_CONTENT_CACHE = new Map();
const PORTAL_ENTRIES = new Map([
  ["teacher", "main"],
  ["parents", "parents"],
]);
const STATIC_ASSETS = new Map([
  ["/favicon.png", { filename: "favicon.png", contentType: "image/png" }],
  ["/icon.png", { filename: "icon.png", contentType: "image/png" }],
  ["/sf10-deped-seal.png", { filename: "sf10-deped-seal.png", contentType: "image/png" }],
  ["/sf10-deped-logo.gif", { filename: "sf10-deped-logo.gif", contentType: "image/gif" }],
  ["/assets/jspdf.umd.min.js", {
    filename: path.join("node_modules", "jspdf", "dist", "jspdf.umd.min.js"),
    contentType: "text/javascript; charset=utf-8",
  }],
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
};

function getAcceptedContentEncoding(request) {
  const header = request.headers["accept-encoding"];
  if (typeof header !== "string" || !header.trim()) return "identity";

  const qualities = new Map();
  for (const item of header.toLowerCase().split(",")) {
    const [encoding, ...parameters] = item.trim().split(";");
    if (!encoding) continue;
    let quality = 1;
    for (const parameter of parameters) {
      const match = /^q\s*=\s*(.+)$/i.exec(parameter.trim());
      if (match) {
        const parsedQuality = Number(match[1]);
        quality = Number.isFinite(parsedQuality) && parsedQuality >= 0 && parsedQuality <= 1
          ? parsedQuality
          : 0;
      }
    }
    qualities.set(encoding, quality);
  }

  const wildcardQuality = qualities.get("*");
  const qualityFor = (encoding) => qualities.has(encoding)
    ? qualities.get(encoding)
    : wildcardQuality || 0;
  const identityQuality = qualities.has("identity")
    ? qualities.get("identity")
    : wildcardQuality === 0 ? 0 : 1;
  const brotliQuality = qualityFor("br");
  const gzipQuality = qualityFor("gzip");

  if (brotliQuality > 0 && brotliQuality >= gzipQuality && brotliQuality >= identityQuality) {
    return "br";
  }
  if (gzipQuality > 0 && gzipQuality >= identityQuality) return "gzip";
  return "identity";
}

function getCompressedContent(content, encoding) {
  const contentHash = crypto.createHash("sha256").update(content).digest("hex");
  const cacheKey = `${encoding}:${contentHash}`;
  const cachedContent = COMPRESSED_CONTENT_CACHE.get(cacheKey);
  if (cachedContent) return cachedContent;

  const compressedContent = encoding === "br"
    ? zlib.brotliCompressSync(content, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 },
    })
    : zlib.gzipSync(content);
  COMPRESSED_CONTENT_CACHE.set(cacheKey, compressedContent);
  return compressedContent;
}

function sendTextResponse(request, response, status, contentType, cacheControl, content) {
  const encoding = getAcceptedContentEncoding(request);
  const responseContent = encoding === "identity"
    ? content
    : getCompressedContent(content, encoding);

  const headers = {
    "Content-Type": contentType,
    "Content-Length": responseContent.length,
    "Cache-Control": cacheControl,
    "X-Content-Type-Options": "nosniff",
    Vary: "Accept-Encoding",
  };
  if (encoding !== "identity") headers["Content-Encoding"] = encoding;
  response.writeHead(status, headers);
  response.end(responseContent);
}

function sendJson(request, response, status, body) {
  const content = Buffer.from(JSON.stringify(body));
  sendTextResponse(
    request,
    response,
    status,
    "application/json; charset=utf-8",
    "no-store",
    content,
  );
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
  return name === "parents" ? name : null;
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

function renderPortalPage(entry) {
  const htmlEntry = PORTAL_ENTRIES.get(entry);
  if (!htmlEntry) throw new Error(`Unknown portal entry: ${entry}`);
  return fsPromises.readFile(INDEX_PATH, "utf8").then((source) => {
    let html = source.replace(
      'data-portal-entry="main"',
      `data-portal-entry="${htmlEntry}"`,
    );
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
      sendJson(request, response, 502, { error: "The shared API backend is unavailable." });
    } else {
      response.destroy();
    }
  });
  request.pipe(upstreamRequest);
}

function createPortalFrontendServer(options = {}) {
  const entry = options.entry;
  if (entry !== "all" && !PORTAL_ENTRIES.has(entry)) {
    throw new Error("PORTAL_ENTRY must be teacher, parents, or all.");
  }
  const trustProxy = options.trustProxy ?? process.env.PORTAL_TRUST_PROXY === "true";
  const rawBackendUrl = options.backendUrl || process.env.PORTAL_API_URL || "http://127.0.0.1:3003";
  // Render's private-network host:port value has no scheme.
  const backendUrl = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(rawBackendUrl) ? rawBackendUrl : `http://${rawBackendUrl}`);
  if (backendUrl.protocol !== "http:" && backendUrl.protocol !== "https:") {
    throw new Error("PORTAL_API_URL must use HTTP or HTTPS.");
  }
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
        const html = await renderPortalPage(pageEntry);
        const content = Buffer.from(html);
        sendTextResponse(
          request,
          response,
          200,
          "text/html; charset=utf-8",
          "no-store",
          content,
        );
        return;
      }

      const asset = request.method === "GET" ? STATIC_ASSETS.get(url.pathname) : null;
      if (asset) {
        const content = await fsPromises.readFile(path.join(ROOT_DIRECTORY, asset.filename));
        if (asset.contentType.startsWith("text/")) {
          sendTextResponse(
            request,
            response,
            200,
            asset.contentType,
            "public, max-age=86400",
            content,
          );
          return;
        }
        response.writeHead(200, {
          "Content-Type": asset.contentType,
          "Content-Length": content.length,
          "Cache-Control": "public, max-age=86400",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(content);
        return;
      }

      sendJson(request, response, 404, { error: "Page not found." });
    } catch (error) {
      console.error(`The ${entry} portal could not serve the request:`, error);
      sendJson(request, response, 500, { error: "The portal page could not be served." });
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
    console.error("Choose a frontend server: teacher, parents, or all.");
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
