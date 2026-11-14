#!/usr/bin/env bash
#
# Tests for deploy/hearth-deploy.sh: what it does when a release fails, and
# which copy of it does the work.
#
# Run it with `pnpm test:deploy` at the repository root (after `pnpm install`).
#
# The real script runs unchanged, as the installed copy. Around it stand small
# substitutes:
#
#   git        a folder of "commits" instead of a repository, one for the
#              framework and one for the mini-apps: "main" in it is the
#              branch on the remote, and "fetched" what the last fetch
#              brought. Of a folder without commits it says what git says
#              of one that is no repository. A fetch can be made to fail,
#              in words of the test's if it likes, to leave a process behind
#              that is still running when it is over, or to run something of
#              the test's in its middle; "show" can be cut short, or made to
#              give another text each time. It writes down every call that
#              finds, in its environment, what a starter tells the copy it
#              starts. The last test uses the real git instead, on a
#              repository it makes up.
#   pnpm       it writes down which copy of the deploy script asked, and
#              whether that copy holds the lock;
#              in the framework, "install" links the SQLite library and the
#              TypeScript parser the SDK's tools need, and "build" runs the
#              real `hearth-apps sync` that each made-up commit carries, as
#              the real build does first; the rest is already built in each
#              made-up commit. In the mini-apps, "install" does what pnpm
#              does with a lockfile that holds only a "link:" to the SDK.
#   systemctl  starts and stops the made-up server as "the service"
#   server     applies numbered migrations to a real SQLite file exactly as
#              the real server does (each in its own transaction, refusing a
#              database with a migration it does not know), then answers
#              /api/health; each start writes down, beside it, whether it
#              is the trial start or the service and what HEARTH_JOBS it got
#
# So the handshake between the mini-apps and the SDK is the real one: the
# version a made-up mini-apps commit declares against the SDK version in a
# made-up framework commit, and the link from one to the other in a release.
#
# Every made-up framework commit carries the deploy script under test, so no
# run is handed over unless a test gives a commit another one. That other
# one is the script under test again with a line added (newer_script), which
# writes down how it was started: it stands for the newer deploy script of a
# later commit, and the script under test for the copy installed before it.
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
# root, run the whole test as an unprivileged user instead. Where that
# cannot be done every test is skipped, which fails the run where CI is set,
# as one skipped test does (see skip_test).
if [[ $EUID -eq 0 ]]; then
  if ! command -v setpriv >/dev/null 2>&1; then
    echo "deploy tests: SKIPPED. They cannot run as root, and setpriv is not here to drop root."
    [[ -n ${CI:-} ]] || exit 0
    [[ -z ${GITHUB_ACTIONS:-} ]] ||
      echo "::error title=The deploy tests were skipped::They cannot run as root, and setpriv is not here to drop root."
    echo "deploy tests: FAILED, because CI is set, where every test must run. Run them as another user than root, or install setpriv (util-linux)." >&2
    exit 1
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
: >"$T/pnpm-by.log"
: >"$T/started.log"
: >"$T/git-told.log"
: >"$T/service.pid"
# The PATH before the substitutes: where the real git is.
system_path=$PATH
# A process a test started to hold the lock, while it runs.
lock_holder=""

