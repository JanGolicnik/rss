import pici from "./include/picijs/pici.js";
import Parser from "rss-parser";
const parser = new Parser();
import gss from "./include/gss/gss.js";
import { Database } from "bun:sqlite";
import webpush from "web-push";

webpush.setVapidDetails(
  "mailto:jan@nejka.net",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY,
);

let db;

const COMMON_FEED_PATHS = [
  "/feed",
  "/feed/",
  "/rss",
  "/rss/",
  "/feed.xml",
  "/rss.xml",
  "/atom.xml",
  "/index.xml",
  "/feeds/posts/default",
  "/?feed=rss2",
];

const link_re =
  /<link\b[^>]*?(?:rel=["']alternate["'][^>]*?type=["']application\/(?:rss|atom)\+xml["']|type=["']application\/(?:rss|atom)\+xml["'][^>]*?rel=["']alternate["'])[^>]*?href=["']([^"']+)["']/gi;
const simple_re =
  /<link\b[^>]*?type=["']application\/(?:rss|atom)\+xml["'][^>]*?href=["']([^"']+)["']/gi;
const href_first_re =
  /<link\b[^>]*?href=["']([^"']+)["'][^>]*?type=["']application\/(?:rss|atom)\+xml["']/gi;

async function fetch_url(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "blogson/1.0 (jan@nejka.net)" },
      signal: AbortSignal.timeout(3000),
      redirect: "follow",
    });
    if (!res.ok) return { error: `Server returned ${res.status}` };
    return { content: await res.arrayBuffer(), resolved: res.url };
  } catch (e) {
    return { error: `Fetch failed (${e.message})` };
  }
}

function init_db(path) {
  db = new Database(path);
  db.run("PRAGMA journal_mode = WAL");

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
    CREATE TABLE IF NOT EXISTS subscriptions (
      endpoint TEXT PRIMARY KEY,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      mail TEXT,
      site TEXT,
      description TEXT,
      banned BOOLEAN,
      can_invite BOOLEAN,
      can_post BOOLEAN,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS invites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL UNIQUE,
      inviter_id INTEGER REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS visits (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      entry_id   INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, entry_id)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash BLOB PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date DESC);
    CREATE INDEX IF NOT EXISTS entries_feed_id_idx ON feeds(id);
    CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
  `);

  let user_version = db.query("PRAGMA user_version").get().user_version;
  console.log(`running db version ${user_version}`);
  if (user_version <= 0) {
    user_version++;
    db.query(
      "ALTER TABLE feeds ADD COLUMN added_by INTEGER REFERENCES users(id)",
    ).run();
    db.query("UPDATE feeds SET added_by = 1 WHERE added_by IS NULL").run();
    db.query(
      "CREATE UNIQUE INDEX users_username_key ON users (username)",
    ).run();
  }
  if (user_version <= 1) {
    user_version++;
    db.query("DROP TABLE IF EXISTS comments").run();
    db.query(
      `CREATE TABLE comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      entry_id INTEGER REFERENCES entries(id) ON DELETE CASCADE,
      author_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
    ).run();
    db.query(
      "CREATE INDEX IF NOT EXISTS comments_entry_id_idx ON comments(entry_id)",
    ).run();
  }
  if (user_version <= 2) {
    user_version++;
    db.query("ALTER TABLE users RENAME COLUMN can_invite TO cant_invite").run();
    db.query("ALTER TABLE users RENAME COLUMN can_post TO cant_post").run();
  }
  if (user_version <= 3) {
    user_version++;
    db.query("ALTER TABLE entries DROP COLUMN visits").run();
    db.query("ALTER TABLE entries DROP COLUMN last_visit_at").run();
  }
  db.query(`PRAGMA user_version = ${user_version}`).get();
}

