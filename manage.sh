#!/usr/bin/env bash
# Manage the Homebase user-level systemd service.
set -Eeuo pipefail

readonly SERVICE_USER="homebase"
readonly INSTALL_DIR="/home/homebase"
readonly UNIT_NAME="homebase.service"
readonly UNIT_SOURCE="${INSTALL_DIR}/deploy/${UNIT_NAME}"
readonly UNIT_DESTINATION="${INSTALL_DIR}/.config/systemd/user/${UNIT_NAME}"
readonly CRON_SOURCE="${INSTALL_DIR}/deploy/homebase.cron"
readonly CRON_DESTINATION="/etc/cron.d/homebase"
readonly LOGROTATE_SOURCE="${INSTALL_DIR}/deploy/homebase.logrotate"
readonly LOGROTATE_DESTINATION="/etc/logrotate.d/homebase"

usage() {
  cat <<'EOF'
Usage: sudo /home/homebase/manage.sh <command>

Commands:
  install   Install, enable, and start the Homebase user service
  uninstall Stop and remove the Homebase user service; preserves app data
  start     Start Homebase
  stop      Stop Homebase
  restart   Restart Homebase
  reload    Reapply the current Compose configuration without stopping Homebase
  update    Check GitHub, then update the app and Docker images when available
  install-cron   Run the update check every six hours through cron and rotate its log
  uninstall-cron Remove Homebase's cron update check and log rotation policy
  status    Show the Homebase user-service status
  help      Show this help text
EOF
}

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this command with sudo." >&2
  exit 1
fi

service_uid="$(id -u "${SERVICE_USER}")"
runtime_dir="/run/user/${service_uid}"

run_as_service_user() {
  runuser -u "${SERVICE_USER}" -- env \
    XDG_RUNTIME_DIR="${runtime_dir}" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=${runtime_dir}/bus" \
    "$@"
}

service_command() {
  run_as_service_user /usr/bin/systemctl --user "$1" "${UNIT_NAME}"
}

require_installation() {
  if [[ ! -d ${INSTALL_DIR}/.git ]]; then
    echo "Homebase was not found at ${INSTALL_DIR}." >&2
    exit 1
  fi
}

install_service() {
  require_installation
  if [[ ! -f ${UNIT_SOURCE} ]]; then
    echo "Service definition was not found at ${UNIT_SOURCE}." >&2
    exit 1
  fi
  install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" "${INSTALL_DIR}/.config/systemd/user"
  install -m 644 -o "${SERVICE_USER}" -g "${SERVICE_USER}" "${UNIT_SOURCE}" "${UNIT_DESTINATION}"
  /usr/bin/loginctl enable-linger "${SERVICE_USER}"
  run_as_service_user /usr/bin/systemctl --user daemon-reload
  run_as_service_user /usr/bin/docker compose --project-directory "${INSTALL_DIR}" up -d --build
  service_command enable
  service_command start
  echo "Homebase is installed and running as a systemd user service."
}

uninstall_service() {
  run_as_service_user /usr/bin/systemctl --user disable --now "${UNIT_NAME}" 2>/dev/null || true
  rm -f "${UNIT_DESTINATION}"
  run_as_service_user /usr/bin/systemctl --user daemon-reload
  echo "Homebase systemd service removed. The repository, local settings, and shared data were preserved."
}

update_homebase() {
  require_installation
  run_as_service_user /usr/bin/git -C "${INSTALL_DIR}" fetch --quiet origin
  local current_revision remote_revision
  current_revision="$(run_as_service_user /usr/bin/git -C "${INSTALL_DIR}" rev-parse HEAD)"
  remote_revision="$(run_as_service_user /usr/bin/git -C "${INSTALL_DIR}" rev-parse '@{u}')"

  if [[ ${current_revision} != "${remote_revision}" ]]; then
    run_as_service_user /usr/bin/git -C "${INSTALL_DIR}" pull --ff-only
    echo "Homebase source updated."
  else
    echo "Homebase source is already current."
  fi

  run_as_service_user /usr/bin/docker compose --project-directory "${INSTALL_DIR}" pull
  run_as_service_user /usr/bin/docker compose --project-directory "${INSTALL_DIR}" up -d --build
}

install_cron() {
  require_installation
  if [[ ! -f ${CRON_SOURCE} ]]; then
    echo "Cron definition was not found at ${CRON_SOURCE}." >&2
    exit 1
  fi
  if [[ ! -f ${LOGROTATE_SOURCE} ]]; then
    echo "Log rotation definition was not found at ${LOGROTATE_SOURCE}." >&2
    exit 1
  fi
  install -m 644 "${CRON_SOURCE}" "${CRON_DESTINATION}"
  install -m 644 "${LOGROTATE_SOURCE}" "${LOGROTATE_DESTINATION}"
  echo "Homebase will check for source and Docker image updates every six hours."
}

uninstall_cron() {
  rm -f "${CRON_DESTINATION}"
  rm -f "${LOGROTATE_DESTINATION}"
  echo "Homebase's cron update check and log rotation policy were removed."
}

case "${1:-}" in
  install)
    install_service
    ;;
  uninstall)
    uninstall_service
    ;;
  start|stop|restart|reload)
    require_installation
    service_command "$1"
    ;;
  update)
    update_homebase
    ;;
  install-cron)
    install_cron
    ;;
  uninstall-cron)
    uninstall_cron
    ;;
  status)
    service_command status
    ;;
  -h|--help|help|'')
    usage
    ;;
  *)
    echo "Unknown command: $1" >&2
    usage >&2
    exit 2
    ;;
esac
