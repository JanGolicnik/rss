"""
RSS Link Aggregator
A deliberately simple link dump. Not a reader.
Polls feeds, stores links in SQLite, renders them as flat HTML.
"""

import os
import random
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path
from urllib.parse import urljoin, urlparse

import feedparser
from flask import Flask, Response, flash, g, redirect, render_template, request, url_for

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
SUBMIT_USER = os.environ.get("SUBMIT_USER", ADMIN_USER)
SUBMIT_PASS = os.environ.get("SUBMIT_PASS", ADMIN_PASS)
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
            favicon_data BLOB,
            favicon_mime TEXT,
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
            FOREIGN KEY (feed_id) REFERENCES feeds(id) ON DELETE CASCADE,
            UNIQUE(feed_id, url)
        );
    """)

    # Migrations for existing databases. Each is idempotent via try/except.
    def migrate(sql):
        try:
            db.execute(sql)
        except sqlite3.OperationalError:
            pass

    migrate("ALTER TABLE feeds ADD COLUMN description TEXT")
    migrate("ALTER TABLE entries ADD COLUMN visits INTEGER DEFAULT 0")
    migrate("ALTER TABLE entries ADD COLUMN last_visit_at TEXT")
    migrate("ALTER TABLE entries ADD COLUMN author TEXT")
    migrate("ALTER TABLE entries ADD COLUMN tags TEXT")
    migrate("ALTER TABLE feeds ADD COLUMN favicon_data BLOB")
    migrate("ALTER TABLE feeds ADD COLUMN favicon_mime TEXT")

    # Drop old indexes first — SQLite refuses to DROP COLUMN while an index
    # still references it.
    migrate("DROP INDEX IF EXISTS idx_entries_fetched")
    migrate("DROP INDEX IF EXISTS idx_entries_published")

    # Unify published + fetched_at into a single `date` column.
    # Add it, backfill from COALESCE(published, fetched_at), drop the old ones.
    migrate("ALTER TABLE entries ADD COLUMN date TEXT")
    try:
        db.execute(
            "UPDATE entries SET date = COALESCE(published, fetched_at) "
            "WHERE date IS NULL"
        )
    except sqlite3.OperationalError:
        # Old columns don't exist — fresh install, nothing to backfill
        pass
    migrate("ALTER TABLE entries DROP COLUMN published")
    migrate("ALTER TABLE entries DROP COLUMN fetched_at")

    # Remove the unused `color` column on feeds
    migrate("ALTER TABLE feeds DROP COLUMN color")

    # Index on date — created here, after migrations have ensured the column exists
    migrate("CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date DESC)")

    db.commit()
    db.close()


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


def check_auth(username, password):
    return username == ADMIN_USER and password == ADMIN_PASS


def check_submit_auth(username, password):
    return username == SUBMIT_USER and password == SUBMIT_PASS


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


def requires_submit_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        auth = request.authorization
        if not auth or not check_submit_auth(auth.username, auth.password):
            return Response(
                "Login required.",
                401,
                {"WWW-Authenticate": 'Basic realm="Submit"'},
            )
        return f(*args, **kwargs)

    return decorated


# ---------------------------------------------------------------------------
# Feed polling
# ---------------------------------------------------------------------------


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

    if updates:
        set_clause = ", ".join(f"{k} = ?" for k in updates)
        db.execute(
            f"UPDATE feeds SET {set_clause} WHERE id = ?", (*updates.values(), feed_id)
        )

    new = 0
    for entry in parsed.entries:
        link = entry.get("link", "")
        if not link:
            continue
        title = entry.get("title", link)

        # Try to get a published date; fall back to current time.
        date = None
        for key in ("published_parsed", "updated_parsed"):
            tp = entry.get(key)
            if tp:
                try:
                    date = datetime(*tp[:6], tzinfo=timezone.utc).isoformat()
                except Exception:
                    pass
                break
        if date is None:
            date = datetime.now(timezone.utc).isoformat()

        # Author: feedparser normalizes this from various fields
        # (dc:creator, atom:author, author, etc.)
        author = entry.get("author") or None
        if author:
            author = author.strip() or None

        # Tags/categories: feedparser gives us a list of dicts with 'term' keys
        tags = None
        raw_tags = entry.get("tags", [])
        if raw_tags:
            tag_values = []
            for t in raw_tags:
                term = t.get("term") if isinstance(t, dict) else None
                if term and term.strip():
                    tag_values.append(term.strip())
            if tag_values:
                tags = ", ".join(tag_values)

        try:
            db.execute(
                "INSERT OR IGNORE INTO entries "
                "(feed_id, url, title, date, author, tags) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (feed_id, link, title, date, author, tags),
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
        time_clause = "WHERE e.date >= datetime('now', '-1 day')"
    elif range_filter == "week":
        time_clause = "WHERE e.date >= datetime('now', '-7 days')"
    elif range_filter == "month":
        time_clause = "WHERE e.date >= datetime('now', '-30 days')"
    elif range_filter == "all":
        limit = ""

    entries = db.execute(f"""
        SELECT e.id, e.url, e.title, e.date, e.visits,
               e.author, e.tags,
               f.title AS feed_title, f.url AS feed_url,
               f.description AS feed_desc
        FROM entries e
        JOIN feeds f ON e.feed_id = f.id
        {time_clause}
        ORDER BY e.date DESC
        {limit}
    """).fetchall()

    feeds = db.execute("SELECT * FROM feeds ORDER BY title, url").fetchall()
    return render_template(
        "index.html", entries=entries, feeds=feeds, time_range=range_filter
    )


@app.route("/random")
def random_link():
    db = get_db()
    # Weight by 1/(visits+1) so less-visited entries are more likely.
    rows = db.execute("SELECT id, visits FROM entries").fetchall()
    if not rows:
        return redirect(url_for("index"))
    weights = [1.0 / (r["visits"] + 1) for r in rows]
    chosen = random.choices(rows, weights=weights, k=1)[0]
    return redirect(url_for("go", entry_id=chosen["id"]))


@app.route("/go/<int:entry_id>")
def go(entry_id):
    """Redirect to an entry's URL, incrementing its visit count
    (rate-limited to 1 increment per 30s per entry)."""
    db = get_db()
    entry = db.execute(
        "SELECT url, last_visit_at FROM entries WHERE id = ?", (entry_id,)
    ).fetchone()
    if not entry:
        return redirect(url_for("index"))

    # Rate limit: only increment if last visit was >30s ago (or never)
    should_count = True
    if entry["last_visit_at"]:
        last = db.execute(
            "SELECT (julianday('now') - julianday(?)) * 86400 AS secs",
            (entry["last_visit_at"],),
        ).fetchone()
        if last and last["secs"] is not None and last["secs"] < 30:
            should_count = False

    if should_count:
        db.execute(
            "UPDATE entries SET visits = visits + 1, last_visit_at = datetime('now') "
            "WHERE id = ?",
            (entry_id,),
        )
        db.commit()

    return redirect(entry["url"])


TRANSPARENT_PIXEL = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01"
    b"\x00\x00\x05\x00\x01\r\n\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
)


def fetch_favicon(domain: str):
    """Fetch a favicon for a domain. Returns (bytes, mime_type) or (None, None)."""
    try:
        url = f"https://www.google.com/s2/favicons?sz=32&domain={domain}"
        req = urllib.request.Request(url, headers={"User-Agent": "rss-aggregator/1.0"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = resp.read()
            mime = resp.headers.get("Content-Type", "image/png")
        return data, mime
    except Exception:
        return None, None


def cache_feed_favicon(feed_id: int, feed_url: str, db: sqlite3.Connection):
    """Fetch and store a favicon for a feed. Always writes something (even
    if the fetch fails) so we don't retry forever."""
    domain = urlparse(feed_url).netloc
    if not domain:
        return
    data, mime = fetch_favicon(domain)
    if data is None:
        data = TRANSPARENT_PIXEL
        mime = "image/png"
    db.execute(
        "UPDATE feeds SET favicon_data = ?, favicon_mime = ? WHERE id = ?",
        (data, mime, feed_id),
    )