function route_index(req) {
  const sites_only = req.params.sites_only === "1";
  const range = req.params.range ?? "week";
  const days = range === "week" ? -7 : range === "month" ? -30 : null;

  const time_filter = days ? `AND date >= datetime('now', '${days} days')` : "";
  const bookmark_filter = sites_only ? "AND is_bookmark = 1" : "";

  const union = !sites_only
    ? `
    UNION ALL
    SELECT NULL, f.url, 'New feed: ' || COALESCE(f.title, f.url), f.added_at as date,
      NULL, NULL, NULL, NULL, NULL,
      0 as is_bookmark, 1 as is_fake,
      0 as n_comments,
      0 as visited
    FROM feeds f
    WHERE f.is_bookmark = 0
  `
    : "";

  const sql = `
      SELECT * FROM (
        SELECT e.id, e.url, e.title, e.date as date,
          e.author, e.tags, e.hn_url, e.lobste_url, f.title AS feed_title,
          f.is_bookmark, 0 as is_fake,
          (SELECT COUNT(*) FROM comments c WHERE c.entry_id = e.id) AS n_comments,
          (SELECT COUNT(*) FROM visits v WHERE v.entry_id = e.id AND v.user_id = ?) AS visited
        FROM entries e
        JOIN feeds f ON e.feed_id = f.id
        ${union}
      )
      WHERE 1 ${time_filter} ${bookmark_filter}
      ORDER BY date DESC
  `;

  return server.render("index.html", {
    entries: db.query(sql).all(req.session?.id ?? null),
    range,
    sites_only,
    session: req.session,
  });
}

function route_submit(req, msg) {
  const feeds = db
    .query(
      `
          SELECT f.id as id, f.title as title, f.url as url, f.added_by as added_by, COUNT(e.id) AS entry_count, u.username as added_by_username
          FROM feeds f
          LEFT JOIN entries e ON e.feed_id = f.id
          LEFT JOIN users u ON u.id = f.added_by
          GROUP BY f.id
          ORDER BY f.added_at DESC
    `,
    )
    .all();
  const n_feeds = db
    .query(
      `
              SELECT COUNT(id) AS n
              FROM feeds
              WHERE is_bookmark = 0
              ORDER BY added_at DESC
        `,
    )
    .get().n;
  return server.render("submit.html", {
    feeds,
    n_feeds,
    msg,
    session: req.session,
  });
}

async function parseFeed(content) {
  try {
    return await parser.parseString(Buffer.from(content).toString("utf8"));
  } catch (e) {
    return null;
  }
}

async function discover_feed(url, content) {
  const html = Buffer.from(content).toString("utf8");
  if (await parseFeed(content)) return { resolved: url };

  for (const re of [link_re, simple_re, href_first_re]) {
    re.lastIndex = 0;
    const m = re.exec(html);
    if (!m) continue;
    const { error, content, resolved } = await fetch_url(
      new URL(m[1], url).href,
    );
    if (error) continue;
    if (await parseFeed(content)) return { resolved };
  }

  const root = new URL(url).origin;
  for (const path of COMMON_FEED_PATHS) {
    const { error, content, resolved } = await fetch_url(root + path);
    if (error) continue;
    if (await parseFeed(content)) return { resolved };
  }

  return { error: "No feed found" };
}

async function validate_feed(url, skip_parse) {
  if (!url) return { error: "Url is required" };
  if (!url.startsWith("http://") && !url.startsWith("https://"))
    return { error: "URL must start with http:// or https://" };

  let { error, content, resolved } = await fetch_url(url);
  if (error) return { error };

  if (skip_parse) return { resolved };
  return await discover_feed(resolved, content);
}

function normalize_url(url) {
  const p = new URL(url.trim());
  const host = p.hostname.replace(/^www\./, "");
  const path = p.pathname.replace(/\/+$/, "") || "/";
  return host + path;
}

async function find_url_on_hn(url) {
  const normalized = normalize_url(url);
  const q = new URLSearchParams({
    query: url,
    restrictSearchableAttributes: "url",
    tags: "story",
    hitsPerPage: 100,
  });
  try {
    const res = await fetch(`https://hn.algolia.com/api/v1/search?${q}`);
    const data = await res.json();
    const hit = (data.hits ?? []).find(
      (h) => h.url && normalize_url(h.url) === normalized,
    );
    return hit ? `https://news.ycombinator.com/item?id=${hit.objectID}` : null;
  } catch {
    return null;
  }
}

