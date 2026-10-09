# Homebase

Homebase is a shared dashboard for applications running on a home server. Everyone can browse and open the same links; the single `admin` account manages them.

## Requirements

- A Linux server with Git and Docker Engine plus the Docker Compose plugin installed.
- Ports 80 and 443 available for Homebase's Caddy web server.

## Install on a Linux server

Create a dedicated, non-login service account named `homebase`, then allow it to run Docker containers:

```sh
sudo useradd --create-home --shell /usr/sbin/nologin homebase
sudo usermod -aG docker homebase
```

Create a home for the project that the account owns. The `/srv` location keeps application files out of individual users' home directories:

```sh
sudo mkdir -p /srv/homebase
sudo chown homebase:homebase /srv/homebase
sudo -u homebase git clone https://github.com/hvmonteiro/homebase.git /srv/homebase
```

Create the local configuration, set a long unique admin password, and start Homebase:

```sh
sudo -u homebase cp /srv/homebase/.env.example /srv/homebase/.env
sudo -u homebase editor /srv/homebase/.env
sudo -u homebase docker compose -f /srv/homebase/compose.yaml up -d --build
```

Open `http://<server-ip>/` from your home network. Use the top-right `⋮` menu and sign in as `admin` to add shared application links.

> Docker's `docker` group grants elevated control over the host. Keep membership limited to the dedicated `homebase` account and trusted administrators.

## Updating

```sh
sudo -u homebase git -C /srv/homebase pull --ff-only
sudo -u homebase docker compose -f /srv/homebase/compose.yaml up -d --build
```

The shared directory is stored in `data/apps.json`. The `data/` directory is ignored by Git and bind-mounted into the application container, so updates do **not** replace it. Back up this directory regularly.

## HTTPS

The default configuration is plain HTTP for a LAN-only installation. If you have a hostname that resolves to this server, add this to `/srv/homebase/.env`:

```dotenv
HOMEBASE_ADDRESS=homebase.example.com
```

Then rerun the update command above. Caddy will obtain and renew HTTPS certificates automatically when the hostname is publicly reachable on ports 80 and 443.

## Project layout

- `server.js` — Fastify API, authentication, and JSON-file storage.
- `public/` — Homebase interface.
- `data/apps.json` — created automatically on first run; never commit it.
- `Caddyfile` and `compose.yaml` — web server and container deployment.

## License

Homebase is released under the [MIT License](LICENSE).
