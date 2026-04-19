# blogson

An RSS link aggregator. Not a reader.

Polls feeds on a timer, stores links in SQLite, renders them as a flat HTML page.

## Setup

```bash
pip install -r requirements.txt
cp .env.example .env     # edit credentials, secret key
python app.py
```

Runs on port 5001. Pages: `/` (links), `/admin`, `/submit`.

## Config

All in `.env`:

```
ADMIN_USER=...
ADMIN_PASS=...
SUBMIT_USER=...          # optional — falls back to admin creds
SUBMIT_PASS=...
SECRET_KEY=...           # generate: python3 -c "import secrets; print(secrets.token_hex(32))"
DATABASE=links.db
POLL_INTERVAL=10800       # seconds (3h)
```

## Routes

- `/` — main link list. Query params: `range=today|week|month|all`, `feed=<feed title>`.
- `/random` — opens a random entry (new tab). Weighted by inverse visit count.
- `/go/<id>` — increments visit count (rate-limited to 1/30s per entry), then redirects.
- `/feed.xml` — the aggregator's own RSS output.
- `/favicon/<domain>` — cached favicon proxy.
- `/admin` — full admin (add, remove, poll-all). Basic auth.
- `/submit` — add-only panel. Separate basic auth.

## How it works

- **Polling**: background thread, every `POLL_INTERVAL` seconds. Sequential.
- **Adding a feed**: URL is fetched, validated, and autodiscovered if it's a site
  rather than a feed itself. Tries `<link rel="alternate">` first, then common
  paths (`/feed`, `/rss`, `/atom.xml`, etc.). Specific error messages on failure.
- **Favicons**: cached as BLOBs in SQLite on feed add and during poll-all.
- **Colors**: extracted client-side from each favicon, applied as a gradient left
  border on entries. Lightness floor so dark icons stay readable.
- **Keyboard**: `j`/`k` navigate, `Enter` opens, `g` scrolls to top.

## Structure

```
app.py                   # routes, polling, db, validation, autodiscovery
templates/
  base.html              # shared skeleton
  index.html             # link list
  admin.html             # full admin
  submit.html            # add-only panel
static/
  style.css              # shared styles
  app.js                 # filter + color extraction + keyboard shortcuts
requirements.txt
.env                     # gitignored, per deploy
links.db                 # created on first run
```

## Deploying

Single-process Flask. In production, gunicorn with one worker so the poller
thread runs once:

```bash
gunicorn -w 1 -b 127.0.0.1:5001 app:app
```

Behind nginx + systemd.

## Auto-deploy via GitHub webhook

`deploy.py` is a tiny Flask app that listens for GitHub push events and runs
a deploy (stash local changes, rebase from origin, restart the main service).
Runs on port 5002 as its own systemd service so it's independent of blogson
itself — broken blogson doesn't break deploys.

Setup:

1. Pick a long random secret and set `WEBHOOK_SECRET` in `.env`.

2. Install the systemd unit:
   ```
   sudo cp deploy.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now deploy
   ```

3. Allow the user to restart blogson without a password. Create
   `/etc/sudoers.d/blogson-deploy` with:
   ```
   jan ALL=(root) NOPASSWD: /bin/systemctl restart rss
   ```

4. Proxy `/_hook` to port 5002 in your nginx config:
   ```
   location /_hook {
       proxy_pass http://127.0.0.1:5002;
       proxy_set_header Host $host;
   }
   ```
   Then `sudo nginx -t && sudo systemctl reload nginx`.

5. On GitHub: Repo Settings → Webhooks → Add webhook.
   - Payload URL: `https://your-domain/_hook`
   - Content type: `application/json`
   - Secret: same value as `WEBHOOK_SECRET`
   - Events: just the `push` event
   - Active: yes

GitHub sends a `ping` event on creation — if your webhook shows a green
check mark, it's working.