@app.route("/favicon/<path:domain>")
def favicon_proxy(domain):
    """Serve a cached favicon from the DB, falling back to a live Google
    lookup for domains we haven't cached yet (e.g. link entries from
    feeds whose domain differs)."""
    db = get_db()
    # Try the cached one first: match any feed whose URL contains this domain
    row = db.execute(
        "SELECT favicon_data, favicon_mime FROM feeds "
        "WHERE url LIKE ? AND favicon_data IS NOT NULL LIMIT 1",
        (f"%{domain}%",),
    ).fetchone()
    if row and row["favicon_data"]:
        return Response(
            row["favicon_data"],
            mimetype=row["favicon_mime"] or "image/png",
            headers={"Cache-Control": "public, max-age=604800"},
        )

    # Fallback: live fetch (for entry domains that aren't the feed domain)
    data, mime = fetch_favicon(domain)
    if data is None:
        data = TRANSPARENT_PIXEL
        mime = "image/png"
    return Response(
        data, mimetype=mime, headers={"Cache-Control": "public, max-age=604800"}
    )


@app.route("/feed.xml")
def rss_feed():
    db = get_db()
    entries = db.execute("""
        SELECT e.url, e.title, e.date,
               f.title AS feed_title
        FROM entries e
        JOIN feeds f ON e.feed_id = f.id
        ORDER BY e.date DESC
        LIMIT 50
    """).fetchall()

    site_url = request.url_root.rstrip("/")
    now = datetime.now(timezone.utc).strftime("%a, %d %b %Y %H:%M:%S +0000")

    items = []
    for e in entries:
        pub = ""
        if e["date"]:
            try:
                dt = datetime.fromisoformat(e["date"])
                pub = dt.strftime("%a, %d %b %Y %H:%M:%S +0000")
            except Exception:
                pub = e["date"]

        title = (
            (e["title"] or e["url"])
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
        )
        link = e["url"].replace("&", "&amp;")
        source = (
            (e["feed_title"] or "")
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
        )

        items.append(f"""    <item>
      <title>{title}</title>
      <link>{link}</link>
      <guid>{link}</guid>
      {f"<pubDate>{pub}</pubDate>" if pub else ""}
      {f"<category>{source}</category>" if source else ""}
    </item>""")

    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>blogson</title>
    <link>{site_url}</link>
    <description>blogson rss aggregator</description>
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
        ORDER BY f.added_at DESC
    """).fetchall()
    return render_template("admin.html", feeds=feeds)


# ---------------------------------------------------------------------------
# Feed validation & autodiscovery
# ---------------------------------------------------------------------------

COMMON_FEED_PATHS = [
    "/feed",
    "/feed/",
    "/rss",
    "/rss/",
    "/feed.xml",
    "/rss.xml",
    "/atom.xml",
    "/index.xml",
    "/feeds/posts/default",  # blogspot
    "/?feed=rss2",  # older wordpress
]


def _fetch_url(url: str):
    """Fetch a URL, following redirects. Returns (content, final_url, error).
    On success error is None and content/final_url are set; on failure
    content and final_url are None."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "blogson/1.0"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.read(2_000_000), resp.geturl(), None
    except urllib.error.HTTPError as e:
        return None, None, f"Server returned {e.code}"
    except urllib.error.URLError as e:
        return None, None, f"Couldn't reach that URL ({e.reason})"
    except Exception as e:
        return None, None, f"Couldn't fetch that URL ({type(e).__name__})"