async function find_url_on_lobste(url) {
  const q = new URLSearchParams({ url });
  try {
    const res = await fetch(`https://lobste.rs/stories/url/all.json?${q}`, {
      headers: { "User-Agent": "blogson/1.0 (jan@nejka.net)" },
    });
    const data = await res.json();
    return data[0]?.comments_url ?? data[0]?.short_id_url ?? null;
  } catch {
    return null;
  }
}

async function fetch_favicon(url) {
  try {
    const domain = `https://www.google.com/s2/favicons?sz=32&domain=${url}`;
    const res = await fetch(domain, {
      headers: { "User-Agent": "blogson/1.0 (jan@nejka.net)" },
    });
    return res.ok
      ? {
          favicon_mime: res.headers.get("Content-Type", "image/png"),
          favicon_data: Buffer.from(await res.arrayBuffer()),
        }
      : null;
  } catch {
    return null;
  }
}

async function poll_feed(id, url) {
  const { error, content, resolved } = await fetch_url(url);
  if (error) return { error };
  url = resolved;
  const feed = await parseFeed(content);
  if (!feed) return;

  let updates = {};
  if (feed.title) updates.title = feed.title;
  if (feed.description) updates.description = feed.description;

  const favicon = await fetch_favicon(url);
  if (favicon) updates = { ...updates, ...favicon };

  if (Object.keys(updates).length > 0) {
    const set = Object.keys(updates)
      .map((k) => `${k} = ?`)
      .join(", ");
    db.query(`UPDATE feeds SET ${set} WHERE id = ?`).run(
      ...Object.values(updates),
      id,
    );
  }

  const all_inserted = [];
  for (const item of feed.items) {
    const url = item.link;
    if (!url) continue;
    const title = item.title ?? url;
    const date = item.isoDate
      ? new Date(item.isoDate).toISOString()
      : new Date().toISOString();
    const author = item.author?.trim() || null;
    const tags =
      item.categories?.length > 0 ? item.categories.join(", ") : null;

    const inserted = db
      .query(
        `
      INSERT OR IGNORE INTO entries (feed_id, url, title, date, author, tags)
      VALUES (?, ?, ?, ?, ?, ?)
      RETURNING id, title
    `,
      )
      .get(id, url, title, date, author, tags);
    if (inserted) all_inserted.push({ ...inserted, feed: feed.title });
  }

  const cutoff = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const rows = db
    .query(
      `
    SELECT id, url, hn_url, lobste_url FROM entries
    WHERE feed_id = ? AND (hn_url IS NULL OR lobste_url IS NULL) AND date > ?
    ORDER BY date DESC LIMIT 25
  `,
    )
    .all(id, cutoff);

  for (const row of rows) {
    const hn_url = row.hn_url ?? (await find_url_on_hn(row.url));
    const lobste_url = row.lobste_url ?? (await find_url_on_lobste(row.url));
    db.query("UPDATE entries SET hn_url = ?, lobste_url = ? WHERE id = ?").run(
      hn_url,
      lobste_url,
      row.id,
    );
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log(`finished polling feed ${id}`);

  return all_inserted;
}

async function poll_all() {
  const start = Date.now();

  const all_inserted = [];

  const feeds = db
    .query("SELECT id, url FROM feeds WHERE is_bookmark = 0")
    .all();

  for (let i = 0; i < feeds.length; i += 5) {
    const batch = feeds.slice(i, i + 5);
    all_inserted.push(
      ...(await Promise.all(batch.map((feed) => poll_feed(feed.id, feed.url))))
        .filter(Array.isArray)
        .flat(),
    );
  }

  const interval = process.env.POLL_INTERVAL / all_inserted.length;
  all_inserted.forEach((entry, i) => {
    setTimeout(
      () =>
        sendNotification(
          JSON.stringify({
            title: entry.feed,
            body: entry.title,
            url: `/go/?entry_id=${entry.id}`,
          }),
        ),
      interval * i * 1000,
    );
  });

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`polled ${feeds.length} feeds in ${elapsed} seconds`);
}

