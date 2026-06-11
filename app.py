import json
import os
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from functools import wraps
from pathlib import Path

import feedparser
from flask import Flask, Response, flash, g, redirect, render_template, request, url_for


def load_env(path=".env"):
    p = Path(__file__).parent / path
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
    db = sqlite3.connect(DATABASE)
    db.executescript("""
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
            FOREIGN KEY (feed_id) REFERENCES feeds(id) ON DELETE CASCADE,
            UNIQUE(feed_id, url)
        );
    """)

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
    migrate("ALTER TABLE feeds ADD COLUMN is_bookmark INTEGER DEFAULT 0")

    migrate("DROP INDEX IF EXISTS idx_entries_fetched")
    migrate("DROP INDEX IF EXISTS idx_entries_published")

    migrate("ALTER TABLE entries ADD COLUMN date TEXT")
    migrate(
        "UPDATE entries SET date = COALESCE(published, fetched_at) WHERE date IS NULL"
    )
    migrate("ALTER TABLE entries DROP COLUMN published")
    migrate("ALTER TABLE entries DROP COLUMN fetched_at")

    migrate("ALTER TABLE feeds DROP COLUMN color")

    migrate("CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date DESC)")

    migrate("ALTER TABLE entries ADD COLUMN hn_link TEXT")
    migrate("ALTER TABLE entries ADD COLUMN lobste_link TEXT")

    db.commit()
    db.close()


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


def _get_json(url: str, headers: dict | None = None):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)


def find_url_on_hn(url):
    def _norm(u: str) -> str:
        p = urllib.parse.urlsplit(u.strip())
        host = p.netloc.lower().removeprefix("www.")
        path = p.path.rstrip("/") or "/"
        return f"{host}{path}"

    normalized = _norm(url)
    q = urllib.parse.urlencode(
        {
            "query": url,
            "restrictSearchableAttributes": "url",
            "tags": "story",
            "hitsPerPage": 100,
        }
    )
    data = _get_json(f"https://hn.algolia.com/api/v1/search?{q}") or {}
    return next(
        (
            f"https://news.ycombinator.com/item?id={h['objectID']}"
            for h in data.get("hits", [])
            if h.get("url") and _norm(h["url"]) == normalized
        ),
        None,
    )


def find_url_on_lobste(url):
    q = urllib.parse.urlencode({"url": url})
    data = (
        _get_json(
            f"https://lobste.rs/stories/url/all.json?{q}",
            headers={"User-Agent": "url-check/1.0 (you@example.com)"},
        )
        or []
    )
    return next((s.get("comments_url") or s.get("short_id_url") for s in data), None)


def poll_feed(feed_id: int, feed_url: str, db: sqlite3.Connection):
    try:
        parsed = feedparser.parse(feed_url)
    except Exception as e:
        print(f"[poll] error fetching {feed_url}: {e}")
        return 0

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

    cutoff = (datetime.now(timezone.utc) - timedelta(days=3)).isoformat()
    rows = db.execute(
        "SELECT id, url, hn_link, lobste_link FROM entries "
        "WHERE feed_id = ? AND (hn_link IS NULL OR lobste_link IS NULL) AND date < ? "
        "ORDER BY date DESC LIMIT ?",
        (feed_id, cutoff, 25),
    ).fetchall()

    for entry_id, url, hn_link, lobste_link in rows:
        if not hn_link:
            hn_link = find_url_on_hn(url)
            db.execute(
                "UPDATE entries SET other_sites = ? WHERE id = ?",
                (hn_link, entry_id),
            )
        if not lobste_link:
            lobste_link = find_url_on_lobste(url)
            db.execute(
                "UPDATE entries SET other_sites = ? WHERE id = ?",
                (lobste_link, entry_id),
            )
        time.sleep(1)

    db.commit()


def poll_all():
    db = sqlite3.connect(DATABASE)
    db.row_factory = sqlite3.Row
    feeds = db.execute("SELECT id, url FROM feeds WHERE is_bookmark = 0").fetchall()
    total = 0
    total_upd = 0
    for feed in feeds:
        poll_feed(feed["id"], feed["url"], db)
    db.close()
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(
        f"[poll] {ts} — polled {len(feeds)} feeds, {total} new entries, {total_upd} updates"
    )


def poller_loop():
    while True:
        try:
            poll_all()
        except Exception as e:
            print(f"[poll] unhandled error: {e}")
        time.sleep(POLL_INTERVAL)