def _is_valid_feed(parsed) -> bool:
    """True if feedparser's output looks like an actual feed.
    We accept anything with a 'version' field (set even for empty feeds)
    or entries."""
    return bool(parsed.entries) or bool(parsed.get("version"))


def discover_feed(page_url: str, html_bytes: bytes) -> str | None:
    """Given a site's HTML, try to find a linked RSS/Atom feed.
    Falls back to trying common feed paths against the site root.
    Returns a feed URL or None."""
    try:
        html = html_bytes.decode("utf-8", errors="ignore")
    except Exception:
        html = ""

    # 1. <link rel="alternate" type="application/rss+xml" href="...">
    #    Also matches atom+xml and "application/feed+json" where it exists.
    #    Regex is deliberately loose — attribute order varies by site.
    link_re = re.compile(
        r"<link\b[^>]*?"
        r'(?:rel=["\']alternate["\'][^>]*?type=["\']application/(?:rss|atom)\+xml["\']'
        r'|type=["\']application/(?:rss|atom)\+xml["\'][^>]*?rel=["\']alternate["\'])'
        r'[^>]*?href=["\']([^"\']+)["\']',
        re.IGNORECASE,
    )
    # Simpler fallback if the above misses unusual orderings:
    simple_re = re.compile(
        r'<link\b[^>]*?type=["\']application/(?:rss|atom)\+xml["\'][^>]*?href=["\']([^"\']+)["\']',
        re.IGNORECASE,
    )
    # Also try href-before-type
    href_first_re = re.compile(
        r'<link\b[^>]*?href=["\']([^"\']+)["\'][^>]*?type=["\']application/(?:rss|atom)\+xml["\']',
        re.IGNORECASE,
    )

    for pattern in (link_re, simple_re, href_first_re):
        m = pattern.search(html)
        if m:
            candidate = urljoin(page_url, m.group(1))
            content, final_url, err = _fetch_url(candidate)
            if content and _is_valid_feed(feedparser.parse(content)):
                return final_url

    # 2. Try common feed paths on the same host
    parsed_url = urlparse(page_url)
    root = f"{parsed_url.scheme}://{parsed_url.netloc}"
    for path in COMMON_FEED_PATHS:
        candidate = root + path
        content, final_url, err = _fetch_url(candidate)
        if content and _is_valid_feed(feedparser.parse(content)):
            return final_url

    return None


