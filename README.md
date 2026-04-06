# links

A deliberately dumb RSS link aggregator. Not a reader.

Polls feeds on a timer, dumps links into SQLite, renders them as flat HTML. That's it.

## Setup

```bash
pip install -r requirements.txt
python app.py
```

Open `http://localhost:5001` for the link dump, `/admin` to manage feeds (HTTP basic auth).

## Config

Edit the top of `app.py`:

```python
ADMIN_USER = "admin"
ADMIN_PASS = "changeme"      # change this
POLL_INTERVAL = 3600         # seconds between polls (default: 1 hour)
```

Also change `app.secret_key` to something random.

## How it works

- **Polling**: A background thread polls all feeds every `POLL_INTERVAL` seconds.
  New entries are inserted; duplicates (same feed + URL) are skipped.
- **Database**: SQLite with WAL mode. Two tables: `feeds` and `entries`.
- **Frontend**: The index shows the 300 most recent links. Client-side filtering by feed.
- **Admin**: HTTP basic auth. Add/remove feeds, trigger a manual poll.

## Deploying

This is a single-process Flask app. For a real deploy:

```bash
pip install gunicorn
gunicorn -w 1 -b 0.0.0.0:5001 app:app
```

Use `-w 1` (single worker) so the background poller thread runs once.

Alternatively, rip out the background thread and use a real cron job:

```bash
# crontab -e
0 * * * * cd /path/to/rss-aggregator && python -c "from app import poll_all; poll_all()"
```

## Structure

```
app.py              # everything: routes, polling, db
templates/
  index.html        # the link dump
  admin.html        # feed management
requirements.txt
links.db            # created on first run
```