@app.template_filter("fromjson")
def fromjson(value):
    if not value:
        return {}
    try:
        return json.loads(value)
    except (ValueError, TypeError):
        return {}


@app.route("/")
def index():
    db = get_db()
    range_filter = request.args.get("range", "week")
    sites_only = request.args.get("sites_only", "0") == "1"

    entry_where = []
    feed_where = ["f.is_bookmark != 1"]

    if range_filter == "week":
        entry_where.append("e.date >= datetime('now', '-7 days')")
        feed_where.append("f.added_at >= datetime('now', '-7 days')")
    elif range_filter == "month":
        entry_where.append("e.date >= datetime('now', '-30 days')")
        feed_where.append("f.added_at >= datetime('now', '-30 days')")

    if sites_only:
        entry_where.append("f.is_bookmark = 1")
        feed_where.append("")

    sql = f"""
        SELECT
            e.id,
            e.url,
            e.title,
            e.date,
            e.visits,
            e.author,
            e.tags,
            e.other_sites,
            f.title AS feed_title,
            f.url AS feed_url,
            f.description AS feed_desc,
            f.is_bookmark AS is_bookmark,
            0 AS is_new_feed
        FROM entries e
        JOIN feeds f ON e.feed_id = f.id
        {"WHERE " + " AND ".join(entry_where) if entry_where else ""}
    """
    if not sites_only:
        sql += f"""
            UNION ALL

            SELECT
                NULL AS id,
                f.url,
                'New feed: ' || COALESCE(f.title, f.url),
                f.added_at,
                NULL,
                NULL,
                NULL,
                NULL,
                f.title,
                f.url,
                f.description,
                f.is_bookmark,
                1 AS is_new_feed
            FROM feeds f
            {"WHERE " + " AND ".join(feed_where) if feed_where else ""}

            ORDER BY date DESC
        """

    entries = db.execute(sql).fetchall()
    entries = [
        row
        if not row["is_new_feed"]
        else (
            dict(row) | {"url": f"https://{urllib.parse.urlparse(row['url']).netloc}"}
        )
        for row in entries
    ]

    feeds = db.execute("SELECT * FROM feeds ORDER BY title, url").fetchall()
    return render_template(
        "index.html",
        entries=entries,
        feeds=feeds,
        time_range=range_filter,
        sites_only=sites_only,
    )


@app.route("/random")
def random_link():
    db = get_db()
    rows = db.execute("SELECT id FROM entries ORDER BY RANDOM() LIMIT 1").fetchall()
    if not rows:
        return redirect(url_for("index"))
    return redirect(url_for("go", entry_id=rows[0]["id"]))


@app.route("/go/<int:entry_id>")
def go(entry_id):
    db = get_db()
    entry = db.execute(
        "SELECT url, last_visit_at FROM entries WHERE id = ?", (entry_id,)
    ).fetchone()
    if not entry:
        return redirect(url_for("index"))

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
    domain = urllib.parse.urlparse(feed_url).netloc
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
    db = get_db()
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

    data, mime = fetch_favicon(domain)
    if data is None:
        data = TRANSPARENT_PIXEL
        mime = "image/png"
    return Response(
        data, mimetype=mime, headers={"Cache-Control": "public, max-age=604800"}
    )


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


COMMON_FEED_PATHS = [
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
]


def _fetch_url(url: str):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "blogson/1.0"})
        with urllib.request.urlopen(req, timeout=2) as resp:
            return resp.read(2_000_000), resp.geturl(), None
    except urllib.error.HTTPError as e:
        return None, None, f"Server returned {e.code}"
    except urllib.error.URLError as e:
        return None, None, f"Couldn't reach that URL ({e.reason})"
    except Exception as e:
        return None, None, f"Couldn't fetch that URL ({type(e).__name__})"


def _is_valid_feed(parsed) -> bool:
    return bool(parsed.entries) or bool(parsed.get("version"))