def validate_feed(url: str):
    """Validate a URL as a feed, discovering one from a site page if needed.

    Returns (ok, message, resolved_url) where:
      - ok: True if we ended up with a usable feed
      - message: user-facing status string
      - resolved_url: the actual feed URL after following any redirects and
        autodiscovery. May differ from input. None on failure.
    """
    # Shape check
    if not url.startswith(("http://", "https://")):
        return False, "URL must start with http:// or https://", None

    content, final_url, err = _fetch_url(url)
    if content is None:
        return False, err, None

    parsed = feedparser.parse(content)

    # If the URL is itself a feed, we're done (using the final URL after redirects)
    if _is_valid_feed(parsed):
        if not parsed.entries:
            return True, "Added, but the feed has no entries yet.", final_url
        return True, "ok", final_url

    # Not a feed — try to discover one from the page.
    # Pass the final URL so relative hrefs resolve against the redirected host.
    discovered = discover_feed(final_url, content)
    if discovered:
        return True, f"Discovered feed at {discovered}", discovered

    return False, "That URL isn't a feed, and I couldn't find one on the page.", None


def _try_add_feed(url: str) -> None:
    """Shared logic: validate a URL as a feed (discovering one from a site
    page if needed), insert it, poll it once, cache its favicon, and flash
    a status message."""
    url = (url or "").strip()
    if not url:
        flash("URL is required.")
        return

    db = get_db()

    # Check for existing first so we don't make a network call if not needed
    existing = db.execute("SELECT 1 FROM feeds WHERE url = ?", (url,)).fetchone()
    if existing:
        flash("Feed already exists.")
        return

    ok, message, resolved_url = validate_feed(url)
    if not ok:
        flash(message)
        return

    # The resolved URL might differ from the input (autodiscovery).
    # Re-check for duplicates against the resolved URL.
    if resolved_url != url:
        existing = db.execute(
            "SELECT 1 FROM feeds WHERE url = ?", (resolved_url,)
        ).fetchone()
        if existing:
            flash(f"Feed already exists ({resolved_url}).")
            return

    try:
        db.execute("INSERT INTO feeds (url) VALUES (?)", (resolved_url,))
        db.commit()
        feed = db.execute(
            "SELECT id, url FROM feeds WHERE url = ?", (resolved_url,)
        ).fetchone()
        if feed:
            poll_feed(feed["id"], feed["url"], db)
            cache_feed_favicon(feed["id"], feed["url"], db)
            db.commit()

        if resolved_url != url:
            flash(f"Added {resolved_url} (discovered from {url})")
        elif message != "ok":
            flash(f"Added {resolved_url} — {message}")
        else:
            flash(f"Added {resolved_url}")
    except sqlite3.IntegrityError:
        flash("Feed already exists.")


