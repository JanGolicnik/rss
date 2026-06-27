import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";

export default {
  ok,
  error,
  redirect,
  app_create,
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

function parse_auth(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Basic ")) return null;
  const [username, password] = Buffer.from(
    header.slice("Basic ".length),
    "base64",
  )
    .toString()
    .split(":");
  return { username, password };
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

export function redirect(url, params) {
  const query = params ? "?" + new URLSearchParams(params).toString() : "";
  return {
    status: "redirect",
    url: url + query,
  };
}

export function error(data) {
  return {
    status: "error",
    ...(typeof data == "string" ? { data } : data),
  };
}

export function app_create(config) {
  const parse_routes = (routes) =>
    Object.fromEntries(
      Object.entries(routes ?? {}).map(([path, route]) => [
        path,
        typeof route === "function"
          ? [route]
          : [...(route.check ?? []), route.route],
      ]),
    );

  const routes = {
    GET: {
      ...parse_routes(config.get),
      public: [
        (req) => {
          const file = req.params.file;
          return fs.existsSync(file)
            ? ok({
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
    const pathname =
      url.pathname === "/" ? "/" : url.pathname.replace(/\/+$/, "");
    let route;
    if (req.method === "GET" && pathname.startsWith("/public/")) {
      (req.params ??= {}).file = pathname.slice(1);
      route = routes.GET.public;
    } else {
      route = routes[req.method]?.[pathname];
    }

    if (!route) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    req.params = { ...req.params, ...Object.fromEntries(url.searchParams) };
    req.body = await parse_body(req);
    req.cookies = parse_cookies(req);
    req.auth = parse_auth(req);
    req._session_token = req.cookies.session;
    req.session = req.cookies.session
      ? (sessions.get(req._session_token) ?? null)
      : null;

    const result = await (async () => {
      for (const fn of route) {
        const result = await Promise.resolve(fn(req));
        if (!result) continue;
        return result;
      }
    })();

    if (!result) return;

    if (req._new_session_token) {
      res.setHeader(
        "Set-Cookie",
        `session=${req._new_session_token}; HttpOnly; Path=/`,
      );
    }

    if (result.status === "ok") {
      res.writeHead(200, result.headers ?? { "Content-Type": "text/html" });
      res.end(result.data);
    } else if (result.status === "redirect") {
      res.writeHead(302, { Location: result.url });
      res.end();
    } else if (result.status === "error") {
      res.writeHead(result.code, result.headers ?? {});
      res.end(result.data ?? "");
    }
  });

  return {
    sessions,
    template_render: config.template_render,

    start(port) {
      port = port ?? 8000;
      console.log(`started listening on port ${port}`);
      server.listen(port);
    },
    add_session(req, data) {
      req._new_session_token = crypto.randomBytes(32).toString("hex");
      sessions.set(req._new_session_token, data);
    },
    remove_session(req) {
      sessions.delete(req._session_token);
    },
    render(file, data) {
      return ok(this.template_render(file, data));
    },
  };
}
