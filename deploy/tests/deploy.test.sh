#!/usr/bin/env bash
#
# Tests for deploy/hearth-deploy.sh: what it does when a release fails.
#
# Run it with `pnpm test:deploy` at the repository root (after `pnpm install`).
#
# The real script runs unchanged. Around it stand small substitutes:
#
#   git        a folder of "commits" instead of a repository
#   pnpm       "install" links the SQLite library; "build" does nothing,
#              because each made-up commit already holds its built files
#   systemctl  starts and stops the made-up server as "the service"
#   server     applies numbered migrations to a real SQLite file exactly as
#              the real server does (each in its own transaction, refusing a
#              database with a migration it does not know), then answers
#              /api/health
#
# Nothing outside a temporary folder is touched, and no network is used.

set -Eeuo pipefail
export LC_ALL=C

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "$here/../.." && pwd)
script=$repo_root/deploy/hearth-deploy.sh
sqlite_package=$repo_root/packages/server/node_modules/better-sqlite3

for tool in node tar flock timeout; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "deploy tests: the command '$tool' is missing." >&2
    exit 1
  }
done
[[ -d $sqlite_package ]] || {
  echo "deploy tests: $sqlite_package is missing. Run pnpm install first." >&2
  exit 1
}

# The deploy script refuses to run as root. In a container that has only
# root, run the whole test as an unprivileged user instead.
if [[ $EUID -eq 0 ]]; then
  if ! command -v setpriv >/dev/null 2>&1; then
    echo "deploy tests: SKIPPED. They cannot run as root, and setpriv is not here to drop root."
    exit 0
  fi
  T=$(mktemp -d "${TMPDIR:-/tmp}/hearth-deploy-test.XXXXXX")
  trap 'rm -rf -- "$T"' EXIT
  chown 65534:65534 "$T"
  chmod 755 "$T"
  setpriv --reuid=65534 --regid=65534 --clear-groups \
    env HOME="$T" HEARTH_DEPLOY_TEST_DIR="$T" bash "${BASH_SOURCE[0]}"
  exit $?
fi

if [[ -n ${HEARTH_DEPLOY_TEST_DIR:-} ]]; then
  T=$HEARTH_DEPLOY_TEST_DIR
else
  T=$(mktemp -d "${TMPDIR:-/tmp}/hearth-deploy-test.XXXXXX")
fi

BASE=$T/base
FRAMEWORK=$T/framework
DATABASE=$T/data/hearth.db
mkdir -p "$BASE" "$FRAMEWORK/commits" "$T/bin" "$T/data"
: >"$T/systemctl.log"
: >"$T/git.log"
: >"$T/service.pid"

cleanup() {
  local status=$?
  trap - EXIT
  if [[ -s $T/service.pid ]]; then kill "$(<"$T/service.pid")" 2>/dev/null || true; fi
  if [[ $status -ne 0 ]]; then
    echo "--- output of the last deploy run ---" >&2
    cat "$T/out.log" >&2 2>/dev/null || true
    echo "--- service log ---" >&2
    cat "$T/service.log" >&2 2>/dev/null || true
  fi
  [[ -n ${HEARTH_DEPLOY_TEST_DIR:-} ]] || rm -rf -- "$T"
  exit "$status"
}
trap cleanup EXIT
trap 'echo "deploy tests: unexpected error on line $LINENO." >&2' ERR

free_port() {
  node -e '
    const server = require("node:net").createServer();
    server.listen(0, "127.0.0.1", () => {
      console.log(server.address().port);
      server.close();
    });
  '
}
LIVE_PORT=$(free_port)
HEALTH_PORT=$(free_port)

# ---------------------------------------------------------------------------
# Substitutes
# ---------------------------------------------------------------------------
cat >"$T/bin/git" <<EOF
#!/usr/bin/env bash
# Called as: git -C REPO COMMAND ...
[[ \$1 == -C ]] || exit 2
repo=\$2
shift 2
case \$1 in
  rev-parse)
    case \$2 in
      --git-dir) [[ -d \$repo/commits ]] && echo .git ;;
      --verify) cat "\$repo/main" ;;
      --short) printf '%s\n' "\${3:0:7}" ;;
      *) exit 2 ;;
    esac
    ;;
  fetch) echo fetch >>"$T/git.log" ;;
  archive) tar -c -C "\$repo/commits/\${*: -1}" . ;;
  *) exit 2 ;;
esac
EOF

cat >"$T/bin/pnpm" <<EOF
#!/usr/bin/env bash
if [[ \$1 == install ]]; then
  mkdir -p packages/server/node_modules
  ln -s "$sqlite_package" packages/server/node_modules/better-sqlite3
