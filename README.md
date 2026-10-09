# Homebase

Homebase is a shared dashboard for applications running on a home server. Everyone can browse and open the same links; the single `admin` account manages them.

## Requirements

- A Linux server with Git and Docker Engine plus the Docker Compose plugin installed.
- One free TCP port for Homebase's Caddy web server (default: `8080`).

## Install on a Linux server

Create a dedicated, non-login service account named `homebase`, then create its empty home directory manually and allow it to run Docker containers:

```sh
sudo groupadd --force homebase
sudo useradd --no-create-home --shell /usr/sbin/nologin homebase
sudo install -d -o homebase -g homebase /home/homebase
sudo usermod --gid homebase --home /home/homebase homebase
sudo usermod -aG docker homebase
```

Clone the project into that account's home directory:

```sh
sudo -u homebase git clone https://github.com/hvmonteiro/homebase.git /home/homebase
```

Create the local configuration, set a long unique admin password, and start Homebase:

```sh
sudo -u homebase cp /home/homebase/.env.example /home/homebase/.env
sudo -u homebase editor /home/homebase/.env
sudo -u homebase sh -c 'cd /home/homebase && docker compose up -d --build'
```

Set `HOMEBASE_PORT` in `.env` to a free port, then open `http://<server-ip>:<HOMEBASE_PORT>/` from your home network. The default is `8080`. Use the top-right `⋮` menu and sign in as `admin` to add shared application links.

> Docker's `docker` group grants elevated control over the host. Keep membership limited to the dedicated `homebase` account and trusted administrators.

## Start at boot

Install the supplied **user-level** systemd unit after the first successful launch. User lingering keeps the `homebase` user manager running at boot even though the account cannot log in:

```sh
sudo install -d -o homebase -g homebase /home/homebase/.config/systemd/user
sudo install -m 644 -o homebase -g homebase \
  /home/homebase/deploy/homebase.service \
  /home/homebase/.config/systemd/user/homebase.service
sudo loginctl enable-linger homebase
sudo -u homebase XDG_RUNTIME_DIR=/run/user/$(id -u homebase) systemctl --user daemon-reload
sudo -u homebase XDG_RUNTIME_DIR=/run/user/$(id -u homebase) systemctl --user enable --now homebase.service
```

The service starts the existing Docker Compose stack in `homebase`'s systemd user space. Check it with:

```sh
sudo -u homebase XDG_RUNTIME_DIR=/run/user/$(id -u homebase) systemctl --user status homebase.service
```

## Manage Homebase

Use the included management script from an administrator shell:

```sh
sudo /home/homebase/scripts/homebase start
sudo /home/homebase/scripts/homebase stop
sudo /home/homebase/scripts/homebase restart
sudo /home/homebase/scripts/homebase reload
sudo /home/homebase/scripts/homebase update
```

`update` performs a fast-forward-only `git pull`, then rebuilds and restarts the Docker Compose stack. `reload` reapplies the current Compose configuration without stopping the service.

## Updating

```sh
sudo -u homebase git -C /home/homebase pull --ff-only
sudo -u homebase sh -c 'cd /home/homebase && docker compose up -d --build'
```

The shared directory is stored in `data/apps.json`. The `data/` directory is ignored by Git and bind-mounted into the application container, so updates do **not** replace it. Back up this directory regularly.

## Local customizations are preserved

Do not modify Git-tracked files for machine-specific settings. Use these local files instead:

- `.env` — the admin password, hostname, and other environment values.
- `data/apps.json` — the shared application directory.
- `compose.override.yaml` — optional Docker Compose changes.

The first two are created locally and ignored by Git. To create an override file:

```sh
sudo -u homebase cp /home/homebase/compose.override.example.yaml /home/homebase/compose.override.yaml
sudo -u homebase editor /home/homebase/compose.override.yaml
```

Git never overwrites ignored, untracked files during a clone or pull. Keep local changes in these files, then use the update command above safely.

## Troubleshooting

Run these commands as the `homebase` user—not as `root`—to avoid Git ownership warnings.

### Is the startup service running?

```sh
sudo -u homebase XDG_RUNTIME_DIR=/run/user/$(id -u homebase) \
  systemctl --user status homebase.service
```

Start or restart it if necessary:

```sh
sudo -u homebase XDG_RUNTIME_DIR=/run/user/$(id -u homebase) \
  systemctl --user restart homebase.service
```

### View service and container logs

```sh
# User-level systemd service logs
sudo -u homebase XDG_RUNTIME_DIR=/run/user/$(id -u homebase) \
  journalctl --user -u homebase.service -e

# Follow service logs live
sudo -u homebase XDG_RUNTIME_DIR=/run/user/$(id -u homebase) \
  journalctl --user -u homebase.service -f

# Homebase and Caddy container logs
sudo -u homebase sh -c 'cd /home/homebase && docker compose logs --tail=100'
```

### Is a port already in use or not listening?

Homebase uses the host port from `HOMEBASE_PORT` in `.env` (default: `8080`). Check the configured value:

```sh
grep '^HOMEBASE_PORT=' /home/homebase/.env
```

Check the container state:

```sh
sudo -u homebase sh -c 'cd /home/homebase && docker compose ps'
```

If the selected port is already in use, choose another value in `/home/homebase/.env`:

```dotenv
HOMEBASE_PORT=9443
```

Then restart Homebase and open `http://<server-ip>:9443/`.

## HTTPS

The default configuration is plain HTTP on the configurable `HOMEBASE_PORT`, which is suitable for a LAN-only installation or an existing reverse proxy. It deliberately does not claim host ports 80 or 443, allowing Tailscale or another web server to keep using them.

If you want Caddy itself to manage public HTTPS, expose host ports 80 and 443 through a custom Compose deployment and add a public hostname to `/home/homebase/.env`:

```dotenv
HOMEBASE_ADDRESS=homebase.example.com
```

Then rerun the update command above. Caddy can obtain and renew HTTPS certificates when that hostname is publicly reachable on ports 80 and 443. Otherwise, proxy to Homebase's configurable HTTP port from your existing HTTPS service.

## Project layout

- `server.js` — Fastify API, authentication, and JSON-file storage.
- `public/` — Homebase interface.
- `data/apps.json` — created automatically on first run; never commit it.
- `Caddyfile` and `compose.yaml` — web server and container deployment.
- `compose.override.example.yaml` — starting point for ignored, machine-specific Compose settings.
- `deploy/homebase.service` — systemd service for startup.
- `scripts/homebase` — administrative start, stop, restart, reload, and update command.

## License

Homebase is released under the [MIT License](LICENSE).
