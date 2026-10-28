#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$DEPLOY_DIR/../.." && pwd)"
ENV_FILE="$DEPLOY_DIR/.env"
BASE_FILE="$ROOT_DIR/infra/compose/docker-compose.images.yml"
OVERLAY_FILE="$DEPLOY_DIR/docker-compose.yml"
SOURCE_FILE="$DEPLOY_DIR/docker-compose.source.yml"
source_mode=true
temporary=""

cleanup() {
  if [[ -n "$temporary" ]]; then
    rm -rf -- "$temporary"
  fi
}
trap cleanup EXIT

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

usage() {
  printf '%s\n' \
    'Usage: bash docs/deploy/deploy.sh COMMAND' \
    '  init --host PRIVATE_IPV4 [--port 5173]  Create local configuration once' \
    '       [--origin HTTPS_ORIGIN]           Use a public HTTPS origin behind a proxy' \
    '       [--from-template]                 Replace only an untouched copied template' \
    '  check                                 Check Docker and Compose configuration' \
    '  build                                 Build application and computer from source' \
    '  up                                    Build source and start/update services' \
    '  start                                 Start using already built source images' \
    '  up-images                             Pull published images and deploy instead' \
    '  start-images                          Start using already pulled published images' \
    '  stop                                  Stop services without deleting volumes' \
    '  status                                Show all service states' \
    '  health                                Check the running API' \
    '  logs [SERVICE]                        Show recent logs' \
    '  owner                                 Create a verified ordinary account' \
    '  backup --computers-stopped             Stop app services and back up data' \
    '  help                                  Show this help'
}

compose() {
  local files=(-f "$BASE_FILE" -f "$OVERLAY_FILE")
  if [[ "$source_mode" == true ]]; then
    files+=(-f "$SOURCE_FILE")
  fi
  docker compose --project-directory "$ROOT_DIR" --project-name rakazo-server \
    --env-file "$ENV_FILE" "${files[@]}" "$@"
}

source_image() {
  docker compose --project-directory "$ROOT_DIR" --project-name rakazo-server \
    --env-file "$ENV_FILE" -f "$SOURCE_FILE" config --images "$1"
}

