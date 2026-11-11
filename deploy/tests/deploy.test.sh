#!/usr/bin/env bash
#
# Tests for deploy/hearth-deploy.sh: what it does when a release fails.
#
# Run it with `pnpm test:deploy` at the repository root (after `pnpm install`).
#
# The real script runs unchanged. Around it stand small substitutes:
#
#   git        a folder of "commits" instead of a repository, one for the
#              framework and one for the mini-apps
#   pnpm       in the framework, "install" links the SQLite library and the
#              TypeScript parser the SDK's tools need, and "build" runs the
#              real `hearth-apps sync` that each made-up commit carries, as
#              the real build does first; the rest is already built in each
#              made-up commit. In the mini-apps, "install" does what pnpm
#              does with a lockfile that holds only a "link:" to the SDK.
#   systemctl  starts and stops the made-up server as "the service"
#   server     applies numbered migrations to a real SQLite file exactly as
#              the real server does (each in its own transaction, refusing a
#              database with a migration it does not know), then answers
#              /api/health
#
# So the handshake between the mini-apps and the SDK is the real one: the
# version a made-up mini-apps commit declares against the SDK version in a
# made-up framework commit, and the link from one to the other in a release.
#
# Nothing outside a temporary folder is touched, and no network is used.

set -Eeuo pipefail
export LC_ALL=C

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "$here/../.." && pwd)
script=$repo_root/deploy/hearth-deploy.sh
sqlite_package=$repo_root/packages/server/node_modules/better-sqlite3
sdk=$repo_root/packages/sdk

for tool in node tar flock timeout; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "deploy tests: the command '$tool' is missing." >&2
    exit 1
  }
done
for package in "$sqlite_package" "$sdk/node_modules/typescript"; do
  [[ -d $package ]] || {
    echo "deploy tests: $package is missing. Run pnpm install first." >&2
    exit 1
  }
done

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
STONES=$T/stones
DATABASE=$T/data/hearth.db
mkdir -p "$BASE" "$FRAMEWORK/commits" "$STONES/commits" "$T/bin" "$T/data"
: >"$T/systemctl.log"
: >"$T/git.log"
: >"$T/pnpm.log"
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
# Called in a release's hearth or hearth-stones folder ("store prune"
# elsewhere). Every call goes into pnpm.log with the folder it was made in.
folder=\${PWD##*/}
printf '%s: %s%s\n' "\$folder" "\$*" "\${HEARTH_APPS_DIR+ HEARTH_APPS_DIR=\$HEARTH_APPS_DIR}" >>"$T/pnpm.log"
case \$folder:\$1 in
  hearth:install)
    mkdir -p packages/server/node_modules
    ln -s "$sqlite_package" packages/server/node_modules/better-sqlite3
    ln -s "$sdk/node_modules" packages/sdk/node_modules
    ;;
  hearth:build)
    # What the real "pnpm build" does first: pnpm apps:sync.
    exec node packages/sdk/bin/hearth-apps.mjs sync
    ;;
  hearth-stones:install)
    if [[ " \$* " == *" --frozen-lockfile "* && ! -f pnpm-lock.yaml ]]; then
      echo 'ERR_PNPM_NO_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is absent' >&2
      exit 1
    fi
    # Each "link:" in package.json becomes a relative link in node_modules,
    # as pnpm makes it. Anything else would have to come from the store,
    # which is empty here.
    exec node -e '
      const fs = require("node:fs");
      const path = require("node:path");
      const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
      for (const [name, spec] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
        if (!spec.startsWith("link:")) {
          console.error("ERR_PNPM_NO_OFFLINE_TARBALL  " + name + " is not in the store.");
          process.exit(1);
        }
        const at = path.join("node_modules", name);
        fs.mkdirSync(path.dirname(at), { recursive: true });
        fs.symlinkSync(path.relative(path.dirname(at), spec.slice("link:".length)), at);
      }
    '
    ;;
esac
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

