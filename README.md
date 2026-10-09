# Homebase

Homebase is a shared dashboard for applications running on a home server. Everyone can view and open the same links; the single `admin` account manages them.

## Quick start

On the home server, clone this repository into a web-server directory, then create the environment file and start it:

```sh
git clone <your-repository-url> homebase
cd homebase
cp .env.example .env
# Edit .env and set a unique ADMIN_PASSWORD (at least 12 characters).
docker compose up -d --build
```

Open `http://<server-ip>/` from your home network. Use the top-right `⋮` menu and sign in as `admin` to add shared application links.

## Updating

```sh
git pull
docker compose up -d --build
```

Your shared links are stored in `data/apps.json`. That directory is ignored by Git and bind-mounted into the application container, so pulling updates does **not** replace your database.

## HTTPS

The default setup is plain HTTP for a LAN-only deployment. If you have a hostname that reaches this server, set this in `.env`:

```dotenv
HOMEBASE_ADDRESS=homebase.example.com
```

Then restart with `docker compose up -d`. Caddy will obtain and renew HTTPS certificates automatically. Ensure ports 80 and 443 are reachable for a public hostname.

## Files

- `server.js` — Fastify API, authentication, and JSON-file storage.
- `public/` — Homebase interface.
- `data/apps.json` — created automatically on first run; do not commit it.
- `Caddyfile` and `compose.yaml` — production deployment.

## Backups

Back up the `data/` directory. It contains the only persistent application data.