async function insert_feed(url, bookmark, user_id) {
  try {
    db.query("INSERT INTO feeds (url, is_bookmark, added_by) VALUES (?, ?, ?)").run(
      url,
      bookmark ? 1 : 0,
    );
  } catch (e) {
    return e.code === "SQLITE_CONSTRAINT_UNIQUE"
      ? "already exists"
      : "unknown error";
  }

  const feed_id = db.query("SELECT id FROM feeds WHERE url = ?").get(url).id;

  if (!bookmark) {
    await poll_feed(feed_id, url);
  } else {
    const q = `
      INSERT INTO entries (feed_id, url, title, date, tags)
      VALUES (?, ?, ?, ?, ?)
      RETURNING id
      `;
    const inserted = db
      .query(q)
      .get(feed_id, url, url, new Date().toISOString(), "site");

    sendNotification(
      JSON.stringify({
        title: "site showcase !",
        body: url,
        url: `/go/?entry_id=${inserted.id}`,
      }),
    );
  }

  return `added ${url}`;
}

async function try_submit(req) {
  if (!req.session) return "you must be logged in to submit stuff";

  const cant_post = db
    .query("SELECT cant_post FROM users WHERE id = ?")
    .get(req.session.id)?.cant_post;
  if (cant_post) return "you cant post im sorry";

  const url = req.body.url?.trim() ?? "";
  const bookmark = (req.body.no_rss ?? 0) === "on";

  const { error, resolved } = await validate_feed(url, bookmark);
  if (error) return error;

  return await insert_feed(resolved, bookmark, req.session.id);
}

async function route_submit_post(req) {
  return route_submit(req, await try_submit(req));
}

function route_favicon(req) {
  const row = db
    .query(
      `SELECT favicon_data, favicon_mime FROM feeds WHERE url LIKE ? AND favicon_data IS NOT NULL LIMIT 1`,
    )
    .get(`%${req.params.domain}%`);
  if (row) {
    return pici.ok({
      data: row.favicon_data,
      headers: {
        "Content-Type": row.favicon_mime ?? "image/png",
        "Cache-Control": "public, max-age=604800",
      },
    });
  }
}

function require_login(req) {
  if (!req.session) {
    return pici.redirect("/login");
  }

  const banned = db
    .query("SELECT banned FROM users WHERE id = ?")
    .get(req.session.id)?.banned;
  if (banned) {
    server.remove_session(req);
    return pici.redirect("/login");
  }
}

function require_admin(req) {
  if (!req.session?.is_admin) return pici.redirect("/");
}

function route_delete_post(req) {
  const feed_id = req.params.feed_id;
  if (feed_id) {
    db.query("DELETE FROM entries WHERE feed_id = ?").run(feed_id);
    db.query("DELETE FROM feeds WHERE id = ?").run(feed_id);
  }
  return pici.redirect("/admin");
}

function route_go(req) {
  const entry_id = req.params.entry_id;
  if (!entry_id) return pici.redirect("/");

  if (req.session) {
    try {
      db.query("INSERT INTO visits (user_id, entry_id) VALUES (?, ?)").run(
        req.session.id,
        entry_id,
      );
    } catch (e) {}
  }

  const entry = db.query("SELECT url FROM entries WHERE id = ?").get(entry_id);

  return pici.redirect(entry.url);
}

function route_random() {
  return pici.redirect(`/entry`, {
    id: db.query("SELECT id FROM entries ORDER BY RANDOM() LIMIT 1").get().id,
  });
}

function route_subscribe_post(req) {
  const sub = req.body;
  db.query(
    `
    INSERT INTO subscriptions (endpoint, p256dh, auth)
     VALUES (?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth
    `,
  ).run(sub.endpoint, sub.keys.p256dh, sub.keys.auth);

  return pici.error({ code: 201 });
}

async function sendNotification(data) {
  console.log(`sending notification about ${data}`);
  db.query(`SELECT * FROM subscriptions`)
    .all()
    .forEach(async (s) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: s.endpoint,
            keys: { p256dh: s.p256dh, auth: s.auth },
          },
          data,
        );
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          db.query("DELETE FROM subscriptions WHERE endpoint = ?").run(
            s.endpoint,
          );
        } else {
          console.log(err);
        }
      }
    });
}

function route_extension(req, msg) {
  return server.render("extension.html", {
    ...req.params,
    msg,
    session: req.session,
  });
}

async function route_extension_post(req) {
  return route_extension(req, await try_submit(req));
}

