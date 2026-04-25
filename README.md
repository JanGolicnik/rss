# blogson

a RSS link aggregator !

## Setup

```bash
pip install -r requirements.txt
vim .env
python app.py
```

## Config

```
ADMIN_USER=...
ADMIN_PASS=...
SECRET_KEY=...           # generate: python3 -c "import secrets; print(secrets.token_hex(32))"
DATABASE=links.db
POLL_INTERVAL=10800       # seconds (3h)
```