fi
EOF

cat >"$T/bin/systemctl" <<EOF
#!/usr/bin/env bash
# Called as: systemctl --no-ask-password VERB UNIT
verb=\$2
printf '%s\n' "\$verb" >>"$T/systemctl.log"
stop() {
  local pid
  [[ -s $T/service.pid ]] || return 0
  pid=\$(<"$T/service.pid")
  kill "\$pid" 2>/dev/null
  for _ in {1..100}; do
    kill -0 "\$pid" 2>/dev/null || break
    sleep 0.05
  done
  : >"$T/service.pid"
}
case \$verb in
  stop) stop ;;
  restart)
    stop
    release=\$(basename "\$(readlink "$BASE/current")")
    # A release named in this file does not come up, whatever the reason.
    if [[ -e $T/broken-release && \$(<"$T/broken-release") == "\$release" ]]; then exit 0; fi
    (cd "$BASE/current/hearth/packages/server" && set -a && . "$BASE/current/release.env" &&
      FAKE_LIVE=1 HOST=127.0.0.1 PORT=$LIVE_PORT HEARTH_DB="$DATABASE" exec node dist/main.js) \\
      >>"$T/service.log" 2>&1 9>&- &
    echo \$! >"$T/service.pid"
    ;;
  *) exit 2 ;;
esac
EOF
chmod +x "$T/bin/git" "$T/bin/pnpm" "$T/bin/systemctl"
export PATH="$T/bin:$PATH"

# make_commit ID MIGRATIONS_JSON [BEHAVIOUR]: a "commit" of the framework.
make_commit() {
  local dir=$FRAMEWORK/commits/$1
  mkdir -p "$dir/packages/server/dist" "$dir/packages/web/dist" "$dir/deploy"
  printf '%s\n' "$2" >"$dir/packages/server/migrations.json"
  printf '%s\n' "${3:-}" >"$dir/packages/server/behaviour"
  echo "<!doctype html><title>Hearth</title>" >"$dir/packages/web/dist/index.html"
  cp "$script" "$dir/deploy/hearth-deploy.sh"
  cat >"$dir/packages/server/dist/main.js" <<'EOF'
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const Database = require("better-sqlite3");

const root = path.join(__dirname, "..");
const migrations = JSON.parse(fs.readFileSync(path.join(root, "migrations.json"), "utf8"));
const behaviour = fs.readFileSync(path.join(root, "behaviour"), "utf8").trim();

const db = new Database(process.env.HEARTH_DB);
db.pragma("journal_mode = WAL");
db.exec("CREATE TABLE IF NOT EXISTS migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
const applied = db.prepare("SELECT id, name FROM migrations ORDER BY id").all();
for (const row of applied) {
  if (!migrations.some((migration) => migration.id === row.id)) {
    throw new Error(
      `The database has migration ${row.id} (${row.name}), which this build does not know.`,
    );
  }
}
for (const migration of migrations) {
  if (applied.some((row) => row.id === migration.id)) continue;
  db.transaction(() => {
    db.exec(migration.sql);
    db.prepare("INSERT INTO migrations (id, name) VALUES (?, ?)").run(migration.id, migration.name);
  })();
  console.log(`Applied database migration ${migration.id} (${migration.name}).`);
}
if (behaviour === "fails-live" && process.env.FAKE_LIVE) {
  console.error("start-up failure after migrating");
  process.exit(1);
}

const server = http.createServer((request, response) => {
  if (request.url === "/api/health") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, version: process.env.HEARTH_VERSION }));
  } else {
    response.end("page");
  }
});
server.listen(Number(process.env.PORT), "127.0.0.1");
process.on("SIGTERM", () => {
  db.close();
  process.exit(0);
});
EOF
  printf '%s\n' "$1" >"$FRAMEWORK/main"
}