async function route_login(req, msg) {
  return server.render("login.html", { msg, session: req.session });
}

async function route_login_post(req) {
  if (!req.body) return route_login(req, "form body missing i think ?");
  if (!req.body.username) return route_login(req, "username required");
  if (!req.body.password) return route_login(req, "password required");

  const user = db
    .query(
      "SELECT id, username, password_hash, banned FROM users WHERE username = ?",
    )
    .get(req.body.username);

  if (!user) return route_login(req, "incorrect username or password");
  if (user.banned) return route_login(req, "this user has been banned :(");

  if (!(await Bun.password.verify(req.body.password, user.password_hash)))
    return route_login(req, "incorrect username or password");

  server.add_session(req, user);

  return pici.redirect("/");
}

async function route_register(req, msg) {
  return req.params.invite
    ? server.render("register.html", {
        msg,
        invite: req.params.invite,
        session: req.session,
      })
    : pici.redirect("/");
}

function register_validate_username_password(username, password, password2) {
  if (!username) return "username required";
  if (!password) return "password required";
  if (!password2) return "confirmation password required";
  if (!password != !password2) return "passwords dont match";
  if (username.length > 30) return "username is max 30 characters";
  if (password.length > 30) return "password is max 30 characters";
}

async function route_register_post(req) {
  if (!req.body) return route_register(req, "form body missing i think ?");
  if (!req.params.invite) return pici.redirect("/");

  const error = register_validate_username_password(
    req.body.username,
    req.body.password,
    req.body.password2,
  );
  if (error) return route_register(req, error);

  const invite_hash = req.params.invite;
  const invited_by = db
    .query("SELECT inviter_id FROM invites WHERE hash = ?")
    .get(invite_hash)?.inviter_id;
  if (!invited_by) return pici.redirect("/");

  const cant_invite = db
    .query("SELECT cant_invite FROM users WHERE id = ?")
    .get(invited_by)?.cant_invite;
  if (cant_invite) return route_register(req, "invalid invite");

  const password_hash = await Bun.password.hash(req.body.password);
  try {
    db.query(
      "INSERT INTO users (username, password_hash, invited_by) VALUES (?, ?, ?)",
    ).run(req.body.username, password_hash, invited_by);
    db.query("DELETE FROM invites WHERE hash = ?").run(invite_hash);
    return pici.redirect("/login");
  } catch (e) {
    return route_register(
      req,
      e.code === "SQLITE_CONSTRAINT_UNIQUE"
        ? "username alr taken"
        : "smth happened idk",
    );
  }
}

function route_profile(req, msg) {
  const id = req.params?.id ?? null;
  if (!id) return pici.not_found();
  const user = db.query("SELECT * FROM users WHERE id = ?").get(id);
  if (!user) return pici.not_found();
  if (user.invited_by)
    user.invited_by_username = db
      .query("SELECT username FROM users WHERE id = ?")
      .get(user.invited_by)?.username;
  return server.render("profile.html", {
    user,
    msg,
    session: req.session,
    invitees: db
      .query("SELECT * FROM users WHERE invited_by = ? ORDER BY created_at")
      .all(id),
    feeds: db
      .query("SELECT * FROM feeds WHERE added_by = ? ORDER BY added_at")
      .all(id),
    invite: db.query("SELECT hash FROM invites WHERE inviter_id = ?").get(id)
      ?.hash,
  });
}

function route_profile_post(req) {
  const id = req.params?.id ?? null;
  if (!id) return pici.not_found();
  db.query(
    `
    UPDATE users SET site = ?, mail = ?, description = ? WHERE id = ?`,
  ).run(
    req.body.site ?? null,
    req.body.mail ?? null,
    req.body.description ?? null,
    id,
  );
  return route_profile(req, "updated !");
}

function route_profile_admin_post(req) {
  const id = req.params?.id ?? null;
  if (!id) return pici.not_found();
  db.query(
    `UPDATE users SET banned = ?, cant_invite = ?, cant_post = ? WHERE id = ?`,
  ).run(
    req.body.banned ? 1 : 0,
    req.body.cant_invite ? 1 : 0,
    req.body.cant_post ? 1 : 0,
    id,
  );
  return route_profile(req, "updated !");
}

