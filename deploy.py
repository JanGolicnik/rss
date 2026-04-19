"""
blogson auto-deploy webhook.

Listens for GitHub push events, verifies the HMAC signature, and runs
a deploy: stash local changes, rebase from origin/main, restart the
main service.

Runs as its own systemd service on port 5002, independent of blogson
itself — so if blogson is broken, we can still deploy a fix.
"""

import hashlib
import hmac
import os
import subprocess
from pathlib import Path

from flask import Flask, Response, request

# Load .env (same format blogson uses)
ENV_PATH = Path(__file__).parent / ".env"
if ENV_PATH.exists():
    for line in ENV_PATH.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())

WEBHOOK_SECRET = os.environ.get("WEBHOOK_SECRET", "").encode()
REPO_DIR = str(Path(__file__).parent)
SERVICE_NAME = os.environ.get("WEBHOOK_SERVICE_NAME", "rss")
BRANCH = os.environ.get("WEBHOOK_BRANCH", "main")

app = Flask(__name__)


def verify_signature(body: bytes, header: str) -> bool:
    """Check GitHub's HMAC-SHA256 signature against our secret."""
    if not header or not header.startswith("sha256="):
        return False
    expected = "sha256=" + hmac.new(WEBHOOK_SECRET, body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header)


def run(cmd: list[str], cwd: str | None = None) -> tuple[int, str]:
    """Run a command, capture combined stdout/stderr, return (exit_code, output)."""
    try:
        result = subprocess.run(
            cmd, cwd=cwd, capture_output=True, text=True, timeout=60
        )
        return result.returncode, (result.stdout + result.stderr).strip()
    except Exception as e:
        return -1, f"{type(e).__name__}: {e}"


@app.route("/_hook", methods=["POST"])
def webhook():
    if not WEBHOOK_SECRET:
        return Response("Webhook secret not configured", status=500)

    body = request.get_data()
    sig = request.headers.get("X-Hub-Signature-256", "")
    if not verify_signature(body, sig):
        return Response("Invalid signature", status=401)

    # Only react to push events on the configured branch
    event = request.headers.get("X-GitHub-Event", "")
    if event == "ping":
        return Response("pong\n", status=200)
    if event != "push":
        return Response(f"Ignoring event: {event}\n", status=200)

    payload = request.get_json(silent=True) or {}
    ref = payload.get("ref", "")
    if ref != f"refs/heads/{BRANCH}":
        return Response(f"Ignoring push to {ref}\n", status=200)

    # Deploy
    log = []

    def step(label, cmd, cwd=REPO_DIR):
        code, out = run(cmd, cwd=cwd)
        log.append(f"[{label}] exit={code}\n{out}")
        return code

    step("stash", ["git", "stash", "push", "-u", "-m", "auto-deploy"])
    step("fetch", ["git", "fetch", "origin", BRANCH])
    pull_code = step("rebase", ["git", "rebase", f"origin/{BRANCH}"])

    if pull_code != 0:
        log.append("[abort] rebase failed, not restarting service")
        print("\n".join(log))
        return Response("\n".join(log) + "\n", status=500)

    restart_code = step(
        "restart",
        ["sudo", "systemctl", "restart", SERVICE_NAME],
        cwd=None,
    )

    report = "\n".join(log)
    print(report)

    if restart_code != 0:
        return Response(report + "\n", status=500)
    return Response(report + "\n", status=200)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5002)