version_at_least() {
  local actual="${1#v}"
  local minimum="$2"
  actual="${actual%%-*}"
  [[ "$actual" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  [[ "$(printf '%s\n' "$minimum" "$actual" | sort -V | sed -n '1p')" == "$minimum" ]]
}

check() {
  command -v docker >/dev/null 2>&1 || fail 'Docker Engine 26+ is required.'
  [[ -f "$ENV_FILE" ]] || fail 'Run init first. Restore the original .env for an existing installation.'
  [[ -f "$BASE_FILE" ]] || fail 'Keep docs/deploy inside a complete Rakazo checkout.'
  local engine_version compose_version
  engine_version="$(docker version --format '{{.Server.Version}}')" || fail 'Cannot reach the Docker daemon.'
  version_at_least "$engine_version" 26.0.0 || fail 'Docker Engine 26+ is required.'
  compose_version="$(docker compose version --short)" || fail 'The Docker Compose plugin is required.'
  version_at_least "$compose_version" 2.24.4 || fail 'Docker Compose 2.24.4+ is required for !override.'
  compose config --quiet
}

build_source() {
  [[ -f "$ROOT_DIR/infra/compose/Dockerfile" && -f "$ROOT_DIR/.dockerignore" ]] || fail 'The application Dockerfile and root .dockerignore are required.'
  local app_image computer_image revision=""
  app_image="$(source_image api)"
  computer_image="$(source_image computer)"
  if command -v git >/dev/null 2>&1; then
    revision="$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || true)"
  fi

  temporary="$(mktemp -d "$DEPLOY_DIR/.build.XXXXXX")"
  cp "$ROOT_DIR/infra/compose/Dockerfile" "$temporary/Dockerfile"
  cp "$ROOT_DIR/.dockerignore" "$temporary/Dockerfile.dockerignore"
  printf '\n%s\n' 'docs/deploy/backups' 'docs/deploy/.build.*' >>"$temporary/Dockerfile.dockerignore"
  docker build --file "$temporary/Dockerfile" --build-arg "GIT_SHA=$revision" --tag "$app_image" "$ROOT_DIR"
  docker build --tag "$computer_image" "$ROOT_DIR/infra/sandboxes/computer"
  rm -rf -- "$temporary"
  temporary=""
}

template_matches() {
  cmp -s \
    <(sed 's/\r$//; /^[[:space:]]*#/d; /^[[:space:]]*$/d' "$ENV_FILE") \
    <(sed 's/\r$//; /^[[:space:]]*#/d; /^[[:space:]]*$/d' "$DEPLOY_DIR/.env.example") || return 1
  local secret_name
  for secret_name in POSTGRES_PASSWORD POSTGRES_APP_PASSWORD BETTER_AUTH_SECRET ENCRYPTION_KEY SCREEN_PROXY_SECRET SANDBOX_SUPERVISOR_TOKEN; do
    grep -qx "${secret_name}=" <(sed 's/\r$//' "$ENV_FILE") || return 1
    if grep -Eq "^${secret_name}=.+" <(sed 's/\r$//' "$ENV_FILE"); then
      return 1
    fi
  done
}

init() {
  local host="" port=5173 origin=""
  local from_template=false replace_template=false
  while (($#)); do
    case "$1" in
      --host|--port|--origin)
        (($# >= 2)) || fail "Missing value for $1."
        case "$1" in
          --host) host="$2" ;;
          --port) port="$2" ;;
          --origin) origin="$2" ;;
        esac
        shift 2
        ;;
      --from-template) from_template=true; shift ;;
      *) fail "Unknown init option: $1" ;;
    esac
  done
  [[ -f "$DEPLOY_DIR/.env.example" ]] || fail 'Missing .env.example.'
  if [[ -e "$ENV_FILE" || -L "$ENV_FILE" ]]; then
    [[ "$from_template" == true ]] || fail 'Existing .env left unchanged. Use --from-template only for an untouched copied template on a new installation.'
    [[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || fail 'Existing .env must be a regular file, not a symlink.'
    template_matches || fail 'Existing .env differs from an empty template; no values were changed. Keep existing credentials and edit manually.'
    replace_template=true
  fi
  [[ "$host" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail '--host must be a private or loopback IPv4 address.'
  local first second third fourth octet
  IFS=. read -r first second third fourth <<<"$host"
  for octet in "$first" "$second" "$third" "$fourth"; do
    [[ "$octet" =~ ^(0|[1-9][0-9]{0,2})$ ]] || fail 'Invalid IPv4 address.'
    ((octet <= 255)) || fail 'Invalid IPv4 address.'
  done
  if ! ((first == 10 || first == 127 || (first == 172 && second >= 16 && second <= 31) || (first == 192 && second == 168))); then
    fail 'HTTP initialization is limited to private and loopback addresses. Use HTTPS for a public host.'
  fi
  [[ "$port" =~ ^[1-9][0-9]{0,4}$ ]] || fail 'Port must be an integer from 1 to 65535.'
  ((port <= 65535)) || fail 'Port must be an integer from 1 to 65535.'
  local public_host="$host" public_port="" label
  if [[ -n "$origin" ]]; then
    [[ "$origin" =~ ^https://([^/:?#@[:space:]]+)(:([1-9][0-9]{0,4}))?/?$ ]] || fail '--origin must be an HTTPS origin without credentials, path, query or fragment.'
    public_host="${BASH_REMATCH[1],,}"
    public_port="${BASH_REMATCH[3]:-}"
    ((${#public_host} <= 253)) || fail 'HTTPS hostname is too long.'
    [[ "$public_host" != .* && "$public_host" != *. && "$public_host" != *..* ]] || fail 'Invalid HTTPS hostname.'
    local labels
    IFS=. read -r -a labels <<<"$public_host"
    for label in "${labels[@]}"; do
      [[ "$label" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || fail 'Invalid HTTPS hostname.'
    done
    if [[ -n "$public_port" ]]; then
      ((public_port <= 65535)) || fail 'Invalid HTTPS port.'
    fi
    origin="https://$public_host"
    if [[ -n "$public_port" && "$public_port" != 443 ]]; then
      origin+=":$public_port"
    fi
  else
    origin="http://${host}:${port}"
  fi
  command -v openssl >/dev/null 2>&1 || fail 'OpenSSL is required to generate independent secrets.'

  local line key
  temporary="$(mktemp "$DEPLOY_DIR/.env.tmp.XXXXXX")"
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    key="${line%%=*}"
    case "$key" in
      RAKAZO_HOST) printf '%s=%s\n' "$key" "$public_host" ;;
      RAKAZO_BIND_ADDRESS) printf '%s=%s\n' "$key" "$host" ;;
      RAKAZO_WEB_PORT) printf '%s=%s\n' "$key" "$port" ;;
      BETTER_AUTH_URL|WEB_ORIGIN|API_URL) printf '%s=%s\n' "$key" "$origin" ;;
      POSTGRES_PASSWORD|POSTGRES_APP_PASSWORD) printf '%s=%s\n' "$key" "$(openssl rand -hex 16)" ;;
      BETTER_AUTH_SECRET|ENCRYPTION_KEY|SCREEN_PROXY_SECRET|SANDBOX_SUPERVISOR_TOKEN)
        printf '%s=%s\n' "$key" "$(openssl rand -hex 32)"
        ;;
      *) printf '%s\n' "$line" ;;
    esac
  done <"$DEPLOY_DIR/.env.example" >"$temporary"
  chmod 600 "$temporary"
  if [[ "$replace_template" == true ]]; then
    local original_template
    original_template="$(mktemp "$DEPLOY_DIR/.env.before-init.XXXXXX")"
    install -m 600 "$ENV_FILE" "$original_template"
    template_matches || fail 'Existing .env changed during initialization; no replacement was made.'
    mv -- "$temporary" "$ENV_FILE"
    printf '%s\n' 'Saved the original template as docs/deploy/.env.before-init.*.'
  else
    ln "$temporary" "$ENV_FILE"
    rm -f -- "$temporary"
  fi
  temporary=""
  printf '%s\n' 'Created docs/deploy/.env with independent secrets. Back it up privately before starting.'
}

owner() {
  local OWNER_EMAIL OWNER_PASSWORD
  read -r -p 'Account email: ' OWNER_EMAIL
  read -r -s -p 'Account password (at least 16 characters): ' OWNER_PASSWORD
  printf '\n'
  [[ -n "$OWNER_EMAIL" && ${#OWNER_PASSWORD} -ge 16 ]] || fail 'Email and a password of at least 16 characters are required.'
  export OWNER_EMAIL OWNER_PASSWORD
  compose exec -T -e OWNER_EMAIL -e OWNER_PASSWORD api node dist/cli/bootstrap-owner.js
  unset OWNER_EMAIL OWNER_PASSWORD
}

backup() {
  [[ "${1:-}" == --computers-stopped && $# == 1 ]] || fail 'Stop all agent computers in the UI, then run backup --computers-stopped.'
  local destination="$DEPLOY_DIR/backups/$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$DEPLOY_DIR/backups"
  mkdir "$destination"
  printf '%s\n' 'Stopping application services. They remain stopped if backup fails.'
  compose stop web worker api supervisor
  compose exec -T postgres sh -c \
    'pg_dump --format=custom --no-owner --no-privileges -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
    >"$destination/postgres.dump"
  compose run --rm --no-deps -T --entrypoint tar data-init -czf - -C /data . \
    >"$destination/appdata.tgz"
  install -m 600 "$ENV_FILE" "$destination/.env"
  compose exec -T postgres pg_restore --list <"$destination/postgres.dump" >/dev/null
  tar -tzf "$destination/appdata.tgz" >/dev/null
  (cd "$destination" && sha256sum .env postgres.dump appdata.tgz >SHA256SUMS)
  printf 'Backup completed: %s\n' "$destination"
  printf '%s\n' 'Keep this backup private and copy it off-host. Run deploy.sh start to resume services.'
}

command_name="${1:-help}"
if (($#)); then shift; fi
case "$command_name" in
  help|--help|-h) usage; exit 0 ;;
  init) init "$@"; exit 0 ;;
  up-images|start-images) source_mode=false ;;
  check|build|up|start|stop|status|health|logs|owner|backup) ;;
  *) usage >&2; fail "Unknown command: $command_name" ;;
esac

case "$command_name" in
  logs) (($# <= 1)) || fail 'logs accepts at most one service name.' ;;
  backup) [[ "${1:-}" == --computers-stopped && $# == 1 ]] || fail 'Stop all agent computers in the UI, then run backup --computers-stopped.' ;;
  *) (($# == 0)) || fail "$command_name does not accept arguments." ;;
esac

check
case "$command_name" in
  check) printf '%s\n' 'Docker versions and Compose configuration are valid. No services were started.' ;;
  build) build_source ;;
  up)
    build_source
    compose pull postgres data-init
    compose up -d --wait --wait-timeout 300 --pull never
    ;;
  up-images)
    compose pull
    compose up -d --wait --wait-timeout 300 --pull never
    ;;
  start|start-images) compose up -d --wait --wait-timeout 300 --pull never ;;
  stop) compose stop ;;
  status) compose ps --all ;;
  health)
    compose exec -T api node -e \
      'fetch("http://127.0.0.1:3100/health").then(response => { if (!response.ok) process.exit(1); console.log("API healthy"); }).catch(() => process.exit(1))'
    ;;
  logs) compose logs --tail 200 "$@" ;;
  owner) owner ;;
  backup) backup "$@" ;;
esac