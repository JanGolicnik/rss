import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";

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

export function app_ok(data) {
  if (typeof data == "string") {
    return {
      status: "ok",
      data,
    };
  }

  return {
    status: "ok",
    ...data,
  };
}

export function app_redirect(url) {
  return {
    status: "redirect",
    url,
  };
}

export function app_error(code, html) {
  return {
    status: "error",
    code,
    html,
  };
}

function parse_path(p, char = ":") {
  let extra_arg = null;
  const split = p.split(":");
  if (split.length > 1) {
    p = split[0].substr(0, split[0].length - 1);
    extra_arg = split[split.length - 1];
  }
  return { path: p, extra_arg };
}

export function app_create(config) {
  const routes = {
    GET: {},
    POST: {},
  };

  for (const [path, route] of Object.entries(config.get ?? {})) {
    const p = parse_path(path);
    let fns =
      typeof route === "function"
        ? [route]
        : [...(route.check ?? []), route.route];
    routes.GET[p.path] = {
      fns,
      extra_arg: p.extra_arg ?? null,
    };
  }

  for (const [path, route] of Object.entries(config.post ?? {})) {
    const p = parse_path(path);
    let fns =
      typeof route === "function"
        ? [route]
        : [...(route.check ?? []), route.route];
    routes.POST[p.path] = {
      fns,
      extra_arg: p.extra_arg ?? null,
    };
  }

  const server = http.createServer(async (req, res) => {
    const method = req.method;
    let url = new URL(req.url, `http://localhost`);
    let pathname = url.pathname;
    if (pathname.startsWith("/public/")) {
      const file = path.join("public", pathname.slice("/public/".length));
      if (fs.existsSync(file)) {
        res.writeHead(200, { "Content-Type": get_mime(file) });
        res.end(fs.readFileSync(file));
      } else {
        res.writeHead(404);
        res.end();
      }
      return;
    }

    const split = pathname.split(":");
    let extra_arg = null;
    if (split.length > 1) {
      const p = parse_path(pathname);
      pathname = p.path;
      extra_arg = p.extra_arg;
    }

    const route = routes[method]?.[pathname];
    if (!route) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const cookies = parse_cookies(req);
    req._session_token = cookies.session;
    req.session = cookies.session
      ? (sessions.get(req._session_token) ?? null)
      : null;

    req.body = await parse_body(req);

    req.params = Object.fromEntries(url.searchParams);

    if (route.extra_arg) {
      req.params[route.extra_arg] = split[split.length - 1];
    }

    const apply_result = (result) => {
      if (req._new_session_token !== null) {
        res.setHeader(
          "Set-Cookie",
          `session=${req._new_session_token}; HttpOnly; Path='/'`,
        );
      }

      if (typeof result === "string") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(result);
      } else if (result.status === "ok") {
        res.writeHead(200, result.headers ?? { "Content-Type": "text/html" });
        res.end(result.data);
      } else if (result.status === "redirect") {
        res.writeHead(302, { Location: result.url });
        res.end();
      } else if (result.status === "error") {
        res.writeHead(result.code);
        res.end(result.html ?? "");
      }
    };

    for (const fn of route.fns) {
      const result = fn(req);
      if (result) {
        apply_result(result);
        break;
      }
    }
  });

  const sessions = new Map();

  return {
    sessions,

    start(port) {
      server.listen(port ?? 8000);
    },

    add_session(req, data) {
      const token = crypto.randomBytes(32).toString("hex");
      sessions.set(token, data);
      req._new_session_token = token;
      return token;
    },

    remove_session(req, data) {
      sessions.delete(req._session_token);
    },
  };
}
