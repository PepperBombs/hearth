#!/usr/bin/env bash
#
# hearth-deploy: pull-based deployment for one server.
#
# A systemd timer runs this every minute (see deploy/systemd). Each run:
#
#   1. fetches the main branch of the framework repository and of the
#      mini-apps repository;
#   2. stops there, silently, if neither has a new commit;
#   3. otherwise builds a fresh release in a new folder named after the time;
#   4. starts that build on a spare port and checks that it answers;
#   5. points the "current" link at it (one atomic rename) and restarts the
#      service, then checks the running service;
#   6. keeps the newest few releases and deletes the rest.
#
# If any step fails, the release that was running keeps running, the reason
# is logged, and the exit status is not zero.
#
# Layout under HEARTH_BASE (default /opt/hearth):
#
#   repos/hearth, repos/hearth-stones   clones; this script only fetches them
#   releases/20260101T120000Z/        one folder per release
#       hearth/                       the framework at one commit, built
#       hearth-stones/                  the mini-apps at one commit
#       RELEASE                       which commits, and when
#       release.env                   HEARTH_VERSION for the service
#   current -> releases/...           the release the service runs
#   logs/                             build output, one file per attempt
#   state/                            notes this script leaves for itself
#   pnpm-store/                       pnpm's package store
#   deploy.lock                       held while a run is in progress
#
# Secrets: this script never reads the service's secrets file. The build and
# the trial start get a clean environment, so nothing secret can reach a log.
#
# Usage: hearth-deploy [CONFIG_FILE]
#   The config file defaults to $HEARTH_DEPLOY_CONFIG, then
#   /etc/hearth/deploy.conf. See deploy/deploy.conf.example.

set -Eeuo pipefail
export LC_ALL=C
# Releases must be readable by the user the service runs as.
umask 022

# ---------------------------------------------------------------------------
# Settings (overridden by the config file)
# ---------------------------------------------------------------------------
HEARTH_BASE=/opt/hearth
FRAMEWORK_REPO=
APPS_REPO=
REMOTE=origin
BRANCH=main
KEEP_RELEASES=5
SERVICE=hearth.service
LIVE_URL=http://127.0.0.1:4310
HEALTH_PORT=4319
HEALTH_TIMEOUT=30
RETRY_AFTER_MINUTES=15

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
log() {
  # Under systemd the journal adds the time itself.
  if [[ -n ${JOURNAL_STREAM:-} ]]; then
    printf '%s\n' "$*"
  else
    printf '%s  %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
  fi
}

# Hides a user name or token written into a URL, as in https://token@host/.
redact() {
  sed -E 's#(://)[^/@[:space:]]+@#\1***@#g'
}

# State shared with die() and the exit handler.
attempt_key=""      # "<framework commit> <apps commit>" once a build starts
new_release=""      # folder of the release being built
activated=no        # yes once "current" points at the new release
health_pid=""       # the trial server, while it runs
build_log=""
previous_note="Nothing was changed."

die() {
  trap - ERR
  set +e
  log "ERROR: $*" >&2
  if [[ -n $build_log && -s $build_log ]]; then
    log "Last lines of $build_log:" >&2
    tail -n 40 -- "$build_log" | redact | sed 's/^/    /' >&2
  fi
  if [[ -n $attempt_key ]]; then
    mkdir -p -- "$state_dir" && printf '%s\n' "$attempt_key" >"$state_dir/failed"
  fi
  log "$previous_note" >&2
  exit 1
}

stop_health_server() {
  if [[ -n $health_pid ]]; then
    kill "$health_pid" 2>/dev/null || true
    wait "$health_pid" 2>/dev/null || true
    health_pid=""
  fi
}

on_exit() {
  local status=$?
  trap - EXIT
  stop_health_server
  if [[ -n $new_release && $activated != yes && -d $new_release ]]; then
    rm -rf -- "$new_release" || true
  fi
  exit "$status"
}
trap on_exit EXIT
trap 'die "Interrupted."' INT TERM
trap 'die "An unexpected error occurred on line $LINENO."' ERR

