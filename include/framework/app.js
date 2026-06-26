import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";

export default {
  ok,
  error,
  redirect,
  create_app,
};

function parse_cookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  return Object.fromEntries(
    header.split(";").map((c) =>
      c
        .trim()
        .split("=")
        .map((s) => s.trim()),
    ),
  );
}

function get_mime(file) {
  const ext = path.extname(file);
  return (
    {
      ".css": "text/css",
      ".js": "application/javascript",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
    }[ext] ?? "text/plain"
  );
}

function parse_body(req) {
  return new Promise((resolve) => {
    if (req.method !== "POST") return resolve({});
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(Object.fromEntries(new URLSearchParams(body))));
  });
}

export function ok(data) {
  return {
    status: "ok",
    ...(typeof data == "string" ? { data } : data),
  };
}

export function redirect(url) {
  return {
    status: "redirect",
    url,
  };
}

export function error(code, html) {
  return {
    status: "error",
    code,
    html,
  };
}

export function app_create(config) {
  const parse_routes = (routes) => {
    return Object.fromEntries(
      Object.entries(routes ?? {}).map(([path, route]) => [
        path,
        typeof route === "function"
          ? [route]
          : [...(route.check ?? []), route.route],
      ]),
    );
  };

  const routes = {
    GET: {
      ...parse_routes(config.get),
      public: [
        (req) => {
          const file = req.params.file;
          return fs.existsSync(file)
            ? app_ok({
                data: fs.readFileSync(file),
                headers: { "Content-Type": get_mime(file) },
              })
            : null;
        },
      ],
    },
    POST: parse_routes(config.post),
  };

  const sessions = new Map();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost`);
    const route = (() => {
      if (method === "GET" && url.pathname.startsWith("/public/")) {
        req.params.file = path.join(
          "public",
          url.pathname.slice("/public/".length),
        );
        return routes.GET.public;
      }
      return routes[req.method]?.[url.pathname];
    })();

    if (!route) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    req.params = Object.fromEntries(url.searchParams);
    req.body = await parse_body(req);
    req.cookies = parse_cookies(req);
    req._session_token = req.cookies.session;
    req.session = req.cookies.session
      ? (sessions.get(req._session_token) ?? null)
      : null;

    const result = (() => {
      for (const fn of route.fns) {
        const result = fn(req);
        if (!result) continue;
        return result;
      }
    })();

    if (!result) return;

    if (req._new_session_token) {
      res.setHeader(
        "Set-Cookie",
        `session=${req._new_session_token}; HttpOnly; Path='/'`,
      );
    }
    if (result.status === "ok") {
      res.writeHead(200, result.headers ?? { "Content-Type": "text/html" });
      res.end(result.data);
    } else if (result.status === "redirect") {
      res.writeHead(302, { Location: result.url });
      res.end();
    } else if (result.status === "error") {
      res.writeHead(result.code);
      res.end(result.html ?? "");
    }
  });

  return {
    sessions,

    start(port) {
      server.listen(port ?? 8000);
    },
    add_session(req, data) {
      req._new_session_token = crypto.randomBytes(32).toString("hex");
      sessions.set(req._new_session_token, data);
    },
    remove_session(req) {
      sessions.delete(req._session_token);
    },
    render(file, data) {
      return app_ok(file, data);
    },
  };
}
