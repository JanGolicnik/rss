import {
  app_create,
  app_error,
  app_ok,
  app_redirect,
} from "./include/framework/app.js";

import gss from "./include/gss/gss.js";

import Database from "better-sqlite3";

let db;

function init_db() {
  db = new Database(process.env.DATABASE ?? "links.db");
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS feeds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT UNIQUE NOT NULL,
      title TEXT,
      description TEXT,
      favicon_data BLOB,
      favicon_mime TEXT,
      is_bookmark INTEGER DEFAULT 0,
      added_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feed_id INTEGER NOT NULL,
      url TEXT NOT NULL,
      title TEXT,
      date TEXT,
      visits INTEGER DEFAULT 0,
      last_visit_at TEXT,
      author TEXT,
      tags TEXT,
      hn_url TEXT,
      lobste_url TEXT,
      FOREIGN KEY (feed_id) REFERENCES feeds(id) ON DELETE CASCADE,
      UNIQUE(feed_id, url)
    );
    CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date DESC);
  `);
}

function route_index(req) {
  const entries = db
    .prepare(
      `
    SELECT e.*, f.title AS feed_title, f.url AS feed_url
    FROM entries e
    JOIN feeds f ON e.feed_id = f.id
    WHERE e.date >= datetime('now', '-7 days')
    ORDER BY e.date DESC
    `,
    )
    .all();
  return gss.render("index.html", {
    body: gss.render_component("entries", { entries }),
  });
}

function route_login() {
  return app_ok(`
    <form method="POST" action="/login">
      <input type="text" name="username">
      <input type="password" name="password">
      <button type="submit">Login</button>
    </form>
  `);
}

function route_login_submit(req) {
  if (req.body.username === "admin" && req.body.password === "admin") {
    app.add_session(req, { username: req.body.username, role: "admin" });
  } else if (
    req.body.username === "normaln" &&
    req.body.password === "normaln"
  ) {
    app.add_session(req, { username: req.body.username, role: "normaln" });
  }

  return app_redirect("/");
}

function route_logout_submit(req) {
  app.remove_session(req);
  return app_redirect("/");
}

function session_is_login(session) {
  return session != null;
}

function session_is_admin(session) {
  return session?.role === "admin";
}

function require_login(req) {
  if (!session_is_login(req.session)) return app_redirect("/login");
}

function require_admin(req) {
  if (!session_is_admin(req.session)) return app_error(403, "");
}

const app = app_create({
  get: {
    // "/": { check: [require_login], route: route_index },
    "/": route_index,
    "/login": route_login,
    "/admin": {
      check: [require_login, require_admin],
      route: route_login,
    },
  },
  post: {
    "/login": route_login_submit,
    "/logout": route_logout_submit,
  },
});

init_db();

gss.init();

app.start();
