#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

MODE=interactive
REGENERATE_CERTS=0
for arg in "$@"; do
  case "$arg" in
    --interactive) MODE=interactive ;;
    --non-interactive) MODE=non-interactive ;;
    --regenerate-certs) REGENERATE_CERTS=1 ;;
    -h|--help)
      printf 'Usage: %s [--interactive|--non-interactive] [--regenerate-certs]\n' "$(basename "$0")"
      exit 0
      ;;
    *) printf 'Error: unknown option: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

fail() { printf 'Error: %s\n' "$1" >&2; exit 1; }

for cmd in docker openssl python3 curl; do
  command -v "$cmd" >/dev/null 2>&1 || fail "$cmd is required. Install it before continuing."
done
docker compose version >/dev/null 2>&1 || fail 'Docker Compose plugin is required.'

get_env() {
  python3 - "$1" <<'PY'
import pathlib, sys
key = sys.argv[1]
path = pathlib.Path('.env')
for line in path.read_text().splitlines():
    if line.startswith(key + '='):
        print(line.split('=', 1)[1])
        break
PY
}

set_env() {
  local key="$1" value="$2"
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || fail "Newlines are not allowed in ${key}."
  python3 - "$key" "$value" <<'PY'
import pathlib, sys
key, value = sys.argv[1:]
path = pathlib.Path('.env')
lines = path.read_text().splitlines() if path.exists() else []
replacement = f'{key}={value}'
found = False
out = []
for line in lines:
    if line.startswith(key + '='):
        if not found:
            out.append(replacement)
            found = True
    else:
        out.append(line)
if not found:
    out.append(replacement)
path.write_text('\n'.join(out) + '\n')
PY
}

is_placeholder() {
  local value="${1,,}"
  [[ -z "$value" || "$value" == *replace* || "$value" == *example.com* || "$value" == *change-me* || "$value" == *your_* || "$value" == *placeholder* ]]
}

new_hex() { openssl rand -hex "$1"; }

if [[ ! -f .env ]]; then
  [[ "$MODE" == interactive ]] || fail '.env is missing. Create it from .env.example before using --non-interactive.'
  [[ -f .env.example ]] || fail '.env.example is missing.'
  cp .env.example .env
  chmod 600 .env

  printf '\nInitial configuration\n'
  read -r -p 'Title ID: ' title_id
  [[ "$title_id" =~ ^[A-Za-z0-9_-]{1,64}$ ]] || fail 'A valid Title ID is required.'
  read -r -p 'Public domain name: ' domain
  [[ "$domain" =~ ^[A-Za-z0-9.-]+$ ]] || fail 'Enter a valid domain without a scheme or path.'
  read -r -p 'Administrator email: ' admin_email
  [[ "$admin_email" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || fail 'Enter a valid administrator email.'
  read -r -p 'Photon App ID (optional): ' photon_app_id

  postgres_password="$(new_hex 32)"
  session_secret="$(new_hex 48)"
  admin_password="$(new_hex 24)"
  grafana_password="$(new_hex 24)"
  totp_secret="$(python3 -c 'import base64,secrets; print(base64.b32encode(secrets.token_bytes(20)).decode().rstrip("="))')"

  set_env TITLE_ID "$title_id"
  set_env DOMAIN "$domain"
  set_env ADMIN_EMAIL "$admin_email"
  set_env ADMIN_USERNAME "$admin_email"
  set_env PHOTON_APP_ID "$photon_app_id"
  set_env POSTGRES_PASSWORD "$postgres_password"
  set_env SESSION_SECRET "$session_secret"
  set_env ADMIN_PASSWORD "$admin_password"
  set_env ADMIN_TOTP_SECRET "$totp_secret"
  set_env GRAFANA_PASSWORD "$grafana_password"
  chmod 600 .env

  printf '\nAdministrator: %s\n' "$admin_email"
  printf 'Administrator password: %s\n' "$admin_password"
  printf 'Authenticator secret: %s\n' "$totp_secret"
  printf 'Grafana username: %s\n' "$(get_env GRAFANA_USER)"
  printf 'Grafana password: %s\n' "$grafana_password"
  printf 'Store these credentials securely.\n'
fi

required_vars=(TITLE_ID DOMAIN ADMIN_EMAIL ADMIN_USERNAME POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD SESSION_SECRET ADMIN_PASSWORD ADMIN_TOTP_SECRET GRAFANA_USER GRAFANA_PASSWORD)
for key in "${required_vars[@]}"; do
  value="$(get_env "$key")"
  is_placeholder "$value" && fail "${key} is missing or contains a placeholder in .env."
done

TITLE_ID="$(get_env TITLE_ID)"
DOMAIN="$(get_env DOMAIN)"
[[ "$TITLE_ID" =~ ^[A-Za-z0-9_-]{1,64}$ ]] || fail 'TITLE_ID in .env is invalid.'
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || fail 'DOMAIN in .env is invalid.'
chmod 600 .env

mkdir -p nginx/certs
cert_file=nginx/certs/fullchain.pem
key_file=nginx/certs/privkey.pem
create_cert=0
if [[ "$REGENERATE_CERTS" -eq 1 || ! -s "$cert_file" || ! -s "$key_file" ]]; then
  create_cert=1
elif ! openssl x509 -in "$cert_file" -noout -checkhost "$DOMAIN" >/dev/null 2>&1; then
  create_cert=1
elif ! openssl x509 -in "$cert_file" -noout -checkend 86400 >/dev/null 2>&1; then
  create_cert=1
fi

if [[ "$create_cert" -eq 1 ]]; then
  rm -f "$cert_file" "$key_file"
  openssl req -x509 -nodes -newkey rsa:3072 -sha256 -days 365 \
    -keyout "$key_file" -out "$cert_file" \
    -subj "/CN=${DOMAIN}" \
    -addext "subjectAltName=DNS:${DOMAIN},DNS:localhost,IP:127.0.0.1"
  chmod 644 "$cert_file"
  chmod 600 "$key_file"
  printf 'A self-signed certificate was generated for %s. Install a trusted certificate before public production use.\n' "$DOMAIN"
fi

mkdir -p backups
if [[ "${EUID}" -eq 0 ]]; then
  chown 1000:1000 backups
  chmod 750 backups
fi

docker compose config --quiet
docker compose up -d --build

health_url="https://${DOMAIN}/health"
healthy=0
for attempt in $(seq 1 60); do
  if curl --silent --show-error --fail --insecure --connect-timeout 3 \
    --resolve "${DOMAIN}:443:127.0.0.1" "$health_url" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 2
done

if [[ "$healthy" -ne 1 ]]; then
  printf 'The application did not become healthy within 120 seconds.\n' >&2
  docker compose ps >&2 || true
  docker compose logs --tail=100 app >&2 || true
  exit 1
fi

printf '\nApplication health check passed.\n'
printf 'Status: docker compose ps\n'
printf 'Application logs: docker compose logs -f app\n'
printf 'Health endpoint: %s\n' "$health_url"
printf 'Admin console: https://%s/Admin/ui\n' "$DOMAIN"
printf 'Routine updates: docker compose up -d --build\n'
printf 'Do not use docker compose down -v unless you intend to delete persistent volumes.\n'
