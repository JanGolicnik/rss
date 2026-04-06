"""
RSS Link Aggregator
A deliberately simple link dump. Not a reader.
Polls feeds, stores links in SQLite, renders them as flat HTML.
"""

import os
import sqlite3
import time
import threading
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path
from flask import (
    Flask, render_template, request, redirect, url_for, flash,
    Response, g
)
import feedparser

# ---------------------------------------------------------------------------
# Config – loaded from .env file next to app.py
# ---------------------------------------------------------------------------

def load_env(path=".env"):
    """Read KEY=VALUE lines from a file into os.environ."""
    p = Path(__file__).parent / path
    if not p.exists():
        raise SystemExit(f"Missing {p} — copy .env.example and fill it in.")
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())

load_env()

DATABASE = os.environ.get("DATABASE", "links.db")
ADMIN_USER = os.environ["ADMIN_USER"]
ADMIN_PASS = os.environ["ADMIN_PASS"]
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL", "3600"))

app = Flask(__name__)
app.secret_key = os.environ["SECRET_KEY"]

# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------

def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DATABASE)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA journal_mode=WAL")
    return g.db


@app.teardown_appcontext
def close_db(exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    """Create tables if they don't exist."""
    db = sqlite3.connect(DATABASE)
    db.executescript("""
        CREATE TABLE IF NOT EXISTS feeds (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            url TEXT UNIQUE NOT NULL,
            title TEXT,
            description TEXT,
            color TEXT,
            added_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            feed_id INTEGER NOT NULL,
            url TEXT NOT NULL,
            title TEXT,
            published TEXT,
            fetched_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (feed_id) REFERENCES feeds(id) ON DELETE CASCADE,
            UNIQUE(feed_id, url)
        );
        CREATE INDEX IF NOT EXISTS idx_entries_fetched ON entries(fetched_at DESC);
        CREATE INDEX IF NOT EXISTS idx_entries_published ON entries(published DESC);
    """)
    # Migrate existing databases
    try:
        db.execute("ALTER TABLE feeds ADD COLUMN description TEXT")
    except sqlite3.OperationalError:
        pass
    try:
        db.execute("ALTER TABLE feeds ADD COLUMN color TEXT")
    except sqlite3.OperationalError:
        pass
    db.close()


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

def check_auth(username, password):
    return username == ADMIN_USER and password == ADMIN_PASS


def requires_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        auth = request.authorization
        if not auth or not check_auth(auth.username, auth.password):
            return Response(
                "Login required.",
                401,
                {"WWW-Authenticate": 'Basic realm="Admin"'},
            )
        return f(*args, **kwargs)
    return decorated


# ---------------------------------------------------------------------------
# Feed polling
# ---------------------------------------------------------------------------

def fetch_site_color(feed_url: str) -> str | None:
    """Try to extract a theme color from a feed's website."""
    try:
        from urllib.parse import urlparse
        import urllib.request
        import re
        parsed_url = urlparse(feed_url)
        site_url = f"{parsed_url.scheme}://{parsed_url.netloc}"
        req = urllib.request.Request(site_url, headers={"User-Agent": "rss-aggregator/1.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            html = resp.read(50_000).decode("utf-8", errors="ignore")
        # Try <meta name="theme-color" content="#...">
        m = re.search(r'<meta[^>]*name=["\']theme-color["\'][^>]*content=["\'](#[0-9a-fA-F]{3,8})["\']', html)
        if not m:
            m = re.search(r'<meta[^>]*content=["\'](#[0-9a-fA-F]{3,8})["\'][^>]*name=["\']theme-color["\']', html)
        if m:
            return m.group(1)
    except Exception:
        pass
    return None


def poll_feed(feed_id: int, feed_url: str, db: sqlite3.Connection) -> int:
    """Fetch a single feed, insert new entries. Returns count of new items."""
    try:
        parsed = feedparser.parse(feed_url)
    except Exception as e:
        print(f"[poll] error fetching {feed_url}: {e}")
        return 0

    # Update feed metadata
    updates = {}
    if parsed.feed.get("title"):
        updates["title"] = parsed.feed.title
    desc = parsed.feed.get("subtitle") or parsed.feed.get("description")
    if desc:
        updates["description"] = desc

    # Fetch theme color if we don't have one yet
    existing = db.execute("SELECT color FROM feeds WHERE id = ?", (feed_id,)).fetchone()
    if existing and not existing["color"]:
        color = fetch_site_color(feed_url)
        if color:
            updates["color"] = color

    if updates:
        set_clause = ", ".join(f"{k} = ?" for k in updates)
        db.execute(f"UPDATE feeds SET {set_clause} WHERE id = ?",
                   (*updates.values(), feed_id))

    new = 0
    for entry in parsed.entries:
        link = entry.get("link", "")
        if not link:
            continue
        title = entry.get("title", link)

        # Try to get a published date
        published = None
        for key in ("published_parsed", "updated_parsed"):
            tp = entry.get(key)
            if tp:
                try:
                    published = datetime(*tp[:6], tzinfo=timezone.utc).isoformat()
                except Exception:
                    pass
                break

        try:
            db.execute(
                "INSERT OR IGNORE INTO entries (feed_id, url, title, published) "
                "VALUES (?, ?, ?, ?)",
                (feed_id, link, title, published),
            )
            if db.total_changes:
                new += 1
        except sqlite3.IntegrityError:
            pass

    db.commit()
    return new


def poll_all():
    """Poll every feed in the database."""
    db = sqlite3.connect(DATABASE)
    db.row_factory = sqlite3.Row
    feeds = db.execute("SELECT id, url FROM feeds").fetchall()
    total = 0
    for feed in feeds:
        n = poll_feed(feed["id"], feed["url"], db)
        total += n
    db.close()
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[poll] {ts} — polled {len(feeds)} feeds, {total} new entries")


def poller_loop():
    """Background thread: poll forever."""
    while True:
        try:
            poll_all()
        except Exception as e:
            print(f"[poll] unhandled error: {e}")
        time.sleep(POLL_INTERVAL)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    db = get_db()
    range_filter = request.args.get("range", "month")

    time_clause = ""
    limit = "LIMIT 300"
    if range_filter == "today":
        time_clause = "WHERE COALESCE(e.published, e.fetched_at) >= datetime('now', '-1 day')"
    elif range_filter == "week":
        time_clause = "WHERE COALESCE(e.published, e.fetched_at) >= datetime('now', '-7 days')"
    elif range_filter == "month":
        time_clause = "WHERE COALESCE(e.published, e.fetched_at) >= datetime('now', '-30 days')"
    elif range_filter == "all":
        limit = ""

    entries = db.execute(f"""
        SELECT e.url, e.title, e.published, e.fetched_at,
               f.title AS feed_title, f.url AS feed_url,
               f.description AS feed_desc, f.color AS feed_color
        FROM entries e
        JOIN feeds f ON e.feed_id = f.id
        {time_clause}
        ORDER BY COALESCE(e.published, e.fetched_at) DESC
        {limit}
    """).fetchall()

    feeds = db.execute("SELECT * FROM feeds ORDER BY title, url").fetchall()
    return render_template("index.html", entries=entries, feeds=feeds, time_range=range_filter)


@app.route("/random")
def random_link():
    db = get_db()
    entry = db.execute(
        "SELECT url FROM entries ORDER BY RANDOM() LIMIT 1"
    ).fetchone()
    if entry:
        return redirect(entry["url"])
    return redirect(url_for("index"))


@app.route("/favicon/<path:domain>")
def favicon_proxy(domain):
    """Proxy favicons from Google so we can read them on a canvas (CORS)."""
    import urllib.request
    try:
        url = f"https://www.google.com/s2/favicons?sz=32&domain={domain}"
        req = urllib.request.Request(url, headers={"User-Agent": "rss-aggregator/1.0"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = resp.read()
            content_type = resp.headers.get("Content-Type", "image/png")
        return Response(data, mimetype=content_type,
                        headers={"Cache-Control": "public, max-age=604800"})
    except Exception:
        # Return a 1x1 transparent pixel
        return Response(
            b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01'
            b'\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01'
            b'\x00\x00\x05\x00\x01\r\n\xb4\x00\x00\x00\x00IEND\xaeB`\x82',
            mimetype="image/png",
            headers={"Cache-Control": "public, max-age=604800"})


@app.route("/feed.xml")
def rss_feed():
    db = get_db()
    entries = db.execute("""
        SELECT e.url, e.title, e.published, e.fetched_at,
               f.title AS feed_title
        FROM entries e
        JOIN feeds f ON e.feed_id = f.id
        ORDER BY COALESCE(e.published, e.fetched_at) DESC
        LIMIT 50
    """).fetchall()

    site_url = request.url_root.rstrip("/")
    now = datetime.now(timezone.utc).strftime("%a, %d %b %Y %H:%M:%S +0000")

    items = []
    for e in entries:
        pub = ""
        if e["published"]:
            try:
                dt = datetime.fromisoformat(e["published"])
                pub = dt.strftime("%a, %d %b %Y %H:%M:%S +0000")
            except Exception:
                pub = e["published"]
        elif e["fetched_at"]:
            pub = e["fetched_at"]

        title = (e["title"] or e["url"]).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        link = e["url"].replace("&", "&amp;")
        source = (e["feed_title"] or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

        items.append(f"""    <item>
      <title>{title}</title>
      <link>{link}</link>
      <guid>{link}</guid>
      {f'<pubDate>{pub}</pubDate>' if pub else ''}
      {f'<category>{source}</category>' if source else ''}
    </item>""")

    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>links</title>
    <link>{site_url}</link>
    <description>RSS link aggregator</description>
    <lastBuildDate>{now}</lastBuildDate>
{chr(10).join(items)}
  </channel>
</rss>"""

    return Response(xml, mimetype="application/rss+xml")


@app.route("/admin")
@requires_auth
def admin():
    db = get_db()
    feeds = db.execute("""
        SELECT f.*, COUNT(e.id) AS entry_count
        FROM feeds f
        LEFT JOIN entries e ON e.feed_id = f.id
        GROUP BY f.id
        ORDER BY f.title, f.url
    """).fetchall()
    return render_template("admin.html", feeds=feeds)


@app.route("/admin/add", methods=["POST"])
@requires_auth
def add_feed():
    url = request.form.get("url", "").strip()
    if not url:
        flash("URL is required.")
        return redirect(url_for("admin"))
    db = get_db()
    try:
        db.execute("INSERT INTO feeds (url) VALUES (?)", (url,))
        db.commit()
        # Poll it immediately so links show up
        feed = db.execute("SELECT id, url FROM feeds WHERE url = ?", (url,)).fetchone()
        if feed:
            poll_feed(feed["id"], feed["url"], db)
        flash(f"Added {url}")
    except sqlite3.IntegrityError:
        flash("Feed already exists.")
    return redirect(url_for("admin"))


@app.route("/admin/delete/<int:feed_id>", methods=["POST"])
@requires_auth
def delete_feed(feed_id):
    db = get_db()
    db.execute("DELETE FROM entries WHERE feed_id = ?", (feed_id,))
    db.execute("DELETE FROM feeds WHERE id = ?", (feed_id,))
    db.commit()
    flash("Feed removed.")
    return redirect(url_for("admin"))


@app.route("/admin/poll", methods=["POST"])
@requires_auth
def trigger_poll():
    poll_all()
    flash("Polled all feeds.")
    return redirect(url_for("admin"))


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------

init_db()

# Start background poller in a daemon thread
poller_thread = threading.Thread(target=poller_loop, daemon=True)
poller_thread.start()

if __name__ == "__main__":
    app.run(debug=True, port=5001)