@app.route("/admin/add", methods=["POST"])
@requires_auth
def add_feed():
    _try_add_feed(request.form.get("url", ""))
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
    """Poll all feeds for new entries, and backfill author/tags on existing
    entries that don't have them yet."""
    db = get_db()
    feeds = db.execute("SELECT id, url FROM feeds").fetchall()
    backfilled = 0

    for feed in feeds:
        try:
            parsed = feedparser.parse(feed["url"])
        except Exception:
            continue

        for entry in parsed.entries:
            link = entry.get("link", "")
            if not link:
                continue

            author = entry.get("author") or None
            if author:
                author = author.strip() or None

            tags = None
            raw_tags = entry.get("tags", [])
            if raw_tags:
                tag_values = []
                for t in raw_tags:
                    term = t.get("term") if isinstance(t, dict) else None
                    if term and term.strip():
                        tag_values.append(term.strip())
                if tag_values:
                    tags = ", ".join(tag_values)

            if not author and not tags:
                continue

            result = db.execute(
                "UPDATE entries "
                "SET author = COALESCE(author, ?), tags = COALESCE(tags, ?) "
                "WHERE feed_id = ? AND url = ? "
                "AND (author IS NULL OR tags IS NULL)",
                (author, tags, feed["id"], link),
            )
            backfilled += result.rowcount

    db.commit()

    # Refresh all favicons (this catches feeds added before caching existed,
    # and picks up any favicon changes)
    favicons_cached = 0
    for feed in feeds:
        try:
            cache_feed_favicon(feed["id"], feed["url"], db)
            favicons_cached += 1
        except Exception:
            pass
    db.commit()

    poll_all()
    flash(
        f"Polled all feeds. Backfilled metadata on {backfilled} entries. "
        f"Refreshed {favicons_cached} favicons."
    )
    return redirect(url_for("admin"))


@app.route("/admin/clear-visits", methods=["POST"])
@requires_auth
def clear_visits():
    """Reset every entry's visit count and rate-limit timestamp to zero/null."""
    db = get_db()
    result = db.execute(
        "UPDATE entries SET visits = 0, last_visit_at = NULL "
        "WHERE visits > 0 OR last_visit_at IS NOT NULL"
    )
    db.commit()
    flash(f"Cleared visits on {result.rowcount} entries.")
    return redirect(url_for("admin"))


# ---------------------------------------------------------------------------
# Submit – add-only admin panel
# ---------------------------------------------------------------------------


@app.route("/submit")
@requires_submit_auth
def submit():
    db = get_db()
    feeds = db.execute("""
        SELECT f.*, COUNT(e.id) AS entry_count
        FROM feeds f
        LEFT JOIN entries e ON e.feed_id = f.id
        GROUP BY f.id
        ORDER BY f.added_at DESC
    """).fetchall()
    return render_template("submit.html", feeds=feeds)


@app.route("/submit/add", methods=["POST"])
@requires_submit_auth
def submit_add_feed():
    _try_add_feed(request.form.get("url", ""))
    return redirect(url_for("submit"))


@app.route("/robots.txt")
def robots():
    return app.send_static_file("robots.txt")


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------

init_db()

# Start background poller in a daemon thread
poller_thread = threading.Thread(target=poller_loop, daemon=True)
poller_thread.start()

if __name__ == "__main__":
    app.run(debug=True, port=5001)
