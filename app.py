"""
RSS Link Aggregator
A deliberately simple link dump. Not a reader.
Polls feeds, stores links in SQLite, renders them as flat HTML.
"""

import sqlite3
import time
import threading
from datetime import datetime, timezone
from functools import wraps
from flask import (
    Flask, render_template, request, redirect, url_for, flash,
    Response, g
)
import feedparser

# ---------------------------------------------------------------------------
# Config – change these
# ---------------------------------------------------------------------------
DATABASE = "links.db"
ADMIN_USER = "admin"
ADMIN_PASS = "changeme"          # change this before deploying
POLL_INTERVAL = 3600             # seconds (1 hour)

app = Flask(__name__)
app.secret_key = "replace-me-with-something-random"

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

def poll_feed(feed_id: int, feed_url: str, db: sqlite3.Connection) -> int:
    """Fetch a single feed, insert new entries. Returns count of new items."""
    try:
        parsed = feedparser.parse(feed_url)
    except Exception as e:
        print(f"[poll] error fetching {feed_url}: {e}")
        return 0

    # Update feed title if we got one
    if parsed.feed.get("title"):
        db.execute("UPDATE feeds SET title = ? WHERE id = ?",
                    (parsed.feed.title, feed_id))

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
    # Grab the 300 most recent entries, joined with feed info
    entries = db.execute("""
        SELECT e.url, e.title, e.published, e.fetched_at,
               f.title AS feed_title, f.url AS feed_url
        FROM entries e
        JOIN feeds f ON e.feed_id = f.id
        ORDER BY e.fetched_at DESC, e.published DESC
        LIMIT 300
    """).fetchall()

    feeds = db.execute("SELECT * FROM feeds ORDER BY title, url").fetchall()
    return render_template("index.html", entries=entries, feeds=feeds)


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
