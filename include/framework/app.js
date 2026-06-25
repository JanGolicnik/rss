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

export function app_ok(html) {
  return {
    status: "ok",
    html,
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

export function app_create(config) {
  const routes = {
    GET: {},
    POST: {},
  };

  for (const [path, route] of Object.entries(config.get ?? {})) {
    if (typeof route === "function") {
      routes.GET[path] = { fns: [route] };
    } else {
      const check = route.check ?? [];
      routes.GET[path] = {
        fns: [...check, route.route],
      };
    }
  }
  for (const [path, route] of Object.entries(config.post ?? {})) {
    if (typeof route === "function") {
      routes.POST[path] = { fns: [route] };
    } else {
      const check = route.check ?? [];
      routes.POST[path] = {
        fns: [...check, route.route],
      };
    }
  }

  const server = http.createServer(async (req, res) => {
    const method = req.method;
    const url = new URL(req.url, `http://localhost`).pathname;
    if (url.startsWith("/public/")) {
      const file = path.join("public", url.slice("/public/".length));
      if (fs.existsSync(file)) {
        res.writeHead(200, { "Content-Type": get_mime(file) });
        res.end(fs.readFileSync(file));
      } else {
        res.writeHead(404);
        res.end();
      }
      return;
    }

    const route = routes[method]?.[url];
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
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(result.html);
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