# ---------------------------------------------------------------------------
# Config file: lines of NAME=value. No shell code is run from it.
# ---------------------------------------------------------------------------
load_config() {
  local file=$1 line number=0 name value
  [[ -r $file ]] || die "Cannot read the config file $file."
  while IFS= read -r line || [[ -n $line ]]; do
    number=$((number + 1))
    line=${line%$'\r'}
    [[ $line =~ ^[[:space:]]*(#.*)?$ ]] && continue
    [[ $line =~ ^[[:space:]]*([A-Z_]+)[[:space:]]*=[[:space:]]*(.*)$ ]] ||
      die "$file, line $number: expected NAME=value."
    name=${BASH_REMATCH[1]}
    value=${BASH_REMATCH[2]}
    value=${value%"${value##*[![:space:]]}"}
    if [[ $value =~ ^\"(.*)\"$ || $value =~ ^\'(.*)\'$ ]]; then
      value=${BASH_REMATCH[1]}
    fi
    case $name in
      HEARTH_BASE | FRAMEWORK_REPO | APPS_REPO | REMOTE | BRANCH | KEEP_RELEASES | \
        SERVICE | LIVE_URL | HEALTH_PORT | HEALTH_TIMEOUT | RETRY_AFTER_MINUTES)
        printf -v "$name" '%s' "$value"
        ;;
      *) die "$file, line $number: $name is not a setting this script knows." ;;
    esac
  done <"$file"
}

# number_between VALUE MIN MAX
number_between() { [[ $1 =~ ^[0-9]{1,9}$ ]] && ((10#$1 >= $2 && 10#$1 <= $3)); }

check_settings() {
  [[ $HEARTH_BASE == /* && $HEARTH_BASE != / ]] || die "HEARTH_BASE must be an absolute path."
  [[ -n $FRAMEWORK_REPO ]] || die "FRAMEWORK_REPO is not set: the clone of the framework repository."
  [[ $FRAMEWORK_REPO == /* ]] || die "FRAMEWORK_REPO must be an absolute path."
  [[ -z $APPS_REPO || $APPS_REPO == /* ]] || die "APPS_REPO must be an absolute path, or empty."
  [[ $REMOTE =~ ^[A-Za-z0-9._-]+$ ]] || die "REMOTE must be the name of a Git remote, such as origin."
  [[ $BRANCH =~ ^[A-Za-z0-9._/-]+$ ]] || die "BRANCH must be the name of a branch, such as main."
  number_between "$KEEP_RELEASES" 1 1000 || die "KEEP_RELEASES must be a number, at least 1."
  number_between "$HEALTH_PORT" 1 65535 || die "HEALTH_PORT must be a port number."
  number_between "$HEALTH_TIMEOUT" 1 3600 || die "HEALTH_TIMEOUT must be a number of seconds, at least 1."
  number_between "$RETRY_AFTER_MINUTES" 0 100000 || die "RETRY_AFTER_MINUTES must be a number of minutes."
  [[ -z $SERVICE || $SERVICE =~ ^[A-Za-z0-9:_.@-]+\.service$ ]] || die "SERVICE must be a unit name such as hearth.service, or empty."
  [[ -z $SERVICE || $LIVE_URL =~ ^http://[^/[:space:]]+$ ]] || die "LIVE_URL must look like http://127.0.0.1:4310, with no path."
}

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

# release_value FILE NAME: one value from a RELEASE file.
release_value() {
  [[ -r $1 ]] || return 0
  sed -n "s/^$2=//p" -- "$1" | head -n 1
}

# The name of the release that "current" points at, or nothing.
current_release_name() {
  local target
  target=$(readlink -- "$HEARTH_BASE/current" 2>/dev/null) || return 0
  basename -- "$target"
}

is_release_name() { [[ $1 =~ ^[0-9]{8}T[0-9]{6}Z$ ]]; }

# fetch_main REPO LABEL: fetches the branch and leaves the commit it is at in
# $fetched_commit.
fetched_commit=""
fetch_main() {
  local repo=$1 label=$2 output
  git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 ||
    die "$repo is not a Git repository (the $label)."
  if ! output=$(GIT_TERMINAL_PROMPT=0 timeout 120 git -C "$repo" fetch --quiet --no-tags \
    "$REMOTE" "+refs/heads/$BRANCH:refs/remotes/$REMOTE/$BRANCH" 2>&1); then
    [[ -z $output ]] || printf '%s\n' "$output" | redact | sed 's/^/    /' >&2
    die "Could not fetch $BRANCH of the $label."
  fi
  fetched_commit=$(git -C "$repo" rev-parse --verify --quiet "refs/remotes/$REMOTE/$BRANCH^{commit}") ||
    die "The $label has no branch $BRANCH on $REMOTE."
}

# export_commit REPO COMMIT FOLDER: the files of one commit, without Git data.
export_commit() {
  mkdir -p -- "$3"
  git -C "$1" archive --format=tar "$2" | tar -x --no-same-owner -C "$3"
}

# Runs a command with nothing in its environment but what a build needs.
clean_env() {
  local name keep=()
  # A server that reaches the internet through a proxy needs these.
  for name in HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy \
    NODE_EXTRA_CA_CERTS SSL_CERT_FILE SSL_CERT_DIR; do
    if [[ -n ${!name:-} ]]; then keep+=("$name=${!name}"); fi
  done
  env -i PATH="$PATH" HOME="${HOME:-$HEARTH_BASE}" LANG=C.UTF-8 CI=true "${keep[@]}" "$@"
}

# probe BASE_URL VERSION PAGE: succeeds when /api/health reports VERSION and,
# if PAGE is "page", the web app's front page is served too.
probe() {
  node --input-type=module -e '
    const [base, version, page] = process.argv.slice(1);
    const get = (path) => fetch(base + path, { signal: AbortSignal.timeout(3000) });
    try {
      const health = await get("/api/health");
      if (!health.ok) throw new Error(`/api/health answered ${health.status}`);
      const body = await health.json();
      if (body.ok !== true) throw new Error("/api/health did not say ok");
      if (body.version !== version) {
        throw new Error(`it reports version ${body.version}, not ${version}`);
      }
      if (page === "page") {
        const front = await get("/");
        if (!front.ok) throw new Error(`the web app answered ${front.status}`);
      }
    } catch (error) {
      const code = error.cause?.code;
      console.error(code ? `no answer (${code})` : error.message);
      process.exit(1);
    }
  ' "$1" "$2" "$3"
}

# port_in_use PORT: succeeds when something on this machine listens on PORT.
port_in_use() {
  node -e '
    const socket = require("node:net").connect(Number(process.argv[1]), "127.0.0.1");
    socket.on("connect", () => process.exit(0));
    socket.on("error", () => process.exit(1));
  ' "$1"
}

# wait_healthy BASE_URL VERSION PAGE [PID]: probes once a second until it
# succeeds, HEALTH_TIMEOUT passes, or the process PID is gone. On failure the
# reason is left in $probe_reason.
probe_reason=""
wait_healthy() {
  local url=$1 version=$2 page=$3 pid=${4:-} deadline=$((SECONDS + HEALTH_TIMEOUT))
  while :; do
    if [[ -n $pid ]] && ! kill -0 "$pid" 2>/dev/null; then
      probe_reason="the server stopped right after starting"
      return 1
    fi
    if probe_reason=$(probe "$url" "$version" "$page" 2>&1); then
      # Make sure the answer came from our process, not something else.
      if [[ -z $pid ]] || kill -0 "$pid" 2>/dev/null; then return 0; fi
      continue
    fi
    ((SECONDS < deadline)) || return 1
    sleep 1
  done
}

# point_current NAME: makes "current" a link to releases/NAME in one step.
point_current() {
  ln -sfn -- "releases/$1" "$HEARTH_BASE/.current.new"
  mv -T -- "$HEARTH_BASE/.current.new" "$HEARTH_BASE/current"
}

restart_service() {
  local output
  if ! output=$(timeout 90 systemctl --no-ask-password restart "$SERVICE" 2>&1); then
    [[ -z $output ]] || printf '%s\n' "$output" | sed 's/^/    /' >&2
    return 1
  fi
}

# Restarts the service and waits for it to report VERSION.
restart_and_check() {
  local version=$1
  if ! restart_service; then
    probe_reason="systemctl could not restart $SERVICE (may this user restart it? see docs/self-hosting.md)"
    return 1
  fi
  wait_healthy "$LIVE_URL" "$version" api
}

prune_releases() {
  local current dir name names=() excess removed=0
  current=$(current_release_name)
  for dir in "$HEARTH_BASE"/releases/*/; do
    name=$(basename -- "$dir")
    [[ -d $dir && ! -L ${dir%/} ]] && is_release_name "$name" && names+=("$name")
  done
  # Names are times, so the shell's sorted glob lists the oldest first.
  excess=$((${#names[@]} - KEEP_RELEASES))
  for name in "${names[@]}"; do
    ((excess > 0)) || break
    [[ $name == "$current" ]] && continue
    rm -rf -- "$HEARTH_BASE/releases/$name"
    excess=$((excess - 1))
    removed=$((removed + 1))
  done
  if ((removed > 0)); then
    log "Removed $removed old release(s); keeping the newest $KEEP_RELEASES."
    # Packages that no release uses any more.
    clean_env pnpm store prune --store-dir "$HEARTH_BASE/pnpm-store" >/dev/null 2>&1 || true
  fi
  # Build logs: keep the newest 20.
  find "$HEARTH_BASE/logs" -maxdepth 1 -type f -name '*.log' -printf '%f\n' 2>/dev/null |
    sort | head -n -20 | while IFS= read -r name; do
    rm -f -- "$HEARTH_BASE/logs/$name"
  done
}

# ---------------------------------------------------------------------------
# Start
# ---------------------------------------------------------------------------
config_file=${1:-${HEARTH_DEPLOY_CONFIG:-/etc/hearth/deploy.conf}}
state_dir="" # set once the base folder is known; die() needs it only later
load_config "$config_file"
check_settings
state_dir=$HEARTH_BASE/state

if [[ $EUID -eq 0 ]]; then
  die "Do not run this as root: files it creates would belong to root. Run it as the deploy user, for example: systemctl start hearth-deploy.service"
fi
for tool in git node pnpm tar flock timeout; do
  command -v "$tool" >/dev/null 2>&1 || die "The command '$tool' is not installed or not on PATH."
done
[[ -z $SERVICE ]] || command -v systemctl >/dev/null 2>&1 || die "systemctl is not on PATH."
[[ -d $HEARTH_BASE && -w $HEARTH_BASE ]] || die "$HEARTH_BASE does not exist or this user cannot write to it."

mkdir -p -- "$HEARTH_BASE/releases" "$HEARTH_BASE/logs" "$state_dir"

# One run at a time. A second run leaves at once; the next timer tick retries.
exec 9>"$HEARTH_BASE/deploy.lock"
if ! flock -n 9; then
  log "Another deploy is still running; leaving it to finish."
  exit 0
fi

# Leftovers of a run that was cut short (power loss): folders with no RELEASE.
current_name=$(current_release_name)
for dir in "$HEARTH_BASE"/releases/*/; do
  name=$(basename -- "$dir")
  if [[ -d $dir ]] && is_release_name "$name" && [[ $name != "$current_name" && ! -e $dir/RELEASE ]]; then
    log "Removing the unfinished release $name left by an interrupted run."
    rm -rf -- "${dir%/}"
  fi
done

# A run that switched "current" but could not confirm the restart leaves a
# note. Finish that job before looking for anything new.
if [[ -n $SERVICE && -e $state_dir/restart-pending && -n $current_name ]]; then
  pending_version=$(release_value "$HEARTH_BASE/current/RELEASE" version)
  log "An earlier run switched to release $current_name but could not confirm the restart. Trying again."
  if restart_and_check "$pending_version"; then
    rm -f -- "$state_dir/restart-pending"
    log "$SERVICE now runs release $current_name (version $pending_version)."
  else
    previous_note="\"current\" points at $current_name, but $SERVICE is not running it. Check: systemctl status $SERVICE"
    die "$SERVICE did not come up on release $current_name: $probe_reason."
  fi
fi

# ---------------------------------------------------------------------------
# 1. Fetch, and decide whether there is anything to do
# ---------------------------------------------------------------------------
fetch_main "$FRAMEWORK_REPO" "framework repository"
framework_commit=$fetched_commit
apps_commit=none
if [[ -n $APPS_REPO ]]; then
  fetch_main "$APPS_REPO" "mini-apps repository"
  apps_commit=$fetched_commit
fi

deployed_framework=$(release_value "$HEARTH_BASE/current/RELEASE" framework)
deployed_apps=$(release_value "$HEARTH_BASE/current/RELEASE" apps)
if [[ $framework_commit == "$deployed_framework" && $apps_commit == "$deployed_apps" ]]; then
  [[ -z ${HEARTH_DEPLOY_VERBOSE:-} ]] || log "Nothing new: $BRANCH is already deployed."
  exit 0
fi

wanted="$framework_commit $apps_commit"
failed_file=$state_dir/failed
if [[ -e $failed_file && $(<"$failed_file") == "$wanted" ]]; then
  if [[ -z $(find "$failed_file" -mmin "+$RETRY_AFTER_MINUTES" 2>/dev/null) ]]; then
    log "ERROR: the newest commits (framework ${framework_commit:0:12}, mini-apps ${apps_commit:0:12}) failed to deploy earlier. Trying again $RETRY_AFTER_MINUTES minutes after that attempt, or at once after a new commit, or after deleting $failed_file." >&2
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# 2. Build a fresh release
# ---------------------------------------------------------------------------
version=$(git -C "$FRAMEWORK_REPO" rev-parse --short "$framework_commit")
stamp=$(date -u +%Y%m%dT%H%M%SZ)
previous_name=$current_name
if [[ -n $previous_name ]]; then
  previous_note="Release $previous_name is still the one in use."
else
  previous_note="There is no earlier release; nothing is running yet."
fi

attempt_key=$wanted
new_release=$HEARTH_BASE/releases/$stamp
build_log=$HEARTH_BASE/logs/$stamp.log
[[ ! -e $new_release ]] || die "The folder $new_release already exists."
mkdir -- "$new_release"
: >"$build_log"

log "New commits: framework ${framework_commit:0:12}, mini-apps ${apps_commit:0:12}. Building release $stamp (version $version)."

export_commit "$FRAMEWORK_REPO" "$framework_commit" "$new_release/hearth" >>"$build_log" 2>&1 ||
  die "Could not copy the framework's files into the release."
if [[ -n $APPS_REPO ]]; then
  # Mini-apps are only copied for now. The step that adds the mini-app
  # contract decides how they are built.
  export_commit "$APPS_REPO" "$apps_commit" "$new_release/hearth-stones" >>"$build_log" 2>&1 ||
    die "Could not copy the mini-apps' files into the release."
fi

log "Installing dependencies (pnpm install --frozen-lockfile)."
(cd -- "$new_release/hearth" &&
  clean_env pnpm install --frozen-lockfile --store-dir "$HEARTH_BASE/pnpm-store") >>"$build_log" 2>&1 ||
  die "pnpm install failed."

log "Building (pnpm build)."
(cd -- "$new_release/hearth" &&
  clean_env HEARTH_VERSION="$version" pnpm build) >>"$build_log" 2>&1 ||
  die "pnpm build failed."

server_dir=$new_release/hearth/packages/server
[[ -f $server_dir/dist/main.js ]] || die "The build did not produce packages/server/dist/main.js."
[[ -f $new_release/hearth/packages/web/dist/index.html ]] || die "The build did not produce packages/web/dist/index.html."

# ---------------------------------------------------------------------------
# 3. Start the new build on a spare port and check it
# ---------------------------------------------------------------------------
# It runs with made-up settings and a database that exists only in memory,
# so it touches neither the real data nor the secrets file. Sign-in stays on,
# so it would let nobody in even if something could reach it.
log "Checking the new build on port $HEALTH_PORT."
if port_in_use "$HEALTH_PORT"; then
  die "Port $HEALTH_PORT is already in use, so the new build cannot be checked there. Free it or change HEALTH_PORT."
fi
(cd -- "$server_dir" && exec env -i PATH="$PATH" NODE_ENV=production \
  HOST=127.0.0.1 PORT="$HEALTH_PORT" HEARTH_DB=":memory:" \
  HEARTH_AUTH=cloudflare-access HEARTH_CF_TEAM_DOMAIN=health-check.example.com \
  HEARTH_CF_AUDIENCE=health-check HEARTH_OWNER_EMAIL=health-check@example.com \
  HEARTH_VERSION="$version" node dist/main.js) >>"$build_log" 2>&1 9>&- &
health_pid=$!
if ! wait_healthy "http://127.0.0.1:$HEALTH_PORT" "$version" page "$health_pid"; then
  die "The new build failed its check on port $HEALTH_PORT: $probe_reason."
fi
stop_health_server
log "The new build answers correctly."

{
  printf 'framework=%s\n' "$framework_commit"
  printf 'apps=%s\n' "$apps_commit"
  printf 'version=%s\n' "$version"
  printf 'built=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} >"$new_release/RELEASE"
printf 'HEARTH_VERSION=%s\n' "$version" >"$new_release/release.env"

# ---------------------------------------------------------------------------
# 4. Switch over and restart
# ---------------------------------------------------------------------------
[[ -z $SERVICE ]] || : >"$state_dir/restart-pending"
point_current "$stamp" || die "Could not point \"current\" at the new release."
activated=yes
build_log="" # from here on a failure is not about the build

if [[ -z $SERVICE ]]; then
  log "SERVICE is empty, so nothing was restarted."
elif restart_and_check "$version"; then
  rm -f -- "$state_dir/restart-pending"
elif [[ -n $previous_name ]]; then
  failure=$probe_reason
  log "ERROR: $SERVICE did not come up on release $stamp: $failure. Going back to release $previous_name." >&2
  point_current "$previous_name"
  activated=no
  previous_version=$(release_value "$HEARTH_BASE/current/RELEASE" version)
  if restart_and_check "$previous_version"; then
    rm -f -- "$state_dir/restart-pending"
    previous_note="Release $previous_name is running again."
  else
    previous_note="\"current\" points at release $previous_name again, but $SERVICE could not be confirmed on it: $probe_reason. Check: systemctl status $SERVICE"
  fi
  die "Release $stamp was built but did not start as the service: $failure."
else
  previous_note="This is the first release, so there is nothing to go back to. \"current\" points at it; the next run tries the restart again. Check: systemctl status $SERVICE"
  attempt_key=""
  die "$SERVICE did not come up on release $stamp: $probe_reason."
fi

rm -f -- "$failed_file"
log "Release $stamp is live (version $version)."

# ---------------------------------------------------------------------------
# 5. Tidy up
# ---------------------------------------------------------------------------
prune_releases || log "WARNING: could not remove old releases; the deploy itself succeeded." >&2

installed_script=$(command -v -- "$0" 2>/dev/null || printf '%s' "$0")
if ! cmp -s -- "$installed_script" "$new_release/hearth/deploy/hearth-deploy.sh"; then
  log "NOTE: deploy/hearth-deploy.sh in this release differs from the installed copy ($installed_script). Install the new one when convenient; see docs/self-hosting.md."
fi
exit 0