# Stops what the tests started and removes their folder.
cleanup_folder() {
  if [[ -s $T/service.pid ]]; then kill "$(<"$T/service.pid")" 2>/dev/null || true; fi
  if [[ -n $lock_holder ]]; then kill "$lock_holder" 2>/dev/null || true; fi
  [[ -n ${HEARTH_DEPLOY_TEST_DIR:-} ]] || rm -rf -- "$T"
}
cleanup() {
  local status=$?
  trap - EXIT
  if [[ $status -ne 0 ]]; then
    echo "--- output of the last deploy run ---" >&2
    cat "$T/out.log" >&2 2>/dev/null || true
    echo "--- service log ---" >&2
    cat "$T/service.log" >&2 2>/dev/null || true
  fi
  cleanup_folder
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
# REPO/main names the commit the branch is at on the remote, and REPO/fetched
# the one the last fetch brought, as refs/remotes/origin/main does in a clone.
[[ \$1 == -C ]] || exit 2
repo=\$2
shift 2
# What a starter tells the copy it starts is for that copy alone: a call that
# finds it in its environment is written down.
if [[ -n \${HEARTH_DEPLOY_HANDED_OVER+set}\${HEARTH_DEPLOY_FETCHED+set} ]]; then
  printf '%s %s\n' "\$1" "\$repo" >>"$T/git-told.log"
fi
case \$1 in
  rev-parse)
    case \$2 in
      --git-dir)
        if [[ ! -d \$repo/commits ]]; then
          echo "fatal: not a git repository (or any of the parent directories): .git" >&2
          exit 128
        fi
        echo .git
        ;;
      --verify) [[ -s \$repo/fetched ]] && cat "\$repo/fetched" ;;
      --short) printf '%s\n' "\${3:0:7}" ;;
      *) exit 2 ;;
    esac
    ;;
  fetch)
    printf 'fetch %s\n' "\$repo" >>"$T/git.log"
    # It fails while this file is there, in the file's words if it has any.
    if [[ -s $T/fetch-fails ]]; then
      cat "$T/fetch-fails" >&2
      exit 128
    elif [[ -e $T/fetch-fails ]]; then
      echo "fatal: unable to access 'https://example.com/hearth.git/': Could not resolve host: example.com" >&2
      exit 128
    fi
    # Something of a test's, in the middle of a fetch: what another run does
    # meanwhile.
    if [[ -x $T/during-fetch ]]; then "$T/during-fetch"; fi
    cp "\$repo/main" "\$repo/fetched"
    # A process that stays behind when the fetch is over, with every file
    # this one had open, for as many seconds as the file says: what a tool
    # that goes on tidying up in the background amounts to. Once.
    if [[ -e $T/fetch-leaves-a-process ]]; then
      seconds=\$(<"$T/fetch-leaves-a-process")
      rm "$T/fetch-leaves-a-process"
      sleep "\$seconds" </dev/null >/dev/null 2>&1 &
    fi
    ;;
  ls-tree)
    # ls-tree COMMIT -- PATH: the line git prints for a file, a link or a
    # folder, and nothing when the commit has no such path.
    [[ -d \$repo/commits/\$2 ]] || exit 128
    file=\$repo/commits/\$2/\$4
    if [[ -L \$file ]]; then
      kind="120000 blob"
    elif [[ -d \$file ]]; then
      kind="040000 tree"
    elif [[ -x \$file ]]; then
      kind="100755 blob"
    elif [[ -f \$file ]]; then
      kind="100644 blob"
    else
      exit 0
    fi
    printf '%s %s\t%s\n' "\$kind" 0000000000000000000000000000000000000000 "\$4"
    ;;
  show)
    # show COMMIT:PATH
    file=\$repo/commits/\${2%%:*}/\${2#*:}
    if [[ ! -f \$file ]]; then
      echo "fatal: path '\${2#*:}' does not exist in '\${2%%:*}'" >&2
      exit 128
    fi
    # Cut short after as many lines as the file says, as when the disk is
    # full or git is killed.
    if [[ -e $T/show-cut-short ]]; then
      head -n "\$(<"$T/show-cut-short")" "\$file"
      exit 141
    fi
    cat "\$file"
    # A line more each time, which no real git adds: for a test in which no
    # two readings of a script may be the same.
    if [[ -e $T/show-never-the-same ]]; then
      reading=\$((\$(<"$T/show-never-the-same") + 1))
      echo "\$reading" >"$T/show-never-the-same"
      echo "# Reading \$reading."
    fi
    ;;
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
# Which copy of the deploy script asked, and whether the lock is held while
# it does: the process that started this one runs "bash SCRIPT CONFIG".
base=\${PWD%/releases/*}
[[ \$base != "\$PWD" ]] || base=$BASE
mapfile -d '' -t asker </proc/\$PPID/cmdline
printf '%s lock=%s\n' "\${asker[1]:-unknown}" \\
  "\$(flock -n "\$base/deploy.lock" true && echo free || echo held)" >>"$T/pnpm-by.log"
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

# commit_files FOLDER MIGRATIONS_JSON [BEHAVIOUR [SDK_VERSION]]: the files of
# a framework commit. Among them are the real hearth-apps command, as
# packages/sdk has it, with SDK_VERSION (0.1.0 unless given) as the version
# of its SDK, and the deploy script under test.
commit_files() {
  local dir=$1
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
// Whether the mini-apps' jobs would run: "trial off" for the deploy's trial start, "live unset" for the service.
fs.appendFileSync(
  path.join(root, "started-with"),
  `${process.env.FAKE_LIVE ? "live" : "trial"} ${process.env.HEARTH_JOBS ?? "unset"}\n`,
);

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
}

# make_commit ID MIGRATIONS_JSON [BEHAVIOUR [SDK_VERSION]]: a "commit" of the
# framework, which its branch on the remote is at from then on.
make_commit() {
  commit_files "$FRAMEWORK/commits/$1" "${@:2}"
  printf '%s\n' "$1" >"$FRAMEWORK/main"
}

# newer_script FILE TAG [SED_EXPRESSION [BASE]]: writes into FILE a deploy
# script that differs from the one under test, as a later commit's does. It
# is the script under test with one line added after the first, which writes
# a line into started.log each time the script starts: TAG, the arguments it
# got, what the copy that started it left in its environment, and whether
# the lock (of BASE, or of the tests' base folder) was free at that moment.
# SED_EXPRESSION changes it some more, and must change something.
newer_script() {
  local file=$1 tag=$2 changed
  {
    head -n 1 "$script"
    cat <<EOF
printf '%s args=[%s] handed_over=%s fetched=%s lock=%s\n' '$tag' "\$*" "\${HEARTH_DEPLOY_HANDED_OVER-unset}" "\${HEARTH_DEPLOY_FETCHED-unset}" "\$(flock -n '${4:-$BASE}/deploy.lock' true && echo free || echo held)" >>'$T/started.log'
EOF
    tail -n +2 "$script"
  } >"$file.plain"
  if [[ -n ${3:-} ]]; then
    sed -e "$3" "$file.plain" >"$file.changed"
    if cmp -s "$file.plain" "$file.changed"; then
      echo "deploy tests: the change \"$3\" no longer fits the deploy script." >&2
      exit 1
    fi
    mv "$file.changed" "$file.plain"
  fi
  bash -n "$file.plain" || {
    echo "deploy tests: the newer script $tag does not parse." >&2
    exit 1
  }
  # In place of whatever was there: FILE may be a link.
  rm -f "$file"
  mv "$file.plain" "$file"
  chmod 755 "$file"
}

# The deploy script of a made-up framework commit.
script_of() { printf '%s\n' "$FRAMEWORK/commits/$1/deploy/hearth-deploy.sh"; }

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

# write_config HEALTH_TIMEOUT [LINE...]: the config file, with more lines at
# its end if given.
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
  if (($# > 1)); then printf '%s\n' "${@:2}" >>"$T/deploy.conf"; fi
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
status=0
pnpm_mark=0
git_mark=0
started_mark=0
asker_mark=0
# What a run starts: the installed copy, which is the script under test
# unless a test puts another in its place, with the config file as its
# argument unless a test empties that, after what a test puts in front of it.
installed=$script
config=$T/deploy.conf
run_in=()

# run [NAME=VALUE...]: one run, as the timer starts it, with those settings
# added to its environment.
run() {
  status=0
  pnpm_mark=$(wc -l <"$T/pnpm.log")
  git_mark=$(wc -l <"$T/git.log")
  started_mark=$(wc -l <"$T/started.log")
  asker_mark=$(wc -l <"$T/pnpm-by.log")
  "${run_in[@]}" env HEARTH_DEPLOY_VERBOSE=1 "$@" bash "$installed" ${config:+"$config"} >"$T/out.log" 2>&1 || status=$?
}

# deploy [NAME=VALUE...]: a run that may build a release.
deploy() {
  # Release folders are named after the second they were made in.
  sleep 1
  run "$@"
}

# What the last run asked of pnpm, one call per line: "<folder>: <arguments>",
# and HEARTH_APPS_DIR=... when that was set.
pnpm_calls() { tail -n "+$((pnpm_mark + 1))" -- "$T/pnpm.log"; }
expect_pnpm_call() { grep -qxF -- "$1" <(pnpm_calls) || fail "pnpm was not called as: $1"; }
expect_no_pnpm_call() { ! grep -qE -- "$1" <(pnpm_calls) || fail "pnpm was called: $(grep -E -- "$1" <(pnpm_calls))"; }

# Which copies of the deploy script asked pnpm for something in the last run,
# and whether they held the lock: "<script> lock=held", each once.
pnpm_askers() { tail -n "+$((asker_mark + 1))" -- "$T/pnpm-by.log" | sort -u; }

# fetches_of REPO: how many times the last run fetched it, or tried to.
fetches_of() { tail -n "+$((git_mark + 1))" -- "$T/git.log" | grep -c -x -F -- "fetch $1" || true; }

# What the newer deploy scripts that the last run started wrote down, one
# line each; see newer_script.
started() { tail -n "+$((started_mark + 1))" -- "$T/started.log"; }
# started_as TAG COMMIT [FETCHED]: the line of a newer script that was handed
# a run for COMMIT, by a copy that had fetched (COMMIT unless given).
started_as() {
  printf '%s args=[%s] handed_over=%s fetched=%s lock=free\n' "$1" "$config" "$2" "${3:-$2}"
}
expect_started() { [[ $(started) == "$1" ]] || fail "newer deploy scripts were started as \"$(started)\", not as \"$1\""; }

# not_deployed FRAMEWORK_COMMIT APPS_COMMIT REASON: what a run says of commits
# that it does not build, because the framework commit's deploy script cannot
# carry out the run.
not_deployed() {
  printf 'ERROR: The newest commits (framework %s, mini-apps %s) are not deployed: the deploy script of that framework commit cannot carry out the run, because %s.' \
    "${1:0:12}" "${2:0:12}" "$3"
}

# The other way out that such a run names, after what to do about the
# script: SELF_UPDATE=off, and where to read first what that takes.
with_the_installed_copy() {
  printf 'or deploy them with the installed copy of the script, which may be much older than they are: read "When a deployment fails" in docs/self-hosting.md before you set SELF_UPDATE=off in %s.' "$config"
}

fail() {
  echo "FAILED: $current_test: $*" >&2
  exit 1
}

current_test=""
passed=0
skipped=0
start_test() { current_test=$1; }
end_test() {
  passed=$((passed + 1))
  echo "ok  $current_test"
}
# skip_test REASON: for a test this machine cannot run. One line among all
# the others is not seen in a CI run that passes, and a test nobody runs
# holds the script to nothing: so where CI is set, a skipped test fails the
# whole run at its end (see the last lines of this file). Under GitHub
# Actions the line is also an error on the run's page.
skip_test() {
  skipped=$((skipped + 1))
  echo "SKIPPED  $current_test: $1"
  [[ -z ${CI:-} || -z ${GITHUB_ACTIONS:-} ]] ||
    echo "::error title=A deploy test was skipped::$current_test: $1"
}

expect_status() { [[ $status -eq $1 ]] || fail "the deploy script exited with $status, not $1"; }
expect_output() { grep -qF -- "$1" "$T/out.log" || fail "the output does not say: $1"; }
expect_no_output() { ! grep -qF -- "$1" "$T/out.log" || fail "the output says: $1"; }
# expect_order FIRST SECOND: both are said, FIRST before SECOND.
expect_order() {
  local first second
  first=$(grep -nF -- "$1" "$T/out.log" | head -n 1 | cut -d: -f1) || true
  second=$(grep -nF -- "$2" "$T/out.log" | head -n 1 | cut -d: -f1) || true
  [[ -n $first ]] || fail "the output does not say: $1"
  [[ -n $second ]] || fail "the output does not say: $2"
  ((first < second)) || fail "the output says \"$2\" before \"$1\""
}

# What a run with SELF_UPDATE=off says after it deployed a release whose own
# deploy script no hand-over would start.
do_not_install() {
  printf 'NOTE: deploy/hearth-deploy.sh in this release is missing, empty, not a regular file or not parsed by bash. Do NOT install it: keep the installed copy (%s). See "When a deployment fails" in docs/self-hosting.md.' "$script"
}

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
# What state/failed holds, or "none".
failure_note() { cat "$BASE/state/failed" 2>/dev/null || echo none; }
release_count() { find "$BASE/releases" -mindepth 1 -maxdepth 1 -type d | wc -l; }
current_release() { basename "$(readlink "$BASE/current")"; }

A=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
B=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
C=cccccccccccccccccccccccccccccccccccccccc
D=dddddddddddddddddddddddddddddddddddddddd
E=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
F=ffffffffffffffffffffffffffffffffffffffff
# For the tests of which copy of the deploy script does the work.
G=a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1
H=b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2
I=c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3
J=d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4
K=e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5
L=f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6
M=a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7
N=b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8
O=c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9
P=d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0
Q=e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1
R=f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2
S=a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3
U=b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4
V=c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5
W=d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6
X=e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7
Y=f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8
Z=a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9
AB=b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0
AC=c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1
AD=d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2
AE=e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3
AF=f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4
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

start_test "the trial start runs no job, and the service runs them"
# The trial start, against a copy of the database, must fetch nothing; the
# service gets no HEARTH_JOBS from the script, so its jobs run (the default).
started=$(<"$BASE/releases/$release_a/hearth/packages/server/started-with")
[[ $started == $'trial off\nlive unset' ]] || fail "the made-up server was started as: ${started//$'\n'/, }"
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
deploy
expect_status 1
expect_output "did not come up on release $release_a"
[[ $(fetches_of "$FRAMEWORK") -gt 0 ]] || fail "the script stopped before fetching"
# The framework is fetched before the restart is tried, to find the copy of
# the script that does the work. What shows that the run went on after it is
# that it looked at what was fetched: the commit that failed as the service.
expect_output "failed to deploy earlier"
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

# ---------------------------------------------------------------------------
# From here on: which copy of the deploy script does the work. The service is
# allowed to come up again.
write_config 5
rm -f "$T/broken-release"

start_test "a copy that is the newest commit's deploy script does the work itself, with one fetch"
: >"$BASE/state/restart-pending"
run
expect_status 0
expect_output "hearth.service now runs release $release_f (version fffffff)."
expect_output "Nothing new: main is already deployed."
expect_no_output "Handing this run over"
expect_started ""
# Nor was any run before this one handed over: every commit so far carried
# the script under test.
[[ -z $(find "$BASE/state" -name 'deploy-script*') ]] || fail "a deploy script was written under state/"
[[ $(fetches_of "$FRAMEWORK") == 1 ]] || fail "the framework was fetched $(fetches_of "$FRAMEWORK") times"
[[ $(fetches_of "$STONES") == 1 ]] || fail "the mini-apps were fetched $(fetches_of "$STONES") times"
expect_live fffffff
end_test

start_test "a fetch that fails is reported once a pending restart was dealt with, and is not tried twice"
systemctl --no-ask-password stop hearth.service
: >"$BASE/state/restart-pending"
: >"$T/fetch-fails"
run
rm "$T/fetch-fails"
expect_status 1
expect_order "hearth.service now runs release $release_f (version fffffff)." \
  "ERROR: Could not fetch main of the framework repository."
expect_output "    fatal: unable to access 'https://example.com/hearth.git/': Could not resolve host: example.com"
[[ $(fetches_of "$FRAMEWORK") == 1 ]] || fail "the framework was fetched $(fetches_of "$FRAMEWORK") times"
[[ $(fetches_of "$STONES") == 0 ]] || fail "the mini-apps were fetched although the framework could not be"
[[ ! -e $BASE/state/restart-pending ]] || fail "the restart note was left behind"
expect_live fffffff
end_test

start_test "what git says of a fetch that failed is passed on without the token in the remote's address"
echo "fatal: unable to access 'https://sample-user:sample-token@example.com/hearth.git/': The requested URL returned error: 403" >"$T/fetch-fails"
run
rm "$T/fetch-fails"
expect_status 1
expect_output "    fatal: unable to access 'https://***@example.com/hearth.git/': The requested URL returned error: 403"
expect_no_output "sample-token"
expect_output "ERROR: Could not fetch main of the framework repository."
end_test

start_test "a newer deploy script in the newest commit carries out the run, and deploys the commit that brought it"
make_commit $G "[$USERS,$LISTS]" "" 0.2.0
newer_script "$(script_of $G)" g
deploy
expect_status 0
expect_live a1a1a1a
release_g=$(current_release)
# Started once, with the installed copy's argument, told its commit and that
# the framework is fetched, and with the lock free for it to take.
expect_started "$(started_as g $G)"
expect_output "Handing this run over to the deploy script of framework commit ${G:0:12} ($BASE/state/deploy-script)."
expect_output "This run is carried out by the deploy script of framework commit ${G:0:12}."
cmp -s "$BASE/state/deploy-script" "$(script_of $G)" || fail "state/deploy-script is not the newest commit's deploy script"
[[ ! -e $BASE/state/deploy-script.new ]] || fail "state/deploy-script.new was left behind"
# The newer script did all of the work, under the lock, which it took again.
[[ $(pnpm_askers) == "$BASE/state/deploy-script lock=held" ]] || fail "pnpm was asked by: $(pnpm_askers)"
expect_pnpm_call "hearth: build HEARTH_APPS_DIR=$BASE/releases/$release_g/hearth-stones"
[[ $(sed -n 's/^framework=//p' "$BASE/current/RELEASE") == "$G" ]] || fail "RELEASE does not name the commit"
# The installed copy had fetched the framework, so the newer one did not.
[[ $(fetches_of "$FRAMEWORK") == 1 ]] || fail "the framework was fetched $(fetches_of "$FRAMEWORK") times"
[[ $(fetches_of "$STONES") == 1 ]] || fail "the mini-apps were fetched $(fetches_of "$STONES") times"
[[ ! -e $BASE/state/failed ]] || fail "a failure note was written"
end_test

start_test "a run that is handed over says nothing when there is nothing new"
run HEARTH_DEPLOY_VERBOSE=
expect_status 0
[[ ! -s $T/out.log ]] || fail "the run said: $(<"$T/out.log")"
expect_started "$(started_as g $G)"
[[ $(fetches_of "$FRAMEWORK") == 1 ]] || fail "the framework was fetched $(fetches_of "$FRAMEWORK") times"
end_test

start_test "what the starter told the copy it started reaches nothing that copy starts"
# The newer script was told its commit and that the framework is fetched, in
# its environment. It went on to ask git for the mini-apps: that call, like
# every other so far, found neither there.
[[ $(fetches_of "$STONES") == 1 ]] || fail "the copy that was handed the run fetched the mini-apps $(fetches_of "$STONES") times"
[[ ! -s $T/git-told.log ]] || fail "git was started with HEARTH_DEPLOY_HANDED_OVER or HEARTH_DEPLOY_FETCHED in its environment: $(sort -u "$T/git-told.log" | tr '\n' ';')"
end_test

start_test "a run that finds its config file through the environment is handed over without an argument"
config=""
run HEARTH_DEPLOY_CONFIG="$T/deploy.conf"
expect_status 0
expect_output "Nothing new: main is already deployed."
# No argument of its own making: the newer script finds the file as the
# installed copy did.
expect_started "$(started_as g $G)"
[[ $(started) == "g args=[] "* ]] || fail "the newer script was given arguments: $(started)"
config=$T/deploy.conf
end_test

start_test "a copy that was started for the newest commit does not hand the run over again, and asks for no install"
make_commit $H "[$USERS,$LISTS]" "" 0.2.0
newer_script "$(script_of $H)" h
# The script under test, started as if it were that commit's deploy script,
# which is another one.
deploy HEARTH_DEPLOY_HANDED_OVER=$H
expect_status 0
expect_live b2b2b2b
expect_started ""
cmp -s "$BASE/state/deploy-script" "$(script_of $G)" || fail "state/deploy-script was written again"
[[ $(pnpm_askers) == "$script lock=held" ]] || fail "pnpm was asked by: $(pnpm_askers)"
# SELF_UPDATE is on: nothing is said of the release's deploy script, which
# differs from the copy that did the work.
expect_no_output "differs from the installed copy"
end_test

start_test "a copy that was told the framework is fetched does not fetch it again"
run HEARTH_DEPLOY_HANDED_OVER=$H HEARTH_DEPLOY_FETCHED=$H
expect_status 0
expect_output "Nothing new: main is already deployed."
[[ $(fetches_of "$FRAMEWORK") == 0 ]] || fail "the framework was fetched"
[[ $(fetches_of "$STONES") == 1 ]] || fail "the mini-apps were fetched $(fetches_of "$STONES") times"
# Told of another commit than its branch is at, it fetches: the branch moved
# after the copy that started it had looked.
run HEARTH_DEPLOY_HANDED_OVER=$H HEARTH_DEPLOY_FETCHED=$G
expect_status 0
[[ $(fetches_of "$FRAMEWORK") == 1 ]] || fail "the framework was fetched $(fetches_of "$FRAMEWORK") times"
end_test

start_test "with SELF_UPDATE=off the installed copy does the work and asks to be installed again"
write_config 5 SELF_UPDATE=off
make_commit $I "[$USERS,$LISTS]" "" 0.2.0
newer_script "$(script_of $I)" i
deploy
expect_status 0
expect_live c3c3c3c
release_i=$(current_release)
expect_started ""
[[ $(pnpm_askers) == "$script lock=held" ]] || fail "pnpm was asked by: $(pnpm_askers)"
expect_output "NOTE: deploy/hearth-deploy.sh in this release differs from the installed copy ($script). Install the new one when convenient; see docs/self-hosting.md."
expect_no_output "This run is carried out by"
cmp -s "$BASE/state/deploy-script" "$(script_of $G)" || fail "state/deploy-script was written"
[[ $(fetches_of "$FRAMEWORK") == 1 ]] || fail "the framework was fetched $(fetches_of "$FRAMEWORK") times"
end_test

start_test "with SELF_UPDATE=off nothing is fetched until a pending restart was dealt with"
# As before there was a hand-over: the fetch that finds the copy to do the
# work is not made, so a restart waits for no remote. Each fetch writes down
# whether the restart note was still there.
systemctl --no-ask-password stop hearth.service
: >"$BASE/state/restart-pending"
cat >"$T/during-fetch" <<EOF
#!/usr/bin/env bash
[[ -e $BASE/state/restart-pending ]] && echo pending >>"$T/at-fetch" || echo done >>"$T/at-fetch"
EOF
chmod +x "$T/during-fetch"
: >"$T/at-fetch"
run
rm "$T/during-fetch"
expect_status 0
expect_output "hearth.service now runs release $release_i (version c3c3c3c)."
[[ $(tr '\n' ' ' <"$T/at-fetch") == "done done " ]] ||
  fail "the framework and the mini-apps were fetched while the restart was: $(tr '\n' ' ' <"$T/at-fetch")"
expect_started ""
expect_live c3c3c3c
write_config 5
end_test

# ---------------------------------------------------------------------------
start_test "a commit whose deploy script cannot be parsed is not deployed"
make_commit $J "[$USERS,$LISTS]" "" 0.2.0
printf 'if\n' >>"$(script_of $J)"
restarts=$(count_of restart "$T/systemctl.log")
stops=$(count_of stop "$T/systemctl.log")
releases=$(release_count)
deploy
expect_status 1
expect_output "$(not_deployed $J $FOR_SDK_2 "bash cannot parse it") Push a commit that puts deploy/hearth-deploy.sh right; $(with_the_installed_copy)"
# What bash said, under the name the file has in the repository.
expect_output "    deploy/hearth-deploy.sh: line "
expect_output "Release $release_i is still the one in use."
expect_started ""
expect_live c3c3c3c
[[ $(current_release) == "$release_i" ]] || fail "\"current\" moved"
[[ $(count_of restart "$T/systemctl.log") == "$restarts" ]] || fail "the live service was restarted"
[[ $(count_of stop "$T/systemctl.log") == "$stops" ]] || fail "the live service was stopped"
[[ $(release_count) == "$releases" ]] || fail "a release was built"
[[ -z $(pnpm_calls) ]] || fail "pnpm was run: $(pnpm_calls)"
[[ $(failure_note) == "build $J $FOR_SDK_2" ]] || fail "the failure note is: $(failure_note)"
cmp -s "$BASE/state/deploy-script" "$(script_of $G)" || fail "the script that cannot be parsed was put under state/"
[[ ! -e $BASE/state/deploy-script.new ]] || fail "state/deploy-script.new was left behind"
end_test

start_test "such a commit is tried again after the waiting time, not on every run"
run
expect_status 1
expect_output "Trying again 15 minutes after that attempt"
expect_no_output "are not deployed"
touch -d "20 minutes ago" "$BASE/state/failed"
run
expect_status 1
expect_output "$(not_deployed $J $FOR_SDK_2 "bash cannot parse it")"
end_test

start_test "a copy that cannot hand the run over still clears leftovers away and finishes a pending restart"
# It does everything of a run but the build, by what it knows itself.
systemctl --no-ask-password stop hearth.service
: >"$BASE/state/restart-pending"
mkdir "$BASE/releases/20000101T000000Z"
touch -d "20 minutes ago" "$BASE/state/failed"
run
expect_status 1
expect_order "Removing the unfinished release 20000101T000000Z left by an interrupted run." \
  "hearth.service now runs release $release_i (version c3c3c3c)."
expect_order "hearth.service now runs release $release_i (version c3c3c3c)." \
  "$(not_deployed $J $FOR_SDK_2 "bash cannot parse it")"
[[ ! -e $BASE/releases/20000101T000000Z ]] || fail "the unfinished release was left behind"
[[ ! -e $BASE/state/restart-pending ]] || fail "the restart note was left behind"
[[ $(failure_note) == "build $J $FOR_SDK_2" ]] || fail "the failure note is: $(failure_note)"
# It stopped on nothing before the build, so it had no need to say why it is
# the copy that does the work.
expect_no_output "NOTE: the deploy script of framework commit"
expect_started ""
expect_live c3c3c3c
end_test

start_test "a commit without a deploy script is not deployed"
make_commit $K "[$USERS,$LISTS]" "" 0.2.0
rm "$(script_of $K)"
releases=$(release_count)
deploy
expect_status 1
expect_output "$(not_deployed $K $FOR_SDK_2 "that commit has no deploy/hearth-deploy.sh")"
expect_output "Release $release_i is still the one in use."
expect_live c3c3c3c
[[ $(release_count) == "$releases" ]] || fail "a release was built"
[[ $(failure_note) == "build $K $FOR_SDK_2" ]] || fail "the failure note is: $(failure_note)"
end_test

start_test "a commit whose deploy script is empty is not deployed"
# bash parses an empty file, and running it does nothing, with status 0: a
# run handed to it would end at once, every time, without a word.
make_commit $U "[$USERS,$LISTS]" "" 0.2.0
: >"$(script_of $U)"
releases=$(release_count)
deploy
expect_status 1
expect_output "$(not_deployed $U $FOR_SDK_2 "deploy/hearth-deploy.sh is empty in that commit") Push a commit that puts deploy/hearth-deploy.sh right; $(with_the_installed_copy)"
expect_output "Release $release_i is still the one in use."
expect_live c3c3c3c
[[ $(release_count) == "$releases" ]] || fail "a release was built"
[[ $(failure_note) == "build $U $FOR_SDK_2" ]] || fail "the failure note is: $(failure_note)"
cmp -s "$BASE/state/deploy-script" "$(script_of $G)" || fail "the empty script was put under state/"
[[ ! -e $BASE/state/deploy-script.new ]] || fail "state/deploy-script.new was left behind"
end_test

start_test "the next commit with a deploy script that works is handed the run and deployed"
make_commit $L "[$USERS,$LISTS]" "" 0.2.0
newer_script "$(script_of $L)" l
deploy
expect_status 0
expect_live f6f6f6f
expect_started "$(started_as l $L)"
[[ ! -e $BASE/state/failed ]] || fail "the failure note was left behind"
end_test

start_test "a copy that was started for the newest commit hands nothing over, whatever a comparison would say"
# git gives another text each time it is asked for that commit's deploy
# script, so that no reading of it is the same as any copy. A copy that
# compared would hand the run over, and the next one again, without end:
# hence the time limit.
echo 0 >"$T/show-never-the-same"
run_in=(timeout 30)
run
run_in=()
rm "$T/show-never-the-same"
expect_status 0
expect_output "Nothing new: main is already deployed."
expect_started "$(started_as l $L)"
end_test

# ---------------------------------------------------------------------------
start_test "a setting that the copy doing the work does not know stops it before it touches anything"
make_commit $M "[$USERS,$LISTS]" "" 0.2.0
newer_script "$(script_of $M)" m
write_config 5 FUTURE_SETTING=yes
# What an interrupted run leaves behind, and a note for the next one: a copy
# that goes to work clears the first away and deals with the second.
mkdir "$BASE/releases/20000101T000000Z"
: >"$BASE/state/restart-pending"
releases=$(release_count)
run
expect_status 1
# The installed copy does not know the setting either, and handed the run
# over all the same: the copy that stopped is the one that would do the work.
expect_started "$(started_as m $M)"
expect_output "ERROR: $T/deploy.conf, line $(grep -n '^FUTURE_SETTING=' "$T/deploy.conf" | cut -d: -f1): FUTURE_SETTING is not a setting this script knows."
expect_output "Nothing was changed."
[[ -d $BASE/releases/20000101T000000Z ]] || fail "the unfinished release was cleared away"
[[ -e $BASE/state/restart-pending ]] || fail "the restart note was dealt with"
[[ $(fetches_of "$STONES") == 0 ]] || fail "the mini-apps were fetched"
[[ $(release_count) == "$releases" ]] || fail "a release was built"
[[ ! -e $BASE/state/failed ]] || fail "a failure note was written"
expect_live f6f6f6f
end_test

start_test "a newer deploy script that knows the setting is handed the run by a copy that does not"
make_commit $N "[$USERS,$LISTS]" "" 0.2.0
newer_script "$(script_of $N)" n 's/^      HEARTH_BASE | /      FUTURE_SETTING | HEARTH_BASE | /'
deploy
expect_status 0
expect_live b8b8b8b
release_n=$(current_release)
expect_started "$(started_as n $N)"
expect_output "Removing the unfinished release 20000101T000000Z left by an interrupted run."
[[ ! -e $BASE/state/restart-pending ]] || fail "the restart note was left behind"
write_config 5
end_test

start_test "a value that only the work needs is refused by the copy that does the work, after the hand-over"
write_config 5 KEEP_RELEASES=abc
run
expect_status 1
expect_started "$(started_as n $N)"
expect_output "ERROR: KEEP_RELEASES must be a number, at least 1."
write_config 5
end_test

start_test "the folders that the work needs are made by the copy that does the work, and not before the hand-over"
# A later deploy script may keep its build logs elsewhere. With their folder
# gone, a run in which the copy that does the work stops on a setting leaves
# none behind: the starter made none, and the copy it started had not got
# that far.
rm -rf "$BASE/logs"
write_config 5 KEEP_RELEASES=abc
run
expect_status 1
expect_started "$(started_as n $N)"
expect_output "ERROR: KEEP_RELEASES must be a number, at least 1."
[[ ! -e $BASE/logs ]] || fail "the folder for the build logs was made before the hand-over, or before the settings were checked"
write_config 5
# The copy that goes to work makes it.
run
expect_status 0
expect_started "$(started_as n $N)"
[[ -d $BASE/logs ]] || fail "the copy that does the work did not make the folder for the build logs"
end_test

start_test "a line of the config file that cannot be read stops the copy that does the work, after the hand-over"
write_config 5 "future setting = 1"
run
expect_status 1
expect_started "$(started_as n $N)"
expect_output "ERROR: $T/deploy.conf, line $(grep -n '^future setting' "$T/deploy.conf" | cut -d: -f1): expected NAME=value."
expect_output "Nothing was changed."
write_config 5
end_test

start_test "a line that misspells one of the five settings a starter acts on stops the run before anything is fetched"
# No deploy script, however new, means anything by such a line, and the
# starter would go by the default in its place: fetch main where another
# branch was meant, or hand over a run that was to stay with it.
mapfile -t misspelt <<'EOF'
BRANCH: stable|BRANCH
Branch=stable|BRANCH
BRANCH stable|BRANCH
SELF_UPDATE off|SELF_UPDATE
SELF-UPDATE=off|SELF_UPDATE
self_update=off|SELF_UPDATE
remote = upstream|REMOTE
Hearth_Base=/srv/hearth|HEARTH_BASE
FRAMEWORK_REPO /srv/hearth/repos/hearth|FRAMEWORK_REPO
export BRANCH=stable|BRANCH
  export  SELF_UPDATE=off|SELF_UPDATE
EOF
for entry in "${misspelt[@]}"; do
  line=${entry%|*} name=${entry##*|}
  write_config 5 "$line"
  run
  expect_status 1
  expect_output "ERROR: $T/deploy.conf, line $(grep -n -x -F -- "$line" "$T/deploy.conf" | cut -d: -f1): expected $name=value."
  expect_output "Nothing was changed."
  [[ $(fetches_of "$FRAMEWORK") == 0 ]] || fail "the framework was fetched with the line: $line"
  expect_started ""
done
# A name that only begins like one of the five may be a later script's, with
# "export" before it or not: it is remembered, and the run is handed over.
for line in "BRANCH_PREFIX: release" "export BRANCH_PREFIX=release" "export=BRANCH"; do
  write_config 5 "$line"
  run
  expect_status 1
  expect_started "$(started_as n $N)"
  expect_output "ERROR: $T/deploy.conf, line $(grep -n -x -F -- "$line" "$T/deploy.conf" | cut -d: -f1): expected NAME=value."
done
write_config 5
end_test

start_test "when one of those five settings is wrong, a line of the config file that may be why is named with it"
# A letter too many in the name: the setting it was meant for has no value.
sed 's/^FRAMEWORK_REPO=/FRAMEWORK_REPOS=/' "$T/deploy.conf" >"$T/typo.conf"
config=$T/typo.conf
run
config=$T/deploy.conf
expect_status 1
expect_output "ERROR: FRAMEWORK_REPO is not set: the clone of the framework repository. Also: $T/typo.conf, line $(grep -n '^FRAMEWORK_REPOS=' "$T/typo.conf" | cut -d: -f1): FRAMEWORK_REPOS is not a setting this script knows."
[[ $(fetches_of "$FRAMEWORK") == 0 ]] || fail "the framework was fetched"
expect_started ""
end_test

start_test "SELF_UPDATE is on or off, which is checked before anything is fetched"
write_config 5 SELF_UPDATE=sometimes
run
expect_status 1
expect_output "ERROR: SELF_UPDATE must be on or off."
[[ $(fetches_of "$FRAMEWORK") == 0 ]] || fail "the framework was fetched"
expect_started ""
write_config 5
end_test

start_test "a starter needs none of the tools that only the work needs: without node, pnpm, tar and systemctl the run is still handed over"
# A later deploy script may do without any of them. A folder with the
# commands a starter and the substitute for git use, and those four left out.
mkdir "$T/starter-bin"
for tool in bash env git flock timeout cmp mv rm mkdir cp cat head tail sed date sleep true; do
  # The file on PATH, also for a command that bash has as a builtin.
  ln -s "$(type -P "$tool")" "$T/starter-bin/$tool"
done
run_in=(env "PATH=$T/starter-bin")
run
run_in=()
expect_status 1
expect_started "$(started_as n $N)"
# Said by the copy that was handed the run, which does need them.
expect_output "ERROR: The command 'node' is not installed or not on PATH."
end_test

start_test "the database is looked at by the copy that does the work, after the hand-over"
database_mode=$(stat -c %a "$DATABASE")
chmod 000 "$DATABASE"
run
chmod "$database_mode" "$DATABASE"
expect_status 1
expect_started "$(started_as n $N)"
expect_output "ERROR: This user cannot read $DATABASE or cannot write to $T/data"
end_test

start_test "the newer deploy script is checked and started by the bash that runs the starter, not by the one PATH finds"
# Another bash first on PATH, which writes down what it was asked to run
# and passes it on. The substitutes and the installed copy itself are
# started through it, by name; the newer script must not be.
mkdir "$T/other-bash"
cat >"$T/other-bash/bash" <<EOF
#!$BASH
printf '%s\n' "\$*" >>"$T/other-bash.log"
exec "$BASH" "\$@"
EOF
chmod +x "$T/other-bash/bash"
: >"$T/other-bash.log"
run_in=(env "PATH=$T/other-bash:$PATH")
run
run_in=()
expect_status 0
expect_started "$(started_as n $N)"
grep -qF -- "$script" "$T/other-bash.log" || fail "the bash that PATH finds was not asked for the installed copy, so this test shows nothing"
! grep -qF -- "$BASE/state/deploy-script" "$T/other-bash.log" ||
  fail "the bash that PATH finds was used: $(grep -F -- "$BASE/state/deploy-script" "$T/other-bash.log" | tr '\n' ';')"
end_test

# ---------------------------------------------------------------------------
start_test "when the fetch fails, the run is handed over by the commit fetched last, and a pending restart is finished once both copies have tried the fetch"
# The remote has a commit that the server has not fetched, with a deploy
# script of its own.
make_commit $O "[$USERS,$LISTS]" "" 0.2.0
newer_script "$(script_of $O)" o
systemctl --no-ask-password stop hearth.service
: >"$BASE/state/restart-pending"
: >"$T/fetch-fails"
run
rm "$T/fetch-fails"
expect_status 1
# Started without the word that the framework is fetched, so it tried that
# for itself: the restart waits for two fetches to fail, which here takes no
# time, and takes the fetch's time limit twice from a remote that does not
# answer.
expect_started "$(started_as n $N unset)"
[[ $(fetches_of "$FRAMEWORK") == 2 ]] || fail "the framework was fetched $(fetches_of "$FRAMEWORK") times"
expect_order "hearth.service now runs release $release_n (version b8b8b8b)." \
  "ERROR: Could not fetch main of the framework repository."
expect_output "    fatal: unable to access 'https://example.com/hearth.git/': Could not resolve host: example.com"
[[ ! -e $BASE/state/restart-pending ]] || fail "the restart note was left behind"
expect_live b8b8b8b
end_test

start_test "a process that the fetch left behind does not keep the lock from the copy the run is handed to"
# For three seconds that process has the installed copy's lock file open,
# and with it the lock, unless the installed copy gave the lock up itself.
echo 3 >"$T/fetch-leaves-a-process"
deploy
expect_status 0
expect_no_output "Another deploy is still running"
expect_started "$(started_as o $O)"
[[ $(pnpm_askers) == "$BASE/state/deploy-script lock=held" ]] || fail "pnpm was asked by: $(pnpm_askers)"
expect_live c9c9c9c
end_test

start_test "a run leaves when another holds the lock, before it fetches or hands anything over"
(
  exec 8>"$BASE/deploy.lock"
  flock 8
  exec sleep 60
) &
lock_holder=$!
for _ in {1..100}; do
  flock -n "$BASE/deploy.lock" true || break
  sleep 0.05
done
run
kill "$lock_holder"
wait "$lock_holder" 2>/dev/null || true
lock_holder=""
expect_status 0
expect_output "Another deploy is still running; leaving it to finish."
[[ $(fetches_of "$FRAMEWORK") == 0 ]] || fail "the framework was fetched"
expect_started ""
end_test

# ---------------------------------------------------------------------------
start_test "the deploy script under state/ is replaced by a new file, never written over"
# A copy that an earlier run started may still be reading that file. A second
# name for the file shows what such a copy goes on reading.
ln "$BASE/state/deploy-script" "$T/started-earlier"
make_commit $P "[$USERS,$LISTS]" "" 0.2.0
newer_script "$(script_of $P)" p
deploy
expect_status 0
expect_live d0d0d0d
expect_started "$(started_as p $P)"
cmp -s "$T/started-earlier" "$(script_of $O)" || fail "the file that an earlier run was started from was written over"
cmp -s "$BASE/state/deploy-script" "$(script_of $P)" || fail "state/deploy-script is not the newest commit's deploy script"
[[ ! $BASE/state/deploy-script -ef $T/started-earlier ]] || fail "state/deploy-script is still the same file"
rm "$T/started-earlier"
end_test

start_test "a deploy script that could not be read whole is never started"
make_commit $Q "[$USERS,$LISTS]" "" 0.2.0
newer_script "$(script_of $Q)" q
# git gives the first five lines and fails. Those would run, and write their
# line into started.log.
echo 5 >"$T/show-cut-short"
releases=$(release_count)
run
rm "$T/show-cut-short"
expect_status 1
expect_started ""
expect_output "$(not_deployed $Q $FOR_SDK_2 "it could not be copied from $FRAMEWORK to $BASE/state/deploy-script.new") Look at that clone, and at the space left on the disk; $(with_the_installed_copy)"
cmp -s "$BASE/state/deploy-script" "$(script_of $P)" || fail "state/deploy-script was replaced"
[[ ! -e $BASE/state/deploy-script.new ]] || fail "what could be read of it was left under state/"
[[ $(release_count) == "$releases" ]] || fail "a release was built"
expect_live d0d0d0d
end_test

start_test "a copy whose file under state/ was replaced after it started still knows which commit's script it is"
# Another run got in between: it fetched a newer commit and put that commit's
# deploy script where this copy was started from. A copy that compared itself
# with that file would take itself for the newer script, and deploy the newer
# commit with the older one.
make_commit $R "[$USERS,$LISTS]" "" 0.2.0
newer_script "$(script_of $R)" r
cat >"$T/during-fetch" <<EOF
#!/usr/bin/env bash
rm "$T/during-fetch"
cp "$(script_of $R)" "$BASE/state/deploy-script.other"
mv -T "$BASE/state/deploy-script.other" "$BASE/state/deploy-script"
EOF
chmod +x "$T/during-fetch"
# The copy an earlier run started for the commit before, as that run started it.
installed=$BASE/state/deploy-script
deploy HEARTH_DEPLOY_HANDED_OVER=$P
installed=$script
expect_status 0
expect_started "$(started_as p $P unset)
$(started_as r $R)"
expect_output "This run is carried out by the deploy script of framework commit ${R:0:12}."
expect_live f2f2f2f
[[ ! -e $BASE/state/failed ]] || fail "the failure note was left behind"
end_test

start_test "a run started in a folder that the deploy user may not enter deploys like any other, without a warning"
# A run by hand, as "sudo -u hearth hearth-deploy" in the caller's home
# folder: find cannot go back to such a folder when it is done, and ends
# with an error although it found everything. The installed copy is started
# there, and so is the copy it hands the run to.
make_commit $X "[$USERS,$LISTS]" "" 0.2.0
newer_script "$(script_of $X)" x
mkdir "$T/closed"
run_in=("$BASH" -c 'cd -- "$1" && chmod 000 . && shift && exec "$@"' _ "$T/closed")
deploy
run_in=()
chmod 755 "$T/closed"
expect_status 0
expect_started "$(started_as x $X)"
expect_live e7e7e7e
expect_output "is live (version e7e7e7e)."
expect_no_output "WARNING"
expect_no_output "Permission denied"
rmdir "$T/closed"
end_test

# ---------------------------------------------------------------------------
start_test "a run as root is refused before anything is fetched or handed over"
# Root in the script's eyes and nothing more: the test must not run anything
# as the real root. There are two ways. In a user namespace this user is
# root in its own eyes (unshare); Ubuntu 24.04 keeps ordinary users from
# making one unless a kernel setting is switched off. And fakeroot, which
# the image of GitHub's ubuntu-24.04 runners lists among its packages, tells
# a program that asks who it is "root", and changes nothing else.
as_root=()
for way in "unshare --map-root-user" fakeroot; do
  # Split into words on purpose.
  # shellcheck disable=SC2086
  if [[ $($way "$BASH" -c 'echo $EUID' 2>/dev/null) == 0 ]]; then
    read -r -a as_root <<<"$way"
    break
  fi
done
if ((${#as_root[@]} > 0)); then
  # The newest commit's deploy script is not the installed copy, so a run
  # that got further would be handed over.
  run_in=("${as_root[@]}")
  run
  run_in=()
  expect_status 1
  expect_output "ERROR: Do not run this as root"
  [[ $(fetches_of "$FRAMEWORK") == 0 ]] || fail "the framework was fetched"
  expect_started ""
  end_test
else
  skip_test "this user cannot be made root in its own eyes: neither \"unshare --map-root-user\" nor fakeroot works here. Allow user namespaces (on Ubuntu 24.04: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0) or install fakeroot"
fi

# ---------------------------------------------------------------------------
start_test "with SELF_UPDATE=off a copy started by a name relative to the caller's folder still knows its own file at the end"
# The work is done from /, where that name leads nowhere. The commit carries
# the script under test, so there is nothing to install and nothing to say.
make_commit $Y "[$USERS,$LISTS]" "" 0.2.0
write_config 5 SELF_UPDATE=off
installed=./${script##*/}
run_in=("$BASH" -c 'cd -- "$1" && shift && exec "$@"' _ "${script%/*}")
deploy
run_in=()
installed=$script
expect_status 0
expect_live f8f8f8f
expect_started ""
expect_no_output "differs from the installed copy"
write_config 5
end_test

# ---------------------------------------------------------------------------
start_test "with SELF_UPDATE=off the installed copy deploys a commit that has no deploy script"
make_commit $S "[$USERS,$LISTS]" "" 0.2.0
rm "$(script_of $S)"
write_config 5 SELF_UPDATE=off
deploy
expect_status 0
expect_live a3a3a3a
expect_started ""
# The release has no deploy script to install.
expect_output "$(do_not_install)"
expect_no_output "Install the new one"
write_config 5
# Once it is deployed there is nothing to build, and so nothing to stop for.
run
expect_status 0
expect_output "Nothing new: main is already deployed."
expect_started ""
end_test

start_test "a copy that could not hand the run over says so when the config file then stops it"
write_config 5 FUTURE_SETTING=yes
run
expect_status 1
expect_order "NOTE: the deploy script of framework commit ${S:0:12} cannot carry out this run, because that commit has no deploy/hearth-deploy.sh. So this copy does" \
  "FUTURE_SETTING is not a setting this script knows."
# And what to do about it.
expect_output "that a newer deploy script knows. Push a commit that puts deploy/hearth-deploy.sh right."
write_config 5
end_test

start_test "it says so too when a value, a missing tool or the database stops it, with what bash said of a script it cannot parse"
make_commit $W "[$USERS,$LISTS]" "" 0.2.0
printf 'if\n' >>"$(script_of $W)"
# A value that a later deploy script may well take.
write_config 5 KEEP_RELEASES=0
run
expect_status 1
expect_order "    deploy/hearth-deploy.sh: line " \
  "NOTE: the deploy script of framework commit ${W:0:12} cannot carry out this run, because bash cannot parse it. So this copy does"
expect_order "NOTE: the deploy script of framework commit ${W:0:12} cannot carry out this run" \
  "ERROR: KEEP_RELEASES must be a number, at least 1."
write_config 5
# A tool that a later deploy script may do without.
run_in=(env "PATH=$T/starter-bin")
run
run_in=()
expect_status 1
expect_order "NOTE: the deploy script of framework commit ${W:0:12} cannot carry out this run" \
  "ERROR: The command 'node' is not installed or not on PATH."
# A database that a later deploy script may read another way, or not at all.
database_mode=$(stat -c %a "$DATABASE")
chmod 000 "$DATABASE"
run
chmod "$database_mode" "$DATABASE"
expect_status 1
expect_order "NOTE: the deploy script of framework commit ${W:0:12} cannot carry out this run" \
  "ERROR: This user cannot read $DATABASE or cannot write to $T/data"
[[ ! -e $BASE/state/failed ]] || fail "a failure note was written"
end_test

start_test "a copy that knows no commit of the framework does the work itself as far as the fetch, which it reports last"
# The clone cannot be read, here because FRAMEWORK_REPO names a folder that
# is none. There is no deploy script to look at, so the run is not handed
# over, and what needs no network is done first, as when a fetch fails.
mkdir "$T/no-clone"
sed "s|^FRAMEWORK_REPO=.*|FRAMEWORK_REPO=$T/no-clone|" "$T/deploy.conf" >"$T/no-clone.conf"
mkdir "$BASE/releases/20000101T000000Z"
: >"$BASE/state/restart-pending"
config=$T/no-clone.conf
run
config=$T/deploy.conf
expect_status 1
expect_order "Removing the unfinished release 20000101T000000Z left by an interrupted run." \
  "ERROR: git cannot use $T/no-clone (the framework repository)."
expect_order "an earlier run could not confirm that" \
  "ERROR: git cannot use $T/no-clone (the framework repository)."
# Why not is git's to say: it may be a clone that belongs to another user,
# which git refuses with the command that allows it.
expect_order "    fatal: not a git repository (or any of the parent directories): .git" \
  "ERROR: git cannot use $T/no-clone (the framework repository)."
expect_no_output "is not a Git repository"
[[ ! -e $BASE/releases/20000101T000000Z ]] || fail "the unfinished release was left behind"
[[ ! -e $BASE/state/restart-pending ]] || fail "the restart note was left behind"
[[ ! -e $BASE/state/failed ]] || fail "a failure note was written"
expect_started ""
end_test

start_test "a base folder that cannot be used is what a starter says first, and a line it could not make sense of with it"
# With no base folder there is no lock and nobody to hand the run to, so the
# config file may be right for a deploy script this copy never got to: the
# folder comes first. The line is named too, because it may be the reason:
# HEARTH_BASE under a name with a letter too many (HEARTH_BASES) leaves the
# base folder at its default, which is then the folder that is not there.
printf 'HEARTH_BASE=%s\nFRAMEWORK_REPO=%s\nFUTURE_SETTING=yes\n' "$T/no-such-base" "$FRAMEWORK" >"$T/no-base.conf"
config=$T/no-base.conf
run
config=$T/deploy.conf
expect_status 1
expect_output "ERROR: $T/no-such-base does not exist or this user cannot write to it. Also: $T/no-base.conf, line 3: FUTURE_SETTING is not a setting this script knows."
[[ ! -e $T/no-such-base ]] || fail "the base folder was made"
end_test

start_test "an error in a copy that was handed the run names that copy's file with the line"
# The newest commit's deploy script parses, and fails as it does the work.
# The line counts in state/deploy-script, not in the installed copy.
make_commit $V "[$USERS,$LISTS]" "" 0.2.0
newer_script "$(script_of $V)" v 's/^pending_failure=""$/false/'
run
expect_status 1
expect_started "$(started_as v $V)"
expect_output "ERROR: An unexpected error occurred on line $(grep -n -x 'false' "$(script_of $V)" | cut -d: -f1) of $BASE/state/deploy-script."
expect_output "Nothing was changed."
end_test

# ---------------------------------------------------------------------------
start_test "a config file named relative to the caller's folder is found by the copy the run is handed to"
# A run by hand. The copy that is handed the run reads the starter's
# arguments from the folder the starter was started in, so a starter must
# not change folder before it hands the run over.
make_commit $Z "[$USERS,$LISTS]" "" 0.2.0
newer_script "$(script_of $Z)" z
config=deploy.conf
run_in=("$BASH" -c 'cd -- "$1" && shift && exec "$@"' _ "$T")
deploy
run_in=()
expect_status 0
expect_started "$(started_as z $Z)"
[[ $(started) == "z args=[deploy.conf] "* ]] || fail "the newer script was not given the name as the starter got it: $(started)"
config=$T/deploy.conf
expect_no_output "Cannot read the config file"
expect_live a9a9a9a
end_test

# ---------------------------------------------------------------------------
start_test "a link left at state/deploy-script.new is replaced, never written through"
# Written through it, the newest commit's deploy script would land where the
# link leads, outside state/, over what is there.
make_commit $AB "[$USERS,$LISTS]" "" 0.2.0
newer_script "$(script_of $AB)" ab
echo "not the deploy script's to write" >"$T/elsewhere"
ln -s "$T/elsewhere" "$BASE/state/deploy-script.new"
deploy
expect_status 0
expect_started "$(started_as ab $AB)"
expect_live b0b0b0b
[[ $(<"$T/elsewhere") == "not the deploy script's to write" ]] || fail "the file the link led to was written over"
[[ -f $BASE/state/deploy-script && ! -L $BASE/state/deploy-script ]] || fail "state/deploy-script is not a regular file"
cmp -s "$BASE/state/deploy-script" "$(script_of $AB)" || fail "state/deploy-script is not the newest commit's deploy script"
# Nor is a file made where a link leads that has nothing at its end.
rm "$T/elsewhere"
ln -s "$T/elsewhere" "$BASE/state/deploy-script.new"
run
expect_status 0
expect_started "$(started_as ab $AB)"
[[ ! -e $T/elsewhere ]] || fail "a file was made where the link led"
[[ -f $BASE/state/deploy-script && ! -L $BASE/state/deploy-script ]] || fail "state/deploy-script is not a regular file"
end_test

start_test "a folder left at state/deploy-script.new does not keep a run from being handed over"
mkdir "$BASE/state/deploy-script.new"
: >"$BASE/state/deploy-script.new/left-behind"
run
expect_status 0
expect_started "$(started_as ab $AB)"
expect_output "Nothing new: main is already deployed."
expect_no_output "unexpected error"
[[ ! -e $BASE/state/deploy-script.new ]] || fail "state/deploy-script.new was left behind"
end_test

start_test "a folder left at state/deploy-script does not keep a run from being handed over"
rm -f "$BASE/state/deploy-script"
mkdir "$BASE/state/deploy-script"
: >"$BASE/state/deploy-script/left-behind"
run
expect_status 0
expect_started "$(started_as ab $AB)"
expect_output "Nothing new: main is already deployed."
expect_no_output "Could not put the deploy script"
[[ -f $BASE/state/deploy-script && ! -L $BASE/state/deploy-script ]] || fail "state/deploy-script is not a regular file"
cmp -s "$BASE/state/deploy-script" "$(script_of $AB)" || fail "state/deploy-script is not the newest commit's deploy script"
[[ ! -e $BASE/state/deploy-script.new ]] || fail "state/deploy-script.new was left behind"
end_test

start_test "a deploy script that can be neither written under state/ nor cleared away there leaves the run to the copy that found out, as far as the build"
# state/ is closed to writing, with a file of an earlier run still at the
# name: the copy cannot remove it before it writes, nor afterwards.
make_commit $AC "[$USERS,$LISTS]" "" 0.2.0
newer_script "$(script_of $AC)" ac
echo "left by an earlier run" >"$BASE/state/deploy-script.new"
state_mode=$(stat -c %a "$BASE/state")
chmod 555 "$BASE/state"
releases=$(release_count)
deploy
chmod "$state_mode" "$BASE/state"
expect_status 1
expect_started ""
expect_no_output "unexpected error"
expect_output "$(not_deployed $AC $FOR_SDK_2 "it could not be copied from $FRAMEWORK to $BASE/state/deploy-script.new") Look at that clone, and at the space left on the disk; $(with_the_installed_copy)"
expect_output "Release $(current_release) is still the one in use."
[[ $(release_count) == "$releases" ]] || fail "a release was built"
[[ $(<"$BASE/state/deploy-script.new") == "left by an earlier run" ]] || fail "the file that could not be removed was written over"
expect_live b0b0b0b
# With state/ open again the run is handed over, and the commit deployed.
deploy
expect_status 0
expect_started "$(started_as ac $AC)"
expect_live c1c1c1c
[[ ! -e $BASE/state/deploy-script.new ]] || fail "state/deploy-script.new was left behind"
end_test

# ---------------------------------------------------------------------------
start_test "with SELF_UPDATE=off the installed copy asks for no install of a release's deploy script that no hand-over would start"
# "off" is also the way to deploy a commit whose deploy script is broken.
# Installed in the installed copy's place, as the note asks of a script that
# differs, such a script would end every run from then on.
write_config 5 SELF_UPDATE=off
# One that bash cannot parse.
make_commit $AD "[$USERS,$LISTS]" "" 0.2.0
printf 'if\n' >>"$(script_of $AD)"
deploy
expect_status 0
expect_live d2d2d2d
expect_started ""
expect_output "$(do_not_install)"
expect_no_output "Install the new one"
# An empty one.
make_commit $AE "[$USERS,$LISTS]" "" 0.2.0
: >"$(script_of $AE)"
deploy
expect_status 0
expect_live e3e3e3e
expect_output "$(do_not_install)"
expect_no_output "Install the new one"
# A link, here to a script that works: no regular file, which is what a
# hand-over asks for.
make_commit $AF "[$USERS,$LISTS]" "" 0.2.0
newer_script "$FRAMEWORK/commits/$AF/deploy/the-script.sh" af
rm "$(script_of $AF)"
ln -s the-script.sh "$(script_of $AF)"
deploy
expect_status 0
expect_live f4f4f4f
expect_started ""
expect_output "$(do_not_install)"
expect_no_output "Install the new one"
write_config 5
end_test

# ---------------------------------------------------------------------------
start_test "with the real git, the newest commit's deploy script is read from the clone and started, or turned down"
if real_git=$(PATH=$system_path && command -v git); then
  REAL=$T/real
  mkdir -p "$REAL/bin" "$REAL/base" "$REAL/work"
  # Everything but git stays a substitute.
  ln -s "$T/bin/pnpm" "$T/bin/systemctl" "$REAL/bin/"
  real() {
    GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 "$real_git" \
      -c user.name=Sample -c user.email=sample@example.com -c init.defaultBranch=main "$@"
  }
  # commit_real MESSAGE: commits what the work folder holds, and pushes it to
  # the remote's main branch. The commit is left in $real_commit.
  real_commit=""
  commit_real() {
    real -C "$REAL/work" add -A
    real -C "$REAL/work" commit -q -m "$1"
    real -C "$REAL/work" push -q "$REAL/remote.git" HEAD:main
    real_commit=$(real -C "$REAL/work" rev-parse HEAD)
  }
  real init -q --bare "$REAL/remote.git"
  real init -q "$REAL/work"
  commit_files "$REAL/work" "[$USERS]"
  newer_script "$REAL/work/deploy/hearth-deploy.sh" real "" "$REAL/base"
  commit_real "A release"
  first_commit=$real_commit
  real clone -q "$REAL/remote.git" "$REAL/clone"
  cat >"$REAL/deploy.conf" <<EOF
HEARTH_BASE=$REAL/base
FRAMEWORK_REPO=$REAL/clone
SERVICE=
DATABASE=
HEALTH_PORT=$HEALTH_PORT
HEALTH_TIMEOUT=5
EOF
  config=$REAL/deploy.conf
  run_in=(env "PATH=$REAL/bin:$system_path" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1)

  deploy
  expect_status 0
  expect_started "$(started_as real "$first_commit")"
  cmp -s "$REAL/base/state/deploy-script" "$REAL/work/deploy/hearth-deploy.sh" ||
    fail "state/deploy-script is not the commit's deploy script, byte for byte"
  [[ $(pnpm_askers) == "$REAL/base/state/deploy-script lock=held" ]] || fail "pnpm was asked by: $(pnpm_askers)"
  [[ $(sed -n 's/^framework=//p' "$REAL/base/current/RELEASE") == "$first_commit" ]] ||
    fail "RELEASE does not name the commit"
  expect_output "is live (version "

  # Only a commit's ID is taken for the commit a copy was started for. A name
  # that git would read as the newest commit makes no copy that commit's
  # deploy script: the installed copy still hands the run over.
  run HEARTH_DEPLOY_HANDED_OVER="origin/main"
  expect_status 0
  expect_started "$(started_as real "$first_commit")"
  expect_output "Nothing new: main is already deployed."

  # A link where the script was: git would hand out where it leads.
  rm "$REAL/work/deploy/hearth-deploy.sh"
  ln -s ../elsewhere.sh "$REAL/work/deploy/hearth-deploy.sh"
  commit_real "The deploy script becomes a link"
  run
  expect_status 1
  expect_started ""
  expect_output "$(not_deployed "$real_commit" none "deploy/hearth-deploy.sh is not a regular file in that commit")"

  rm "$REAL/work/deploy/hearth-deploy.sh"
  commit_real "The deploy script is gone"
  run
  expect_status 1
  expect_started ""
  expect_output "$(not_deployed "$real_commit" none "that commit has no deploy/hearth-deploy.sh")"
  [[ $(sed -n 's/^framework=//p' "$REAL/base/current/RELEASE") == "$first_commit" ]] ||
    fail "\"current\" moved"

  # The remote is gone: what git itself says about it is passed on.
  mv "$REAL/remote.git" "$REAL/remote.gone"
  run
  expect_status 1
  expect_output "does not appear to be a git repository"
  expect_output "ERROR: Could not fetch main of the framework repository."

  config=$T/deploy.conf
  run_in=()
  end_test
else
  skip_test "git is not installed"
fi

if ((skipped > 0)); then
  echo "deploy tests: $passed passed, $skipped skipped."
  if [[ -n ${CI:-} ]]; then
    trap - EXIT
    echo "deploy tests: FAILED, because CI is set, where every test must run. The lines that begin with SKIPPED say what each one needs." >&2
    cleanup_folder
    exit 1
  fi
else
  echo "deploy tests: $passed passed."
fi
