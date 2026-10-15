# Homebase agent guide

## Project purpose

Homebase is a lightweight, self-hosted dashboard for applications on a home server. Everyone on the home network can open shared application links; a single `admin` account manages the directory.

Repository: `https://github.com/hvmonteiro/homebase.git`

## Architecture

- `server.js` is the Fastify server and JSON API.
- `public/index.html` is the complete browser UI: HTML, CSS, and browser-side JavaScript live together intentionally.
- `public/favicon.svg` is the Homebase favicon.
- `data/apps.json` is the shared application directory at runtime. It is local, ignored by Git, and must never be replaced by updates.
- `compose.yaml` runs the Node application behind Caddy. The externally mapped port comes from `HOMEBASE_PORT` in `.env`.
- `deploy/homebase.service` is a **user-level** systemd unit, run by the `homebase` account.
- `homebase` at the repository root is the administrative command for installing, controlling, updating, and uninstalling the user service.

## Local configuration and data safety

Never overwrite, delete, or commit these local deployment files:

- `.env` — admin password and machine-specific settings.
- `data/apps.json` — shared application links.
- `compose.override.yaml` — optional machine-specific Compose customization.

Use `.env.example` and `compose.override.example.yaml` as tracked templates only. Keep all site-specific changes in the ignored files above so `git pull --ff-only` remains safe.

## Deployment conventions

- The Linux service account is `homebase`, with home directory `/home/homebase` and no interactive login shell.
- Homebase is installed in `/home/homebase`.
- Manage it with `sudo /home/homebase/homebase <command>`.
- The user service needs systemd lingering enabled so it starts at server boot.
- `sudo /home/homebase/homebase install-cron` installs a six-hour source and Docker-image update check in `/etc/cron.d/homebase`.
- Do not claim that Homebase owns host ports 80 or 443. The default public port is `8080`; Tailscale or another reverse proxy may use 443.

## UI conventions

- Preserve the dark, calm Homebase visual language and accessible keyboard controls.
- Application cards are fully clickable links. Keep management controls out of the cards.
- Category and availability belong in the card status bar: category on the bottom-left, health dot on the bottom-right.
- Availability checks run in the browser once on load and every 60 seconds. Keep the interval at 60,000 ms unless requirements change.
- Use in-app dialogs for management and destructive-action confirmation; do not use browser `confirm()` dialogs.
- The editor should suggest existing categories while allowing a new category, and icons are chosen with the emoji picker rather than typed manually.
- Keep the management table visible behind nested add/edit dialogs; closing an editor returns to the manager.

## Validation and Git workflow

- Before committing UI edits, run `node --check server.js` and validate the inline client script with the existing Node syntax check pattern when practical.
- Run `git diff --check` before each commit.
- Preserve other contributors' work. If the remote advanced, rebase safely with `git pull --rebase` before pushing; resolve conflicts without discarding either side.
- Commit focused changes with descriptive messages and push to `main` only when the user has authorized publishing.

## Attribution

- License copyright: Hugo V. Monteiro.
- UI footer: `© 2026 Hugo V Monteiro`, linking to `https://www.hugovmonteiro.net`.
