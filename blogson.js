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
    CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date DESC);
  `);
}

function route_index(req) {
  const sites_only = req.params.sites_only === "1";
  const range = req.params.range ?? "week";
  const days = range === "week" ? -7 : range === "month" ? -30 : null;

  const time_filter = days ? `AND date >= datetime('now', '${days} days')` : "";
  const bookmark_filter = sites_only ? "AND is_bookmark = 1" : "";

  const union = sites_only
    ? ""
    : `
    UNION ALL
    SELECT NULL, f.url, 'New feed: ' || COALESCE(f.title, f.url),
      f.added_at as date, NULL, NULL, NULL, NULL, NULL,
      f.title, f.url, f.description, f.is_bookmark, 1 as is_fake
    FROM feeds f
  `;

  const sql = `
      SELECT * FROM (
        SELECT e.id, e.url, e.title, e.date as date, e.visits, e.author, e.tags,
          e.hn_url, e.lobste_url,
          f.title AS feed_title, f.url AS feed_url,
          f.description AS feed_desc, f.is_bookmark, 0 as is_fake
        FROM entries e
        JOIN feeds f ON e.feed_id = f.id
        ${union}
      )
      WHERE 1 ${time_filter} ${bookmark_filter}
      ORDER BY date DESC
  `;

  return server.render("index.html", {
    entries: db.query(sql).all(),
    feeds: db.query(`SELECT title, url FROM feeds ORDER BY title, url`).all(),
    range,
    sites_only,
  });
}

function get_all_feeds() {
  return {
    feeds: db
      .query(
        `
        SELECT f.id as id, f.title as title, f.url as url, COUNT(e.id) AS entry_count
        FROM feeds f
        LEFT JOIN entries e ON e.feed_id = f.id
        GROUP BY f.id
        ORDER BY f.added_at DESC
  `,
      )
      .all(),
    n_feeds: db
      .query(
        `
            SELECT COUNT(id) AS n
            FROM feeds
            WHERE is_bookmark = 0
            ORDER BY added_at DESC
      `,
      )
      .get().n,
  };
}

function route_submit(req, msg) {
  return server.render("submit.html", { ...get_all_feeds(), msg });
}

function route_admin(req) {
  return server.render("admin.html", { ...get_all_feeds() });
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
  url = url.trim();
  if (!url) return { error: "Url is required" };
  if (!url.startsWith("http://") && !url.startsWith("https://"))
    return { error: "URL must start with http:// or https://" };
  if (db.query("SELECT 1 FROM feeds WHERE url = ?").get(url))
    return { error: "Already exists" };

  let { error, content, resolved } = await fetch_url(url);
  if (error) return { error };

  if (db.query("SELECT 1 FROM feeds WHERE url = ?").get(resolved))
    return { error: "Already exists" };

  return skip_parse ? { resolved } : await discover_feed(resolved, content);
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

async function insert_feed(url, bookmark) {
  db.query("INSERT INTO feeds (url, is_bookmark) VALUES (?, ?)").run(
    url,
    bookmark ? 1 : 0,
  );

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

  return `Added ${url}`;
}

async function try_submit(req) {
  const url = req.body.url ?? "";
  const bookmark = (req.body.no_rss ?? 0) === "on";

  const { error, resolved } = await validate_feed(url, bookmark);
  if (error) return error;

  return await insert_feed(resolved, bookmark);
}

async function route_submit_post(req) {
  return route_submit(req, try_submit(req));
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

function is_admin_auth(auth) {
  return (
    (auth.username ?? "") === process.env.ADMIN_USER &&
    (auth.password ?? "") === process.env.ADMIN_PASS
  );
}

function require_login(req) {
  if (req.session) return;
  if (req.auth && is_admin_auth(req.auth)) {
    server.add_session(req, { ...req.auth });
    return;
  }
  return pici.prompt_login();
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
  const entry = db
    .query(
      "SELECT url, (julianday('now') - julianday(last_visit_at)) * 86400 as secs FROM entries WHERE id = ?",
    )
    .get(entry_id);
  if (!entry) return pici.redirect("/");

  if ((entry.secs ?? 1000) > 30) {
    db.query(
      `UPDATE entries SET visits = visits + 1, last_visit_at = datetime('now')
          WHERE id = ?`,
    ).run(entry_id);
  }

  return pici.redirect(entry.url);
}

function route_random() {
  const entry = db
    .query("SELECT id FROM entries ORDER BY RANDOM() LIMIT 1")
    .get();
  return pici.redirect(`/go`, { entry_id: entry.id });
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
  return server.render("extension.html", { ...req.params, msg });
}

async function route_extension_post(req) {
  return route_extension(req, await try_submit(req));
}

const server = pici.create({
  get: {
    "/": route_index,
    "/submit": route_submit,
    "/about": () => server.render("about.html"),
    "/admin": {
      check: [require_login],
      route: route_admin,
    },
    "/favicon": route_favicon,
    "/go": route_go,
    "/random": route_random,
    "/extension": route_extension,
  },
  post: {
    "/submit": route_submit_post,
    "/delete": route_delete_post,
    "/subscribe": route_subscribe_post,
    "/extension": route_extension_post,
  },
  render: gss.render,
});

init_db(process.env.DATABASE ?? "links.db");

setInterval(poll_all, 3 * 60 * 60 * 1000);
// poll_all();

server.start(5001);
