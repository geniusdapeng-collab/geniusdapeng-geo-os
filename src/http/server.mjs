import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { ApiError } from "../domain/errors.mjs";

const MIME_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
});

function securityHeaders() {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) {
      throw new ApiError(413, "BODY_TOO_LARGE", "请求体超过 1 MB。");
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "INVALID_JSON", "请求体不是有效 JSON。");
  }
}

function writeJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    ...securityHeaders(),
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function methodNotAllowed(response, allow) {
  response.writeHead(405, {
    ...securityHeaders(),
    Allow: allow.join(", "),
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify({ error: { code: "METHOD_NOT_ALLOWED", message: "方法不允许。" } }));
}

async function serveStatic(request, response, publicDir, pathname) {
  if (!["GET", "HEAD"].includes(request.method)) {
    methodNotAllowed(response, ["GET", "HEAD"]);
    return;
  }

  const requested = pathname === "/" ? "/index.html" : pathname;
  const relative = requested.replace(/^\/+/, "");
  const filePath = resolve(publicDir, normalize(relative));
  const root = resolve(publicDir);
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
    throw new ApiError(404, "NOT_FOUND", "资源不存在。");
  }

  let info;
  try {
    info = await stat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new ApiError(404, "NOT_FOUND", "资源不存在。");
    }
    throw error;
  }

  if (!info.isFile()) {
    throw new ApiError(404, "NOT_FOUND", "资源不存在。");
  }

  const headers = {
    ...securityHeaders(),
    "Content-Type": MIME_TYPES[extname(filePath)] ?? "application/octet-stream",
    "Content-Length": info.size,
    "Cache-Control": "no-cache",
  };
  response.writeHead(200, headers);
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(filePath).pipe(response);
}

export function createGeoOsServer({ service, publicDir }) {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;

    try {
      if (path === "/api/health") {
        if (request.method !== "GET") {
          methodNotAllowed(response, ["GET"]);
          return;
        }
        writeJson(response, 200, {
          ok: true,
          service: "geniusdapeng-geo-os",
          summary: service.summary(),
        });
        return;
      }

      if (path === "/api/bootstrap") {
        if (request.method !== "GET") {
          methodNotAllowed(response, ["GET"]);
          return;
        }
        writeJson(response, 200, service.bootstrap());
        return;
      }

      if (path === "/api/summary") {
        if (request.method !== "GET") {
          methodNotAllowed(response, ["GET"]);
          return;
        }
        writeJson(response, 200, service.summary());
        return;
      }

      if (path === "/api/events") {
        if (request.method !== "GET") {
          methodNotAllowed(response, ["GET"]);
          return;
        }
        writeJson(response, 200, service.events(url.searchParams.get("limit")));
        return;
      }

      if (path === "/api/exports/public-preview") {
        if (request.method !== "GET") {
          methodNotAllowed(response, ["GET"]);
          return;
        }
        writeJson(response, 200, service.publicPreview());
        return;
      }

      if (path === "/api/claims" && request.method === "GET") {
        writeJson(response, 200, service.bootstrap().claims);
        return;
      }

      const claimApprovalMatch = path.match(/^\/api\/claims\/([^/]+)\/approve$/);
      if (claimApprovalMatch) {
        if (request.method !== "POST") {
          methodNotAllowed(response, ["POST"]);
          return;
        }
        const result = await service.approveClaim(
          decodeURIComponent(claimApprovalMatch[1]),
          await readJsonBody(request),
        );
        writeJson(response, 200, result);
        return;
      }

      if (path === "/api/content" && request.method === "GET") {
        writeJson(response, 200, service.bootstrap().content);
        return;
      }

      if (path === "/api/content" && request.method === "POST") {
        writeJson(response, 201, await service.createContent(await readJsonBody(request)));
        return;
      }

      const transitionMatch = path.match(/^\/api\/content\/([^/]+)\/transition$/);
      if (transitionMatch) {
        if (request.method !== "POST") {
          methodNotAllowed(response, ["POST"]);
          return;
        }
        const result = await service.transitionContent(
          decodeURIComponent(transitionMatch[1]),
          await readJsonBody(request),
        );
        writeJson(response, 200, result);
        return;
      }

      if (path === "/api/publications/manual") {
        if (request.method !== "POST") {
          methodNotAllowed(response, ["POST"]);
          return;
        }
        writeJson(response, 201, await service.recordPublication(await readJsonBody(request)));
        return;
      }

      if (path === "/api/interactions/classify") {
        if (request.method !== "POST") {
          methodNotAllowed(response, ["POST"]);
          return;
        }
        writeJson(response, 200, service.classifyInteraction(await readJsonBody(request)));
        return;
      }

      if (path === "/api/interactions") {
        if (request.method === "POST") {
          writeJson(response, 201, await service.createInteraction(await readJsonBody(request)));
          return;
        }
        if (request.method === "GET") {
          writeJson(response, 200, service.bootstrap().interactions);
          return;
        }
        methodNotAllowed(response, ["GET", "POST"]);
        return;
      }

      if (path === "/api/geo/queries") {
        if (request.method === "GET") {
          writeJson(response, 200, service.bootstrap().queries);
          return;
        }
        if (request.method === "POST") {
          writeJson(response, 201, await service.createQuery(await readJsonBody(request)));
          return;
        }
        methodNotAllowed(response, ["GET", "POST"]);
        return;
      }

      if (path === "/api/geo/observations") {
        if (request.method === "GET") {
          writeJson(response, 200, service.bootstrap().observations);
          return;
        }
        if (request.method === "POST") {
          writeJson(response, 201, await service.recordObservation(await readJsonBody(request)));
          return;
        }
        methodNotAllowed(response, ["GET", "POST"]);
        return;
      }

      if (path === "/api/geo/metrics") {
        if (request.method !== "GET") {
          methodNotAllowed(response, ["GET"]);
          return;
        }
        writeJson(response, 200, service.metrics());
        return;
      }

      if (path.startsWith("/api/")) {
        throw new ApiError(404, "API_NOT_FOUND", "接口不存在。");
      }

      await serveStatic(request, response, publicDir, path);
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 500;
      const payload =
        error instanceof ApiError
          ? {
              error: {
                code: error.code,
                message: error.message,
                details: error.details,
              },
            }
          : { error: { code: "INTERNAL_ERROR", message: "服务处理失败。" } };

      if (!(error instanceof ApiError)) {
        console.error(
          `request failed: ${request.method} ${path} ${error?.name || "Error"} ${error?.code || ""}`,
        );
      }
      writeJson(response, status, payload);
    }
  });
}