def discover_feed(page_url: str, html_bytes: bytes) -> str | None:
    try:
        html = html_bytes.decode("utf-8", errors="ignore")
    except Exception:
        html = ""

    link_re = re.compile(
        r"<link\b[^>]*?"
        r'(?:rel=["\']alternate["\'][^>]*?type=["\']application/(?:rss|atom)\+xml["\']'
        r'|type=["\']application/(?:rss|atom)\+xml["\'][^>]*?rel=["\']alternate["\'])'
        r'[^>]*?href=["\']([^"\']+)["\']',
        re.IGNORECASE,
    )
    simple_re = re.compile(
        r'<link\b[^>]*?type=["\']application/(?:rss|atom)\+xml["\'][^>]*?href=["\']([^"\']+)["\']',
        re.IGNORECASE,
    )
    href_first_re = re.compile(
        r'<link\b[^>]*?href=["\']([^"\']+)["\'][^>]*?type=["\']application/(?:rss|atom)\+xml["\']',
        re.IGNORECASE,
    )

    for pattern in (link_re, simple_re, href_first_re):
        m = pattern.search(html)
        if m:
            candidate = urllib.parse.urljoin(page_url, m.group(1))
            content, final_url, err = _fetch_url(candidate)
            if content and _is_valid_feed(feedparser.parse(content)):
                return final_url

    parsed_url = urllib.parse.urlparse(page_url)
    root = f"{parsed_url.scheme}://{parsed_url.netloc}"
    for path in COMMON_FEED_PATHS:
        candidate = root + path
        content, final_url, err = _fetch_url(candidate)
        if content and _is_valid_feed(feedparser.parse(content)):
            return final_url

    return None


def validate_feed(url: str):
    if not url.startswith(("http://", "https://")):
        return False, "URL must start with http:// or https://", None

    content, final_url, err = _fetch_url(url)
    if content is None:
        return False, err, None

    parsed = feedparser.parse(content)

    if _is_valid_feed(parsed):
        return True, "ok", final_url

    discovered = discover_feed(final_url, content)
    if discovered:
        return True, f"Discovered feed at {discovered}", discovered

    return False, "No feed found", None


def _try_add_feed(url: str) -> None:
    url = (url or "").strip()
    if not url:
        flash("URL is required.")
        return

    db = get_db()

    existing = db.execute("SELECT 1 FROM feeds WHERE url = ?", (url,)).fetchone()
    if existing:
        flash("Feed already exists.")
        return

    ok, message, resolved_url = validate_feed(url)
    if not ok:
        flash(message)
        return

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


def _try_add_bookmark(url: str) -> None:
    url = (url or "").strip()
    if not url:
        flash("URL is required.")
        return
    if not url.startswith(("http://", "https://")):
        flash("URL must start with http:// or https://")
        return

    db = get_db()

    existing = db.execute("SELECT 1 FROM feeds WHERE url = ?", (url,)).fetchone()
    if existing:
        flash("Already added.")
        return

    content, final_url, err = _fetch_url(url)
    if content is None:
        flash(err)
        return

    if final_url != url:
        existing = db.execute(
            "SELECT 1 FROM feeds WHERE url = ?", (final_url,)
        ).fetchone()
        if existing:
            flash(f"Already added ({final_url}).")
            return

    try:
        db.execute("INSERT INTO feeds (url, is_bookmark) VALUES (?, 1)", (final_url,))
        db.commit()
        feed = db.execute("SELECT id FROM feeds WHERE url = ?", (final_url,)).fetchone()
        if feed:
            cache_feed_favicon(feed["id"], final_url, db)
            now = datetime.now(timezone.utc).isoformat()
            db.execute(
                "INSERT INTO entries (feed_id, url, title, date, tags) "
                "VALUES (?, ?, ?, ?, ?)",
                (feed["id"], final_url, final_url, now, "site"),
            )
            db.commit()
        flash(f"Added {final_url}")
    except sqlite3.IntegrityError:
        flash("Already added.")


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
    db = get_db()
    feeds = db.execute("SELECT id, url FROM feeds WHERE is_bookmark = 0").fetchall()
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
    db = get_db()
    result = db.execute(
        "UPDATE entries SET visits = 0, last_visit_at = NULL "
        "WHERE visits > 0 OR last_visit_at IS NOT NULL"
    )
    db.commit()
    flash(f"Cleared visits on {result.rowcount} entries.")
    return redirect(url_for("admin"))


@app.route("/submit")
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
def submit_add_feed():
    url = request.form.get("url", "")
    if request.form.get("no_rss"):
        _try_add_bookmark(url)
    else:
        _try_add_feed(url)
    return redirect(url_for("submit"))


@app.route("/robots.txt")
def robots():
    return app.send_static_file("robots.txt")


init_db()

poller_thread = threading.Thread(target=poller_loop, daemon=True)
poller_thread.start()

if __name__ == "__main__":
    app.run(debug=True, port=5001)