function route_logout_post(req) {
  server.remove_session(req);
  return pici.redirect(`/profile/?id=${req.session.id}`);
}

function route_create_invite(req) {
  const cant_invite = db
    .query("SELECT cant_invite FROM users WHERE id = ?")
    .get(req.session.id)?.cant_invite;
  if (cant_invite)
    return route_profile(req, "you dont have permission to invite :/");
  const result = db
    .query(
      `
    INSERT INTO invites (hash, inviter_id)
    SELECT ?, ?
    WHERE (
      SELECT count(id) FROM invites
      WHERE inviter_id = ?
    ) < 1;
    `,
    )
    .run(Bun.randomUUIDv7(), req.session.id, req.session.id);
  if (result.changes === 0) {
    req.params.id = req.session.id; // HACk
    return route_profile(req, "cant have more than 1 invite");
  }
  return pici.redirect(`/profile/?id=${req.session.id}`);
}

function route_entry(req) {
  const id = req.params.id;
  if (!id) return pici.not_found();
  const entry = db
    .query(
      `SELECT e.*, f.title AS feed_title, f.is_bookmark
    FROM entries e
    JOIN feeds f ON e.feed_id = f.id
    WHERE e.id = ?
  `,
    )
    .get(id);
  if (!entry) return pici.not_found();
  const comments = db
    .query(
      `
    SELECT c.*, u.username
    FROM comments c
    JOIN users u ON u.id = c.author_id
    WHERE c.entry_id = ?
  `,
    )
    .all(id);
  return server.render("entry.html", { entry, comments, session: req.session });
}

function route_entry_post(req) {
  const id = req.params.id;
  if (!id) return pici.not_found();
  const content = req.body.content?.trim().substring(0, 1234) ?? "";
  if (content === "") return route_entry(req);
  db.query(
    "INSERT INTO comments (content, entry_id, author_id) VALUES (?, ?, ?)",
  ).run(content, id, req.session.id);
  return route_entry(req);
}

function route_about(req) {
  return server.render("about.html", { session: req.session });
}

function route_users(req) {
  const users = db.query("SELECT * FROM users").all();
  return server.render("users.html", { users, session: req.session });
}

function hash_token(token)
{
  return new Bun.CryptoHasher("sha256").update(token).digest();
}

const server = pici.create({
  render: gss.render,
  get: {
    "/": route_index,
    "/favicon": route_favicon,
    "/about": route_about,
    "/submit": [require_login, route_submit],
    "/go": route_go,
    "/random": route_random,
    "/extension": route_extension,
    "/login": route_login,
    "/register": route_register,
    "/profile": route_profile,
    "/create_invite": [require_login, route_create_invite],
    "/entry": route_entry,
    "/users": route_users,
  },
  post: {
    "/submit": [require_login, route_submit_post],
    "/extension": [require_login, route_extension_post],
    "/delete": [require_login, require_admin, route_delete_post],
    "/subscribe": route_subscribe_post,
    "/login": route_login_post,
    "/logout": [require_login, route_logout_post],
    "/register": route_register_post,
    "/profile": [require_login, route_profile_post],
    "/profile_admin": [require_login, require_admin, route_profile_admin_post],
    "/entry": [require_login, route_entry_post],
  },
  add_session: (req, user) => {
    req._new_session_token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
    db.query("INSERT INTO sessions (token_hash, user_id) VALUES (?, ?)").run(hash_token(req._new_session_token), user.id);
  },
  get_session: (req) => {
    const user_id = db.query("SELECT user_id FROM sessions WHERE token_hash = ?").get(hash_token(req.cookies.session))?.user_id;
    if (!user_id) return;
    const user = db.query("SELECT * FROM users WHERE id = ?").get(user_id);
    if (!user) return;
    user.is_admin = user.id === 1;
    return user;
  },
  remove_session: (req) => {
    db.query("DELETE FROM sessions WHERE token_hash = ?").run(hash_token(req.cookies.session));
  }
});

init_db(process.env.DATABASE ?? "links.db");

setInterval(poll_all, 3 * 60 * 60 * 1000);
// poll_all();

server.start(5001);