write_config() {
  cat >"$T/deploy.conf" <<EOF
HEARTH_BASE=$BASE
FRAMEWORK_REPO=$FRAMEWORK
APPS_REPO=
SERVICE=hearth.service
LIVE_URL=http://127.0.0.1:$LIVE_PORT
DATABASE=$DATABASE
HEALTH_PORT=$HEALTH_PORT
HEALTH_TIMEOUT=$1
RETRY_AFTER_MINUTES=15
EOF
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
status=0
deploy() {
  # Release folders are named after the second they were made in.
  sleep 1
  status=0
  HEARTH_DEPLOY_VERBOSE=1 bash "$script" "$T/deploy.conf" >"$T/out.log" 2>&1 || status=$?
}

fail() {
  echo "FAILED: $current_test: $*" >&2
  exit 1
}

current_test=""
passed=0
start_test() { current_test=$1; }
end_test() {
  passed=$((passed + 1))
  echo "ok  $current_test"
}

expect_status() { [[ $status -eq $1 ]] || fail "the deploy script exited with $status, not $1"; }
expect_output() { grep -qF -- "$1" "$T/out.log" || fail "the output does not say: $1"; }
expect_no_output() { ! grep -qF -- "$1" "$T/out.log" || fail "the output says: $1"; }

# The version the live service reports, or "down".
live_version() {
  node -e '
    fetch(process.argv[1] + "/api/health", { signal: AbortSignal.timeout(2000) })
      .then((response) => response.json())
      .then((body) => console.log(body.version))
      .catch(() => console.log("down"));
  ' "http://127.0.0.1:$LIVE_PORT"
}
expect_live() {
  local version
  version=$(live_version)
  [[ $version == "$1" ]] || fail "the live service reports \"$version\", not \"$1\""
}

# sql FILE STATEMENT: the first column of every row, joined with commas.
sql() {
  (cd "$repo_root/packages/server" && node -e '
    const db = require("better-sqlite3")(process.argv[1]);
    const statement = db.prepare(process.argv[2]);
    if (statement.reader) {
      console.log(statement.raw().all().map((row) => row[0]).join(","));
    } else {
      statement.run();
    }
    db.close();
  ' "$1" "$2")
}

count_of() { grep -c -x -- "$1" "$2" || true; }
release_count() { find "$BASE/releases" -mindepth 1 -maxdepth 1 -type d | wc -l; }
current_release() { basename "$(readlink "$BASE/current")"; }

A=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
B=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
C=cccccccccccccccccccccccccccccccccccccccc
D=dddddddddddddddddddddddddddddddddddddddd

USERS='{"id":1,"name":"users","sql":"CREATE TABLE users (name TEXT NOT NULL)"}'
LISTS='{"id":2,"name":"lists","sql":"CREATE TABLE lists (title TEXT NOT NULL)"}'
UNIQUE_NAMES='{"id":3,"name":"unique-names","sql":"CREATE UNIQUE INDEX users_name ON users (name)"}'

write_config 5

# ---------------------------------------------------------------------------
start_test "the first release goes live"
make_commit $A "[$USERS]"
deploy
expect_status 0
expect_output "There is no database at $DATABASE yet"
expect_live aaaaaaa
release_a=$(current_release)
[[ ! -e $BASE/state/restart-pending ]] || fail "the restart note was left behind"
# Real rows, which a later migration will trip over.
sql "$DATABASE" "INSERT INTO users (name) VALUES ('Sam')"
sql "$DATABASE" "INSERT INTO users (name) VALUES ('Sam')"
end_test

# ---------------------------------------------------------------------------
start_test "a migration that fails on the real rows is caught before the switch"
make_commit $B "[$USERS,$LISTS,$UNIQUE_NAMES]"
restarts=$(count_of restart "$T/systemctl.log")
stops=$(count_of stop "$T/systemctl.log")
deploy
expect_status 1
expect_output "failed its check on port $HEALTH_PORT, running against a copy of the database"
expect_output "Release $release_a is still the one in use."
expect_live aaaaaaa
[[ $(current_release) == "$release_a" ]] || fail "\"current\" moved"
[[ $(count_of restart "$T/systemctl.log") == "$restarts" ]] || fail "the live service was restarted"
[[ $(count_of stop "$T/systemctl.log") == "$stops" ]] || fail "the live service was stopped"
[[ $(sql "$DATABASE" "SELECT id FROM migrations ORDER BY id") == 1 ]] || fail "the real database was migrated"
[[ -z $(find "$T/data" -name 'hearth-deploy-trial-*') ]] || fail "the trial copy of the database was left behind"
[[ $(<"$BASE/state/failed") == "build $B none" ]] || fail "the failure note is: $(<"$BASE/state/failed")"
end_test

start_test "a failure before the switch is tried again only after the waiting time"
releases=$(release_count)
deploy
expect_status 1
expect_output "Trying again 15 minutes after that attempt"
[[ $(release_count) == "$releases" ]] || fail "a release was built"
end_test

# ---------------------------------------------------------------------------
start_test "a release that fails as the live service is undone, database included"
make_commit $C "[$USERS,$LISTS]" fails-live
deploy
expect_status 1
expect_output "The new build answers correctly."
expect_output "Going back to release $release_a."
expect_output "Release $release_a is running again. The database is as it was just before the switch"
expect_live aaaaaaa
[[ $(current_release) == "$release_a" ]] || fail "\"current\" does not point at the previous release"
[[ $(sql "$DATABASE" "SELECT id FROM migrations ORDER BY id") == 1 ]] || fail "the failed release's migration is still in the database"
[[ $(sql "$DATABASE" "SELECT count(*) FROM users") == 2 ]] || fail "rows were lost"
failed_copy=$(find "$T/data" -name 'hearth-deploy-failed-*.db')
[[ -n $failed_copy ]] || fail "the failed release's database was not kept"
[[ $(sql "$failed_copy" "SELECT id FROM migrations ORDER BY id") == 1,2 ]] || fail "the kept copy is not the failed release's database"
before_copy=$(find "$T/data" -name 'hearth-deploy-before-*.db')
[[ $(stat -c %a "$before_copy") == 600 ]] || fail "the copy of the database is readable by others"
[[ $(<"$BASE/state/failed") == "live $C none" ]] || fail "the failure note is: $(<"$BASE/state/failed")"
[[ ! -e $BASE/state/restart-pending ]] || fail "the restart note was left behind"
end_test

start_test "a release that failed as the live service is not tried again by itself"
touch -d "20 minutes ago" "$BASE/state/failed"
restarts=$(count_of restart "$T/systemctl.log")
stops=$(count_of stop "$T/systemctl.log")
releases=$(release_count)
deploy
expect_status 1
expect_output "are not tried again by themselves"
expect_live aaaaaaa
[[ $(count_of restart "$T/systemctl.log") == "$restarts" ]] || fail "the live service was restarted"
[[ $(count_of stop "$T/systemctl.log") == "$stops" ]] || fail "the live service was stopped"
[[ $(release_count) == "$releases" ]] || fail "a release was built"
end_test

# ---------------------------------------------------------------------------
# From here on the service is down on purpose, so a short wait is enough.
write_config 2

start_test "a restart that cannot be confirmed does not stop the script from fetching"
systemctl --no-ask-password stop hearth.service
printf '%s\n' "$release_a" >"$T/broken-release"
: >"$BASE/state/restart-pending"
fetches=$(count_of fetch "$T/git.log")
deploy
expect_status 1
expect_output "did not come up on release $release_a"
[[ $(count_of fetch "$T/git.log") -gt $fetches ]] || fail "the script stopped before fetching"
expect_live down
end_test

write_config 5

start_test "a newer commit is deployed although the current release does not come up"
make_commit $D "[$USERS,$LISTS]"
deploy
expect_status 0
expect_output "Trying the newer commits instead."
expect_live ddddddd
release_d=$(current_release)
[[ $release_d != "$release_a" ]] || fail "\"current\" did not move"
[[ ! -e $BASE/state/restart-pending ]] || fail "the restart note was left behind"
[[ ! -e $BASE/state/failed ]] || fail "the failure note was left behind"
[[ $(sql "$DATABASE" "SELECT id FROM migrations ORDER BY id") == 1,2 ]] || fail "the database was not migrated"
[[ $(sql "$DATABASE" "SELECT count(*) FROM users") == 2 ]] || fail "rows were lost"
[[ $(find "$T/data" -name 'hearth-deploy-before-*.db' | wc -l) == 1 ]] || fail "old copies of the database were not removed"
end_test

start_test "a service that already runs the release is not restarted again"
: >"$BASE/state/restart-pending"
restarts=$(count_of restart "$T/systemctl.log")
deploy
expect_status 0
expect_output "an earlier run could not confirm that"
[[ $(count_of restart "$T/systemctl.log") == "$restarts" ]] || fail "the live service was restarted"
[[ ! -e $BASE/state/restart-pending ]] || fail "the restart note was left behind"
expect_live ddddddd
end_test

write_config 2

start_test "a service that does not come up is restarted three times, not for ever"
systemctl --no-ask-password stop hearth.service
printf '%s\n' "$release_d" >"$T/broken-release"
: >"$BASE/state/restart-pending"
restarts=$(count_of restart "$T/systemctl.log")
for _ in 1 2 3 4 5; do
  deploy
  expect_status 1
  expect_output "did not come up on release $release_d"
done
expect_output "is not restarted again"
[[ $(($(count_of restart "$T/systemctl.log") - restarts)) == 3 ]] || fail "the service was restarted $(($(count_of restart "$T/systemctl.log") - restarts)) times"
end_test

echo "deploy tests: $passed passed."