# make_commit ID MIGRATIONS_JSON [BEHAVIOUR [SDK_VERSION]]: a "commit" of the
# framework. It carries the real hearth-apps command, as packages/sdk does,
# with SDK_VERSION (0.1.0 unless given) as the version of its SDK.
make_commit() {
  local dir=$FRAMEWORK/commits/$1
  mkdir -p "$dir/packages/server/dist" "$dir/packages/web/dist" "$dir/deploy" \
    "$dir/packages/sdk/bin" "$dir/packages/sdk/tools"
  printf '%s\n' "$2" >"$dir/packages/server/migrations.json"
  printf '%s\n' "${3:-}" >"$dir/packages/server/behaviour"
  echo "<!doctype html><title>Hearth</title>" >"$dir/packages/web/dist/index.html"
  cp "$script" "$dir/deploy/hearth-deploy.sh"
  cp "$sdk/bin/hearth-apps.mjs" "$dir/packages/sdk/bin/"
  cp "$sdk"/tools/*.mjs "$dir/packages/sdk/tools/"
  printf '{ "name": "@hearth/sdk", "version": "%s", "private": true, "type": "module" }\n' \
    "${4:-0.1.0}" >"$dir/packages/sdk/package.json"
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

# make_apps_commit ID [SDK_RANGE [LOCKFILE [APP...]]]: a "commit" of the
# mini-apps. Without SDK_RANGE it holds no apps and no package.json, as
# hearth-stones did before its first app. With it, it has the package.json a
# mini-apps repository has, declaring that range ("hearth.sdk") and linking
# the SDK beside it, and the lockfile pnpm writes for that unless LOCKFILE is
# "no-lockfile"; and one folder per APP, holding what sync asks of an app.
make_apps_commit() {
  local dir=$STONES/commits/$1 app
  mkdir -p "$dir"
  printf '# Mini-apps\n\nSample apps for the deploy tests.\n' >"$dir/README.md"
  if [[ -n ${2:-} ]]; then
    cat >"$dir/package.json" <<EOF
{
  "name": "sample-stones",
  "private": true,
  "type": "module",
  "hearth": { "sdk": "$2" },
  "devDependencies": { "@hearth/sdk": "link:../hearth/packages/sdk" }
}
EOF
  fi
  if [[ -n ${2:-} && ${3:-} != no-lockfile ]]; then
    # As pnpm 10 writes it for that package.json.
    cat >"$dir/pnpm-lock.yaml" <<'EOF'
lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    devDependencies:
      '@hearth/sdk':
        specifier: link:../hearth/packages/sdk
        version: link:../hearth/packages/sdk
EOF
  fi
  for app in "${@:4}"; do
    mkdir -p "$dir/$app"
    cat >"$dir/$app/manifest.ts" <<EOF
import { defineApp } from "@hearth/sdk";

export default defineApp({
  id: "$app",
  name: { en: "Notes", zh: "笔记" },
  description: { en: "Short notes.", zh: "简短的笔记。" },
  icon: "notebook-text",
  color: "amber",
  widget: { size: "small" },
});
EOF
    printf 'export default function Widget() {\n  return null;\n}\n' >"$dir/$app/widget.tsx"
  done
  printf '%s\n' "$1" >"$STONES/main"
}

# The mini-apps repository the deploy fetches; none until the tests of it.
APPS=""

write_config() {
  cat >"$T/deploy.conf" <<EOF
HEARTH_BASE=$BASE
FRAMEWORK_REPO=$FRAMEWORK
APPS_REPO=$APPS
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
pnpm_mark=0
deploy() {
  # Release folders are named after the second they were made in.
  sleep 1
  status=0
  pnpm_mark=$(wc -l <"$T/pnpm.log")
  HEARTH_DEPLOY_VERBOSE=1 bash "$script" "$T/deploy.conf" >"$T/out.log" 2>&1 || status=$?
}

# What the last deploy asked of pnpm, one call per line: "<folder>: <arguments>",
# and HEARTH_APPS_DIR=... when that was set.
pnpm_calls() { tail -n "+$((pnpm_mark + 1))" -- "$T/pnpm.log"; }
expect_pnpm_call() { grep -qxF -- "$1" <(pnpm_calls) || fail "pnpm was not called as: $1"; }
expect_no_pnpm_call() { ! grep -qE -- "$1" <(pnpm_calls) || fail "pnpm was called: $(grep -E -- "$1" <(pnpm_calls))"; }

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
E=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
F=ffffffffffffffffffffffffffffffffffffffff
# Commits of the mini-apps.
NO_APPS=1111111111111111111111111111111111111111
NO_LOCKFILE=2222222222222222222222222222222222222222
FOR_SDK_1=3333333333333333333333333333333333333333
FOR_SDK_2=4444444444444444444444444444444444444444

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

# ---------------------------------------------------------------------------
# From here on the deploy fetches the mini-apps too, and builds them in.
APPS=$STONES

start_test "a base folder with a colon in its name is refused while there are mini-apps"
# HEARTH_APPS_DIR separates folders with colons: the build would hold none.
printf 'HEARTH_BASE=%s\nFRAMEWORK_REPO=%s\nAPPS_REPO=%s\n' "$T/odd:base" "$FRAMEWORK" "$STONES" >"$T/colon.conf"
status=0
bash "$script" "$T/colon.conf" >"$T/out.log" 2>&1 || status=$?
expect_status 1
expect_output "HEARTH_BASE must not contain a colon while APPS_REPO is set"
[[ ! -e $T/odd:base ]] || fail "the base folder was made"
end_test

write_config 5

start_test "mini-apps that hold no apps yet are copied in, with nothing to install"
make_apps_commit $NO_APPS
deploy
expect_status 0
expect_output "The build holds no mini-apps."
expect_live ddddddd
release_no_apps=$(current_release)
[[ $release_no_apps != "$release_d" ]] || fail "\"current\" did not move"
[[ $(sed -n 's/^apps=//p' "$BASE/current/RELEASE") == "$NO_APPS" ]] || fail "RELEASE does not name the mini-apps' commit"
[[ -f $BASE/current/hearth-stones/README.md ]] || fail "the mini-apps were not copied into the release"
expect_no_pnpm_call "^hearth-stones:"
expect_pnpm_call "hearth: build HEARTH_APPS_DIR=$BASE/releases/$release_no_apps/hearth-stones"
end_test

start_test "mini-apps that cannot be linked to the SDK stop the deploy before the build"
make_apps_commit $NO_LOCKFILE "^0.1.0" no-lockfile notes
deploy
expect_status 1
expect_output "Could not link the mini-apps to the SDK"
expect_output "ERR_PNPM_NO_LOCKFILE"
expect_output "Release $release_no_apps is still the one in use."
expect_live ddddddd
[[ $(current_release) == "$release_no_apps" ]] || fail "\"current\" moved"
expect_no_pnpm_call "^hearth: build"
[[ $(<"$BASE/state/failed") == "build $D $NO_LOCKFILE" ]] || fail "the failure note is: $(<"$BASE/state/failed")"
end_test

start_test "the mini-apps are linked offline to the SDK beside them and built in"
make_commit $E "[$USERS,$LISTS]"
make_apps_commit $FOR_SDK_1 "^0.1.0" "" notes
deploy
expect_status 0
expect_output "The build holds 1 mini-app (notes)."
expect_live eeeeeee
release_e=$(current_release)
expect_pnpm_call "hearth-stones: install --frozen-lockfile --offline --store-dir $BASE/pnpm-store"
expect_pnpm_call "hearth: build HEARTH_APPS_DIR=$BASE/releases/$release_e/hearth-stones"
[[ $(readlink -f "$BASE/current/hearth-stones/node_modules/@hearth/sdk") == "$(readlink -f "$BASE/current/hearth/packages/sdk")" ]] ||
  fail "the mini-apps are not linked to the SDK of their own release"
grep -qF 'id: "notes"' "$BASE/current/hearth/packages/server/src/apps/registry.generated.js" ||
  fail "the server's list of apps does not hold the app"
[[ ! -e $BASE/state/failed ]] || fail "the failure note was left behind"
end_test

start_test "a new SDK version that the mini-apps were not written for leaves the running release alone"
make_commit $F "[$USERS,$LISTS]" "" 0.2.0
restarts=$(count_of restart "$T/systemctl.log")
stops=$(count_of stop "$T/systemctl.log")
releases=$(release_count)
deploy
expect_status 1
expect_output "The mini-apps (commit ${FOR_SDK_1:0:12}) were written for another version of the SDK than the framework (commit ${F:0:12}) holds"
# The lines of hearth-apps sync that name both versions.
expect_output "were written for @hearth/sdk ^0.1.0"
expect_output "holds @hearth/sdk 0.2.0"
expect_output "Release $release_e is still the one in use."
expect_live eeeeeee
[[ $(current_release) == "$release_e" ]] || fail "\"current\" moved"
[[ $(count_of restart "$T/systemctl.log") == "$restarts" ]] || fail "the live service was restarted"
[[ $(count_of stop "$T/systemctl.log") == "$stops" ]] || fail "the live service was stopped"
[[ $(release_count) == "$releases" ]] || fail "the release that failed was left behind"
[[ $(<"$BASE/state/failed") == "sdk $F $FOR_SDK_1" ]] || fail "the failure note is: $(<"$BASE/state/failed")"
end_test

start_test "those commits are not built again, even after the waiting time"
touch -d "20 minutes ago" "$BASE/state/failed"
releases=$(release_count)
deploy
expect_status 1
expect_output "which building them again cannot change"
[[ -z $(pnpm_calls) ]] || fail "pnpm was run: $(pnpm_calls)"
[[ $(release_count) == "$releases" ]] || fail "a release was built"
expect_live eeeeeee
end_test

start_test "the matching commit of the mini-apps is built at once"
make_apps_commit $FOR_SDK_2 "^0.2.0" "" notes
deploy
expect_status 0
expect_output "The build holds 1 mini-app (notes)."
expect_live fffffff
release_f=$(current_release)
[[ ! -e $BASE/state/failed ]] || fail "the failure note was left behind"
end_test

write_config 2

start_test "a service that does not come up is restarted three times, not for ever"
systemctl --no-ask-password stop hearth.service
printf '%s\n' "$release_f" >"$T/broken-release"
: >"$BASE/state/restart-pending"
restarts=$(count_of restart "$T/systemctl.log")
for _ in 1 2 3 4 5; do
  deploy
  expect_status 1
  expect_output "did not come up on release $release_f"
done
expect_output "is not restarted again"
[[ $(($(count_of restart "$T/systemctl.log") - restarts)) == 3 ]] || fail "the service was restarted $(($(count_of restart "$T/systemctl.log") - restarts)) times"
end_test

echo "deploy tests: $passed passed."
