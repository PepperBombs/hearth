#!/usr/bin/env bash
#
# hearth-deploy: pull-based deployment for one server.
#
# A systemd timer runs the installed copy of this script every minute (see
# deploy/systemd). Every run is carried out by the deploy script of the
# newest framework commit the server knows: the installed copy only starts
# it, as "Which copy does the work" below describes. So a commit is built,
# tried and switched to by its own deploy script, also the commit that
# changes the script, and the installed copy never needs installing again.
#
# The copy that does the work:
#
#   1. fetches the main branch of the mini-apps repository, and of the
#      framework repository unless that was fetched to find this copy;
#   2. stops there, silently, if neither has a new commit;
#   3. otherwise builds a fresh release in a new folder named after the time:
#      the framework, with the mini-apps of the same moment built in. The
#      mini-apps are first linked to the SDK of the framework beside them,
#      offline, and the build refuses them if they were written for another
#      version of the SDK;
#   4. starts that build on a spare port, against a copy of the database and
#      with the mini-apps' jobs switched off (HEARTH_JOBS=off), and checks
#      that it answers. A migration that fails on the real data fails here,
#      before anything live is touched;
#   5. stops the service for a moment, copies the database as it then is,
#      points the "current" link at the new release (one atomic rename) and
#      starts the service, then checks the running service;
#   6. keeps the newest few releases and deletes the rest.
#
# If a step up to and including 4 fails, the release that was running keeps
# running and nothing of it was touched. If the new release fails in step 5,
# the script goes back: it stops the service, puts the database back as it
# was just before the switch, and starts the previous release. An older build
# refuses a database that a newer build has migrated, which is why the
# database has to go back too. Either way the reason is logged and the exit
# status is not zero.
#
# Commits that failed before the switch are tried again after
# RETRY_AFTER_MINUTES, except mini-apps written for another version of the SDK
# than the framework holds: building the same commits again cannot change
# that, so they wait for the next commit of either repository, which is built
# at once. Commits that failed as the live service are not tried again by
# themselves, because every try interrupts the site: they wait for a new
# commit, or for state/failed to be deleted.
#
# Which copy does the work
#
# The installed copy (/usr/local/bin/hearth-deploy) belongs to root, and this
# script runs as the deploy user, who cannot replace it. So the installed
# copy is a starter. Before it reads or changes anything else on the server,
# it
#
#   a. reads the config file and checks the five settings it needs itself:
#      HEARTH_BASE, FRAMEWORK_REPO, REMOTE, BRANCH and SELF_UPDATE;
#   b. refuses to run as root;
#   c. takes the lock;
#   d. fetches the framework's branch, and reads the deploy script of the
#      commit it is at (deploy/hearth-deploy.sh) from the clone;
#   e. if that script differs from itself, byte for byte, and bash can parse
#      it: writes it to state/deploy-script, gives up the lock, and starts it
#      in its own place with its own arguments. This is the hand-over.
#
# The copy started that way begins like any other, at (a). It was told which
# commit's script it is, and that the branch was fetched a moment ago: so it
# fetches nothing, finds the branch at its own commit, and does the work. A
# copy that is the newest commit's script already does the work itself, and
# the fetch of (d) is that run's fetch of the framework. Either way the
# framework is fetched once in a run.
#
# A copy that was started for the commit its branch is at never hands the run
# over again, whatever it finds there, so no two copies can pass a run to and
# fro. Only if the branch has moved on since the starter looked (another run
# got in between, or the starter's fetch had failed and its own did not) does
# it look again, and it hands over once more if the deploy script of the
# newer commit differs from that of the commit it was started for.
#
# A hand-over happens on every run once the installed copy is older than the
# branch, so it says nothing unless HEARTH_DEPLOY_VERBOSE is set.
#
# If the fetch of (d) fails, the run goes on, by the commit that was fetched
# last: finishing a restart that is still pending needs no network. If none
# was ever fetched, or the clone cannot be read at all, there is no deploy
# script to look at, and this copy goes on itself. The failure is reported
# in step 1, by the copy that gets there. The restart
# does wait for the fetch to fail, though, since (d) comes before anything
# else: no time at all when the remote refuses, and up to the fetch's limit
# of two minutes when the remote does not answer. A copy that is handed the
# run after a fetch that failed is not told that the branch is fetched, so it
# tries for itself, and the restart then waits for two fetches.
#
# A commit whose deploy script is missing, empty, or cannot be parsed, is not
# deployed: nothing could carry out its run. The copy that found this does
# everything else (the leftovers of an interrupted run, a pending restart,
# "nothing new") and stops with an error where it would start to build.
# Like any failed build, that is tried again after RETRY_AFTER_MINUTES, or at
# once after a new commit. When that copy stops earlier, on the config file
# or on something else that only the work needs, it says first why it is the
# one doing the work: what stopped it may be right for a newer deploy script.
#
# A deploy script that bash can parse is handed the run, whatever it then
# does. If it fails as it runs, or does nothing, then for as long as its
# commit is the newest nothing a run does happens: a pending restart is not
# finished and newer mini-apps are not deployed either, at every run, and a
# script that ends with status 0 says nothing of it. The way out is the next
# commit whose deploy script works, which is handed the run at once, or
# SELF_UPDATE=off.
#
# The newest commit's code runs as the deploy user in every build anyway
# (pnpm build), so running that commit's deploy script as the same user
# gives it no right it did not have. The systemd units and the polkit rule
# are not kept up to date this way: they need root, and the polkit rule is
# what limits the deploy user. See docs/self-hosting.md.
#
# SELF_UPDATE=off in the config file switches all of this off. The installed
# copy then does the work itself, and says so after a deploy when the
# release's deploy script differs from it, or when that script is one that
# must not be installed: missing, empty, not a regular file or not parsed.
#
# What an installed copy counts on, for as long as it stays installed. A
# later version of this script must keep to all of it: to the first list
# below for the hand-over, and to the second for the run that cannot be
# handed over. Everything else may change.
#
#   - the framework repository holds the script as the regular file
#     deploy/hearth-deploy.sh;
#   - the script is started as "bash <file> <the starter's arguments>",
#     holding no lock, with HEARTH_DEPLOY_HANDED_OVER=<the commit whose
#     script it is> in its environment, and with HEARTH_DEPLOY_FETCHED=<that
#     commit> as well when the starter has just fetched the framework's
#     branch;
#   - the lock is a flock on $HEARTH_BASE/deploy.lock;
#   - the five settings of (a): their names, what they mean, their defaults,
#     and where the config file is found and how it is written (see "Usage"
#     and deploy/deploy.conf.example);
#   - state/deploy-script and state/deploy-script.new are the starter's to
#     write. Whatever lies at the second, a link or a folder too, is removed
#     before it is written.
#
# So, before the hand-over, a copy must not stop on what only the copy that
# does the work needs. A line of the config file that it cannot read, or a
# setting it does not know, is only remembered until then, unless the line
# is plainly one of the five settings misspelt, which no later script can
# mean anything by; nothing but the five settings is checked; and the tools,
# the folders and the database that only the work needs are looked at
# afterwards.
#
# The second list is for the runs that an installed copy cannot hand over.
# There are two kinds. The newest commit's deploy script is missing, empty,
# not a regular file or not parsed, or could not be copied under state/: the
# copy then does that run's work itself, up to where the build would start.
# Or the copy knows no commit of the framework: the clone cannot be read
# (FRAMEWORK_REPO does not name one, or names one that git refuses this
# user), or the branch was never fetched and the fetch fails. It then does
# the work up to step 1, which reports the fetch. Either way it goes by what
# it knew on the day it was installed. So a later version must also leave
# these as they are, or change them only in a way that a copy as old as the
# oldest one installed gets right:
#
#   - a release is a folder releases/<time>, named as is_release_name says,
#     and a finished one holds the file RELEASE with the lines framework=,
#     apps= and version=. Such a copy DELETES every folder with a name like
#     that and no RELEASE, unless "current" points at it;
#   - "current" is a link to releases/<time>;
#   - while state/restart-pending exists (it holds the number of tries so
#     far, or nothing), such a copy restarts SERVICE, up to three times,
#     until LIVE_URL/api/health reports the version of current/RELEASE;
#   - state/failed is one line, "<stage> <framework commit> <apps commit>",
#     the stage being build, sdk or live. Such a copy reads it, and writes
#     "build ..." for the commits whose deploy script it could not start;
#   - beside DATABASE, such a copy deletes hearth-deploy-trial-*.db (with
#     -wal and -shm) and DATABASE.restoring;
#   - such a copy stops, before any of this, on a setting in the config file
#     that it does not know, and on a value it would refuse. So a new
#     setting is safe to add; a new meaning for an old file or folder is not.
#
# Layout under HEARTH_BASE (default /opt/hearth):
#
#   repos/hearth, repos/hearth-stones   clones; this script only fetches them
#   releases/20260101T120000Z/        one folder per release
#       hearth/                       the framework at one commit, built
#       hearth-stones/                the mini-apps at one commit, linked to
#                                     hearth/packages/sdk and built into it
#       RELEASE                       which commits, and when
#       release.env                   HEARTH_VERSION for the service
#   current -> releases/...           the release the service runs
#   logs/                             build output, one file per attempt
#   state/                            notes this script leaves for itself
#       failed                        the commits that failed, and at which stage
#                                     (build, sdk or live)
#       restart-pending               "current" was switched; restart not confirmed
#       deploy-script                 the deploy script of the newest framework
#                                     commit, as the installed copy started it
#                                     last (deploy-script.new while it is
#                                     being written)
#   pnpm-store/                       pnpm's package store
#   deploy.lock                       held while a run is in progress
#
# Next to the database (DATABASE, default /var/lib/hearth/hearth.db), readable
# by this user only:
#
#   hearth-deploy-before-<release>.db   the database just before the switch to
#                                       that release; the newest one is kept
#   hearth-deploy-failed-<release>.db   the database a failed release left
#                                       behind, kept for a look; newest only
#   hearth-deploy-trial-<release>.db    the copy the trial start runs against;
#                                       deleted when the trial ends
#
# Secrets: this script never reads the service's secrets file. The build and
# the trial start get a clean environment, so nothing secret can reach a log.
# The trial start reads a copy of the database; none of its rows are logged.
#
# Usage: hearth-deploy [CONFIG_FILE]
#   The config file defaults to $HEARTH_DEPLOY_CONFIG, then
#   /etc/hearth/deploy.conf. See deploy/deploy.conf.example.
#   With HEARTH_DEPLOY_VERBOSE set to anything, a run also says when it hands
#   over to another copy and when it finds nothing new.

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
SELF_UPDATE=on
KEEP_RELEASES=5
SERVICE=hearth.service
LIVE_URL=http://127.0.0.1:4310
DATABASE=/var/lib/hearth/hearth.db
HEALTH_PORT=4319
HEALTH_TIMEOUT=30
RETRY_AFTER_MINUTES=15

# How often a later run restarts a service that did not come up. Not a setting.
RESTART_TRIES=3

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
attempt_stage=build # "sdk" when the mini-apps were written for another SDK
#                     version; "live" once the running service has been touched
new_release=""      # folder of the release being built
activated=no        # yes once "current" points at the new release
health_pid=""       # the trial server, while it runs
trial_db=""         # the copy of the database the trial server uses
build_log=""
previous_note="Nothing was changed."
framework_commit=""     # the commit the framework's branch is at, once known
script_problem=""       # why that commit's deploy script cannot be handed the
#                         run, if it cannot; see read_deploy_script
script_remedy=""        # what to do about it
script_problem_lines="" # what bash said about a script it cannot parse
explain_this_copy=no    # yes while this copy checks what only the work needs

# Why this copy does the work, although it is not the deploy script of the
# newest framework commit.
say_script_problem() {
  [[ -z $script_problem_lines ]] || printf '%s\n' "$script_problem_lines" | sed 's/^/    /' >&2
  log "NOTE: the deploy script of framework commit ${framework_commit:0:12} cannot carry out this run, because $script_problem. So this copy does, which may not know a setting or a value that a newer deploy script knows. $script_remedy." >&2
}

die() {
  trap - ERR
  set +e
  # Said first, because what stops this copy may well be right: written for a
  # deploy script newer than this copy, which this run could not be handed to.
  [[ $explain_this_copy != yes || -z $script_problem ]] || say_script_problem
  log "ERROR: $*" >&2
  if [[ -n $build_log && -s $build_log ]]; then
    log "Last lines of $build_log:" >&2
    tail -n 40 -- "$build_log" | redact | sed 's/^/    /' >&2
  fi
  if [[ -n $attempt_key ]]; then
    mkdir -p -- "$state_dir" && printf '%s %s\n' "$attempt_stage" "$attempt_key" >"$state_dir/failed"
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

remove_trial_database() {
  if [[ -n $trial_db ]]; then
    rm -f -- "$trial_db" "$trial_db-wal" "$trial_db-shm" || true
    trial_db=""
  fi
}

on_exit() {
  local status=$?
  trap - EXIT
  stop_health_server
  remove_trial_database
  if [[ -n $new_release && $activated != yes && -d $new_release ]]; then
    rm -rf -- "$new_release" || true
  fi
  exit "$status"
}
trap on_exit EXIT
trap 'die "Interrupted."' INT TERM
# The file is named with the line: after a hand-over the copy that speaks is
# state/deploy-script, not the installed one.
trap 'die "An unexpected error occurred on line $LINENO of ${BASH_SOURCE[0]}."' ERR

# ---------------------------------------------------------------------------
# Config file: lines of NAME=value. No shell code is run from it.
# ---------------------------------------------------------------------------

# The first thing wrong with the config file: a line this copy cannot read,
# or a setting it does not know. Reading does not stop on it, because a newer
# deploy script may know better, and this copy may only be the one that
# hands the run over to it. The copy that does the work stops on it.
#
# Not so a line that cannot be read and begins with the name of one of the
# five settings a copy acts on before it hands a run over, in any mix of
# capitals, or with a hyphen for the underscore, or after the word "export",
# which someone who takes the file for shell code writes: "Branch=stable",
# "BRANCH: stable", "SELF-UPDATE=off", "export BRANCH=stable". No deploy
# script, however new, means anything by such a line, and this copy would
# go by the default in its place: fetch another branch than the one meant,
# or hand over a run that was to stay here. Reading stops there.
config_problem=""
load_config() {
  local file=$1 line number=0 name value
  [[ -r $file ]] || die "Cannot read the config file $file."
  while IFS= read -r line || [[ -n $line ]]; do
    number=$((number + 1))
    line=${line%$'\r'}
    [[ $line =~ ^[[:space:]]*(#.*)?$ ]] && continue
    if ! [[ $line =~ ^[[:space:]]*([A-Z_]+)[[:space:]]*=[[:space:]]*(.*)$ ]]; then
      if [[ $line =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z0-9_-]+) ]]; then
        name=${BASH_REMATCH[2]^^}
        name=${name//-/_}
        case $name in
          HEARTH_BASE | FRAMEWORK_REPO | REMOTE | BRANCH | SELF_UPDATE)
            die "$file, line $number: expected $name=value."
            ;;
        esac
      fi
      [[ -n $config_problem ]] || config_problem="$file, line $number: expected NAME=value."
      continue
    fi
    name=${BASH_REMATCH[1]}
    value=${BASH_REMATCH[2]}
    value=${value%"${value##*[![:space:]]}"}
    if [[ $value =~ ^\"(.*)\"$ || $value =~ ^\'(.*)\'$ ]]; then
      value=${BASH_REMATCH[1]}
    fi
    case $name in
      HEARTH_BASE | FRAMEWORK_REPO | APPS_REPO | REMOTE | BRANCH | SELF_UPDATE | \
        KEEP_RELEASES | SERVICE | LIVE_URL | DATABASE | HEALTH_PORT | HEALTH_TIMEOUT | \
        RETRY_AFTER_MINUTES)
        printf -v "$name" '%s' "$value"
        ;;
      *)
        [[ -n $config_problem ]] ||
          config_problem="$file, line $number: $name is not a setting this script knows."
        ;;
    esac
  done <"$file"
}

# number_between VALUE MIN MAX
number_between() { [[ $1 =~ ^[0-9]{1,9}$ ]] && ((10#$1 >= $2 && 10#$1 <= $3)); }

# The five settings a copy needs before it hands a run over. Nothing else is
# checked before that: what a newer deploy script makes of the other settings
# is its own business.
check_starter_settings() {
  [[ $HEARTH_BASE == /* && $HEARTH_BASE != / ]] || starter_setting "HEARTH_BASE must be an absolute path."
  [[ -n $FRAMEWORK_REPO ]] || starter_setting "FRAMEWORK_REPO is not set: the clone of the framework repository."
  [[ $FRAMEWORK_REPO == /* ]] || starter_setting "FRAMEWORK_REPO must be an absolute path."
  [[ $REMOTE =~ ^[A-Za-z0-9._-]+$ ]] || starter_setting "REMOTE must be the name of a Git remote, such as origin."
  [[ $BRANCH =~ ^[A-Za-z0-9._/-]+$ ]] || starter_setting "BRANCH must be the name of a branch, such as main."
  [[ $SELF_UPDATE == on || $SELF_UPDATE == off ]] || starter_setting "SELF_UPDATE must be on or off."
}

# Stops on one of those five. What was only remembered of the config file is
# said with it, since it may be the reason: a name with a letter too many
# leaves the setting it was meant for as it was.
starter_setting() {
  die "$1${config_problem:+ Also: $config_problem}"
}

# The settings only the copy that does the work needs.
check_settings() {
  [[ -z $APPS_REPO || $APPS_REPO == /* ]] || die "APPS_REPO must be an absolute path, or empty."
  # The build finds the mini-apps through HEARTH_APPS_DIR, a list of folders
  # separated by colons: a colon here would silently build a release without them.
  [[ -z $APPS_REPO || $HEARTH_BASE != *:* ]] ||
    die "HEARTH_BASE must not contain a colon while APPS_REPO is set: the build is told where the mini-apps are in HEARTH_APPS_DIR, which separates folders with colons."
  number_between "$KEEP_RELEASES" 1 1000 || die "KEEP_RELEASES must be a number, at least 1."
  number_between "$HEALTH_PORT" 1 65535 || die "HEALTH_PORT must be a port number."
  number_between "$HEALTH_TIMEOUT" 1 3600 || die "HEALTH_TIMEOUT must be a number of seconds, at least 1."
  number_between "$RETRY_AFTER_MINUTES" 0 100000 || die "RETRY_AFTER_MINUTES must be a number of minutes."
  [[ -z $SERVICE || $SERVICE =~ ^[A-Za-z0-9:_.@-]+\.service$ ]] || die "SERVICE must be a unit name such as hearth.service, or empty."
  [[ -z $SERVICE || $LIVE_URL =~ ^http://[^/[:space:]]+$ ]] || die "LIVE_URL must look like http://127.0.0.1:4310, with no path."
  [[ -z $DATABASE || ($DATABASE == /* && $DATABASE != */) ]] || die "DATABASE must be the absolute path of the database file (HEARTH_DB of the service), or empty."
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

# try_fetch REPO LABEL: fetches the branch and leaves the commit it is at in
# $fetched_commit. If it cannot, it returns 1 and leaves what to say about it
# in $fetch_failure, and what git said in $fetch_output. That is kept also
# for a clone git cannot use: a folder that is no repository is one reason,
# and a repository that belongs to another user, which git refuses and says
# how to allow, is another.
fetched_commit=""
fetch_failure=""
fetch_output=""
try_fetch() {
  local repo=$1 label=$2
  fetched_commit="" fetch_failure="" fetch_output=""
  if ! fetch_output=$(git -C "$repo" rev-parse --git-dir 2>&1); then
    fetch_failure="git cannot use $repo (the $label)."
    return 1
  fi
  if ! fetch_output=$(GIT_TERMINAL_PROMPT=0 timeout 120 git -C "$repo" fetch --quiet --no-tags \
    "$REMOTE" "+refs/heads/$BRANCH:refs/remotes/$REMOTE/$BRANCH" 2>&1); then
    fetch_failure="Could not fetch $BRANCH of the $label."
    return 1
  fi
  fetch_output=""
  if ! fetched_commit=$(git -C "$repo" rev-parse --verify --quiet "refs/remotes/$REMOTE/$BRANCH^{commit}"); then
    fetch_failure="The $label has no branch $BRANCH on $REMOTE."
    return 1
  fi
}

# Says why the last try_fetch failed, and stops.
fetch_failed() {
  [[ -z $fetch_output ]] || printf '%s\n' "$fetch_output" | redact | sed 's/^/    /' >&2
  die "$fetch_failure"
}

# The commit the framework's branch was at when it was last fetched, or
# nothing.
framework_branch_commit() {
  git -C "$FRAMEWORK_REPO" rev-parse --verify --quiet "refs/remotes/$REMOTE/$BRANCH^{commit}" 2>/dev/null || true
}

# read_deploy_script COMMIT FILE: copies the deploy script of a framework
# commit out of the clone into FILE. If it cannot, it returns 1 and leaves the
# reason in $script_problem, and what to do about it in $script_remedy.
# Whatever lay at FILE is removed first, so that FILE is a new regular file:
# written through a link left there, the script would land where the link
# leads, outside state/, and a folder left there would stop every copy.
script_remedy="Push a commit that puts deploy/hearth-deploy.sh right"
read_deploy_script() {
  local commit=$1 file=$2 entry
  # git show alone would not do: for a link it prints where the link leads,
  # and for a folder a list of its files.
  if ! entry=$(git -C "$FRAMEWORK_REPO" ls-tree "$commit" -- deploy/hearth-deploy.sh 2>/dev/null); then
    script_problem="git could not read it from $FRAMEWORK_REPO"
    script_remedy="Look at that clone"
  elif [[ -z $entry ]]; then
    script_problem="that commit has no deploy/hearth-deploy.sh"
  elif [[ $entry != 100???" blob "* ]]; then
    script_problem="deploy/hearth-deploy.sh is not a regular file in that commit"
  elif ! mkdir -p -- "$state_dir" || ! rm -rf -- "$file" 2>/dev/null ||
    ! git -C "$FRAMEWORK_REPO" show "$commit:deploy/hearth-deploy.sh" >"$file" 2>/dev/null; then
    script_problem="it could not be copied from $FRAMEWORK_REPO to $file"
    script_remedy="Look at that clone, and at the space left on the disk"
  elif [[ ! -s $file ]]; then
    # bash parses an empty file without a word, and running it does nothing,
    # with status 0: every run would end there, silently.
    script_problem="deploy/hearth-deploy.sh is empty in that commit"
  fi
  [[ -z $script_problem ]]
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

# service_command VERB: "restart" or "stop". Restarting also starts a service
# that is not running.
service_command() {
  local output
  if ! output=$(timeout 90 systemctl --no-ask-password "$1" "$SERVICE" 2>&1); then
    [[ -z $output ]] || printf '%s\n' "$output" | sed 's/^/    /' >&2
    return 1
  fi
}

# Restarts the service and waits for it to report VERSION.
restart_and_check() {
  local version=$1
  if ! service_command restart; then
    probe_reason="systemctl could not restart $SERVICE (may this user restart it? see docs/self-hosting.md)"
    return 1
  fi
  wait_healthy "$LIVE_URL" "$version" api
}

# snapshot_database FROM TO: writes a complete, consistent copy of the SQLite
# database FROM into the new file TO. It is safe while a server has FROM
# open, and it includes what is still in the write-ahead log. It uses the
# SQLite library of the release being built, so the server needs no extra
# tool. The copy is readable by this user only.
snapshot_database() {
  (cd -- "$server_dir" && umask 077 && clean_env node -e '
    const Database = require("better-sqlite3");
    const [from, to] = process.argv.slice(1);
    const db = new Database(from, { readonly: true, fileMustExist: true, timeout: 10000 });
    try {
      db.prepare("VACUUM INTO ?").run(to);
    } finally {
      db.close();
    }
  ' "$1" "$2")
}

# restore_database BACKUP: puts BACKUP in the place of the database. The
# service must be stopped. What was there is moved aside, not deleted, and its
# path is left in $failed_copy.
failed_copy=""
restore_database() {
  local backup=$1 suffix
  failed_copy=$database_dir/hearth-deploy-failed-$stamp.db
  if ! (umask 077 && cp -- "$backup" "$DATABASE.restoring"); then
    rm -f -- "$DATABASE.restoring"
    return 1
  fi
  if [[ -e $DATABASE ]] && ! mv -- "$DATABASE" "$failed_copy"; then
    rm -f -- "$DATABASE.restoring"
    return 1
  fi
  # The write-ahead log belongs to the database just moved aside. Left next
  # to the restored file, SQLite would apply it to the wrong database.
  for suffix in -wal -shm; do
    [[ ! -e $DATABASE$suffix ]] ||
      mv -- "$DATABASE$suffix" "$failed_copy$suffix" || rm -f -- "$DATABASE$suffix"
  done
  mv -T -- "$DATABASE.restoring" "$DATABASE"
}

# After the service was stopped but "current" was not switched: starts the
# release "current" still points at.
resume_previous() {
  [[ -n $previous_name ]] || return 0
  if restart_and_check "$(release_value "$HEARTH_BASE/current/RELEASE" version)"; then
    rm -f -- "$state_dir/restart-pending"
    previous_note="Release $previous_name is running again."
  else
    previous_note="\"current\" points at release $previous_name, but $SERVICE could not be confirmed on it: $probe_reason. Check: systemctl status $SERVICE"
  fi
}

# Keeps the newest "before" copy and the newest "failed" copy of the database.
prune_database_copies() {
  local kind name
  [[ -n $database_dir ]] || return 0
  for kind in before failed; do
    find "$database_dir" -maxdepth 1 -type f -name "hearth-deploy-$kind-*.db" -printf '%f\n' 2>/dev/null |
      sort | head -n -1 | while IFS= read -r name; do
      rm -f -- "$database_dir/$name" "$database_dir/$name-wal" "$database_dir/$name-shm"
    done
  done
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
  prune_database_copies
  # Build logs: keep the newest 20.
  find "$HEARTH_BASE/logs" -maxdepth 1 -type f -name '*.log' -printf '%f\n' 2>/dev/null |
    sort | head -n -20 | while IFS= read -r name; do
    rm -f -- "$HEARTH_BASE/logs/$name"
  done
}

# ---------------------------------------------------------------------------
# Start: what every copy does, also one that only hands the run over
# ---------------------------------------------------------------------------
arguments=("$@")
self=${BASH_SOURCE[0]}
config_file=${1:-${HEARTH_DEPLOY_CONFIG:-/etc/hearth/deploy.conf}}
state_dir="" # set once the base folder is known; die() needs it only later
load_config "$config_file"
check_starter_settings
state_dir=$HEARTH_BASE/state

if [[ $EUID -eq 0 ]]; then
  die "Do not run this as root: files it creates would belong to root. Run it as the deploy user, for example: systemctl start hearth-deploy.service"
fi
for tool in git flock timeout; do
  command -v "$tool" >/dev/null 2>&1 || die "The command '$tool' is not installed or not on PATH."
done

# One run at a time. A second run leaves at once; the next timer tick retries.
# Without the base folder there is nothing to lock, and nothing to deploy
# into: the checks further down say so.
locked=no
if [[ -d $HEARTH_BASE && -w $HEARTH_BASE ]]; then
  exec 9>"$HEARTH_BASE/deploy.lock"
  if ! flock -n 9; then
    log "Another deploy is still running; leaving it to finish."
    exit 0
  fi
  locked=yes
fi

# ---------------------------------------------------------------------------
# Which copy does the work (see the top of this file)
# ---------------------------------------------------------------------------
# What the copy that started this one said, if one did. Nothing this copy
# starts needs to hear it.
handed_over=${HEARTH_DEPLOY_HANDED_OVER:-}
[[ $handed_over =~ ^[0-9a-f]{40,64}$ ]] || handed_over=""
starter_fetched=${HEARTH_DEPLOY_FETCHED:-}
unset HEARTH_DEPLOY_HANDED_OVER HEARTH_DEPLOY_FETCHED

handover_file=$state_dir/deploy-script
framework_fetch="" # "done" once this run has fetched the framework's branch;
#                    "failed" if it could not, which step 1 reports

# is_this_copy FILE: whether FILE holds the script this copy is, byte for
# byte. The installed copy is its own file. A copy that was handed over to is
# the script of the commit it was started for, and is compared as that,
# straight from the clone: its own file under state/ may have been replaced
# since it started, by a run that got in between.
is_this_copy() {
  if [[ -n $handed_over ]]; then
    git -C "$FRAMEWORK_REPO" show "$handed_over:deploy/hearth-deploy.sh" 2>/dev/null | cmp -s -- - "$1"
  else
    cmp -s -- "$self" "$1"
  fi
}

# hand_over FILE: starts the deploy script in FILE, which is the one of
# $framework_commit, in the place of this copy. It does not return.
hand_over() {
  # Renamed into place, never written over: bash reads a running script from
  # its file as it goes, and a copy that an earlier run started may still be
  # reading this one.
  mv -T -- "$1" "$handover_file" ||
    die "Could not put the deploy script of framework commit ${framework_commit:0:12} at $handover_file."
  [[ -z ${HEARTH_DEPLOY_VERBOSE:-} ]] ||
    log "Handing this run over to the deploy script of framework commit ${framework_commit:0:12} ($handover_file)."
  # Unlocked, not only closed: the lock belongs to the open file, not to this
  # process. Anything this copy started that is still running, such as a tool
  # that tidies the clone up in the background after a fetch, has that file
  # open too, and would keep the lock from the copy started now.
  flock -u 9
  exec 9>&-
  export HEARTH_DEPLOY_HANDED_OVER=$framework_commit
  [[ $framework_fetch != "done" ]] || export HEARTH_DEPLOY_FETCHED=$framework_commit
  exec "$BASH" "$handover_file" "${arguments[@]}"
}

if [[ $SELF_UPDATE == on && $locked == yes ]]; then
  command -v cmp >/dev/null 2>&1 || die "The command 'cmp' is not installed or not on PATH."
  framework_commit=$(framework_branch_commit)
  if [[ -n $framework_commit && $starter_fetched == "$framework_commit" ]]; then
    # The copy that handed this run over fetched the branch a moment ago.
    framework_fetch="done"
  elif try_fetch "$FRAMEWORK_REPO" "framework repository"; then
    framework_fetch="done"
    framework_commit=$fetched_commit
  else
    # Not the end of the run: finishing a restart that is still pending needs
    # no network. This run goes by the commit that was fetched last, if there
    # is one, and step 1 says what try_fetch left.
    framework_fetch=failed
  fi

  # A copy that was handed over to for this very commit is its script, on the
  # word of the copy that started it. It does not look again, whatever a
  # comparison would say, so that no two copies can hand a run to and fro.
  if [[ -n $framework_commit && $framework_commit != "$handed_over" ]]; then
    candidate=$handover_file.new
    if read_deploy_script "$framework_commit" "$candidate" && ! is_this_copy "$candidate"; then
      if script_problem_lines=$("$BASH" -n "$candidate" 2>&1); then
        hand_over "$candidate"
      else
        script_problem="bash cannot parse it"
        script_problem_lines=${script_problem_lines//"$candidate"/deploy/hearth-deploy.sh}
      fi
    fi
    # Not worth the run if it cannot be removed: read_deploy_script clears
    # the name before it writes there again.
    rm -f -- "$candidate" || true
  fi
fi

# ---------------------------------------------------------------------------
# From here on this copy does the work
# ---------------------------------------------------------------------------
# The file this copy was started as, for the note at the end of a deploy
# with SELF_UPDATE=off. Worked out here, while a name that was given
# relative to the folder the run was started in still leads to it.
installed_script=$(command -v -- "$0" 2>/dev/null || printf '%s' "$0")
[[ $installed_script == /* ]] || installed_script=$PWD/$installed_script

# The timer starts a run in /. A run by hand starts in the folder of whoever
# starts it, which this user may not be allowed to enter: sudo -u keeps the
# folder, and a home folder is closed to others. find then ends with an
# error although it found everything, and a deploy that went well would end
# with the warning that old releases could not be removed. So the work is
# done from /, as the timer's is. Not before this point: a copy that is
# handed a run reads the starter's arguments, the config file among them,
# from the folder the starter was started in.
cd /

# Until the checks below are through, a copy that could not hand the run
# over says so before what stops it (see die): the config file, a value or a
# missing tool may all be right for the deploy script it could not start.
explain_this_copy=yes
if [[ -n $config_problem ]]; then
  # Without the base folder there was no lock, and so no newer deploy script
  # that this run could have been handed to. The config file may be right
  # for one: the folder is what is wrong for certain, and is said first. The
  # line is said with it, since it may be the reason: HEARTH_BASE under a
  # name with a letter too many leaves the base folder at its default.
  [[ $locked == yes ]] ||
    die "$HEARTH_BASE does not exist or this user cannot write to it. Also: $config_problem"
  die "$config_problem"
fi
check_settings
for tool in node pnpm tar; do
  command -v "$tool" >/dev/null 2>&1 || die "The command '$tool' is not installed or not on PATH."
done
[[ -z $SERVICE ]] || command -v systemctl >/dev/null 2>&1 || die "systemctl is not on PATH."
[[ $locked == yes ]] || die "$HEARTH_BASE does not exist or this user cannot write to it."

mkdir -p -- "$HEARTH_BASE/releases" "$HEARTH_BASE/logs" "$state_dir"

# The database, if there is one yet. The first deployment creates it.
database_dir=""
if [[ -n $DATABASE && -f $DATABASE ]]; then
  database_dir=$(dirname -- "$DATABASE")
  [[ -r $DATABASE && -w $database_dir ]] ||
    die "This user cannot read $DATABASE or cannot write to $database_dir, so the database cannot be copied before a switch. Fix the permissions, or set DATABASE to nothing to deploy without that safety net."
fi
explain_this_copy=no

# Leftovers of a run that was cut short (power loss): folders with no RELEASE.
current_name=$(current_release_name)
for dir in "$HEARTH_BASE"/releases/*/; do
  name=$(basename -- "$dir")
  if [[ -d $dir ]] && is_release_name "$name" && [[ $name != "$current_name" && ! -e $dir/RELEASE ]]; then
    log "Removing the unfinished release $name left by an interrupted run."
    rm -rf -- "${dir%/}"
  fi
done
if [[ -n $database_dir ]]; then
  rm -f -- "$database_dir"/hearth-deploy-trial-*.db "$database_dir"/hearth-deploy-trial-*.db-wal \
    "$database_dir"/hearth-deploy-trial-*.db-shm "$DATABASE.restoring"
fi

# A run that switched "current" but could not confirm the restart leaves a
# note. Finish that job first. If it cannot be finished, carry on all the
# same: a newer commit may be the fix, and it must not wait for a person.
pending_failure=""
if [[ -n $SERVICE && -e $state_dir/restart-pending && -n $current_name ]]; then
  pending_version=$(release_value "$HEARTH_BASE/current/RELEASE" version)
  pending_tries=$(<"$state_dir/restart-pending")
  [[ $pending_tries =~ ^[0-9]{1,3}$ ]] || pending_tries=0
  if probe_reason=$(probe "$LIVE_URL" "$pending_version" api 2>&1); then
    # It is running after all. Restarting it again would only interrupt it.
    rm -f -- "$state_dir/restart-pending"
    log "$SERVICE runs release $current_name (version $pending_version); an earlier run could not confirm that."
  elif ((pending_tries >= RESTART_TRIES)); then
    pending_failure="$probe_reason; it was restarted $pending_tries times without success and is not restarted again"
  else
    log "An earlier run switched to release $current_name but could not confirm the restart. Trying again."
    printf '%s\n' "$((pending_tries + 1))" >"$state_dir/restart-pending"
    if restart_and_check "$pending_version"; then
      rm -f -- "$state_dir/restart-pending"
      log "$SERVICE now runs release $current_name (version $pending_version)."
    else
      pending_failure=$probe_reason
    fi
  fi
fi

# Says what is wrong with the release "current" points at, and stops.
die_pending() {
  previous_note="\"current\" points at $current_name, but $SERVICE is not running it. Check: systemctl status $SERVICE"
  die "$SERVICE did not come up on release $current_name: $pending_failure."
}

# ---------------------------------------------------------------------------
# 1. Fetch, and decide whether there is anything to do
# ---------------------------------------------------------------------------
if [[ $framework_fetch == failed ]]; then
  # The fetch before the hand-over. Said only now, because what came before
  # needed no network.
  fetch_failed
elif [[ $framework_fetch != "done" ]]; then
  try_fetch "$FRAMEWORK_REPO" "framework repository" || fetch_failed
  framework_commit=$fetched_commit
fi
apps_commit=none
if [[ -n $APPS_REPO ]]; then
  try_fetch "$APPS_REPO" "mini-apps repository" || fetch_failed
  apps_commit=$fetched_commit
fi

deployed_framework=$(release_value "$HEARTH_BASE/current/RELEASE" framework)
deployed_apps=$(release_value "$HEARTH_BASE/current/RELEASE" apps)
if [[ $framework_commit == "$deployed_framework" && $apps_commit == "$deployed_apps" ]]; then
  [[ -z $pending_failure ]] || die_pending
  [[ -z ${HEARTH_DEPLOY_VERBOSE:-} ]] || log "Nothing new: $BRANCH is already deployed."
  exit 0
fi

wanted="$framework_commit $apps_commit"
failed_file=$state_dir/failed
if [[ -e $failed_file ]]; then
  failed_stage="" failed_key=""
  read -r failed_stage failed_key <"$failed_file" || true
  if [[ $failed_stage != build && $failed_stage != sdk && $failed_stage != live ]]; then
    # Written by an earlier version of this script: the commits only.
    failed_key="$failed_stage $failed_key"
    failed_stage=build
  fi
  retry_note=""
  if [[ $failed_key == "$wanted" && $failed_stage == live ]]; then
    # Trying again would stop the running service again, for the same result.
    retry_note="They built, but did not come up as the live service, so they are not tried again by themselves. Push a new commit, or delete $failed_file to try these once more."
  elif [[ $failed_key == "$wanted" && $failed_stage == sdk ]]; then
    retry_note="The mini-apps were written for another version of the SDK than the framework holds, which building them again cannot change. The next commit of either repository is built at once."
  elif [[ $failed_key == "$wanted" && -z $(find "$failed_file" -mmin "+$RETRY_AFTER_MINUTES" 2>/dev/null) ]]; then
    retry_note="Trying again $RETRY_AFTER_MINUTES minutes after that attempt, or at once after a new commit, or after deleting $failed_file."
  fi
  if [[ -n $retry_note ]]; then
    log "ERROR: the newest commits (framework ${framework_commit:0:12}, mini-apps ${apps_commit:0:12}) failed to deploy earlier. $retry_note" >&2
    [[ -z $pending_failure ]] || die_pending
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# 2. Build a fresh release
# ---------------------------------------------------------------------------
version=$(git -C "$FRAMEWORK_REPO" rev-parse --short "$framework_commit")
stamp=$(date -u +%Y%m%dT%H%M%SZ)
previous_name=$current_name
if [[ -n $pending_failure ]]; then
  log "ERROR: $SERVICE did not come up on release $current_name: $pending_failure. Trying the newer commits instead." >&2
  previous_note="\"current\" still points at release $previous_name, which $SERVICE is not running. Check: systemctl status $SERVICE"
elif [[ -n $previous_name ]]; then
  previous_note="Release $previous_name is still the one in use."
else
  previous_note="There is no earlier release; nothing is running yet."
fi

attempt_key=$wanted
if [[ -n $script_problem ]]; then
  # Found before the hand-over, and said here so that it counts as a build
  # that failed: tried again after a while, not on every run.
  [[ -z $script_problem_lines ]] || printf '%s\n' "$script_problem_lines" | sed 's/^/    /' >&2
  die "The newest commits (framework ${framework_commit:0:12}, mini-apps ${apps_commit:0:12}) are not deployed: the deploy script of that framework commit cannot carry out the run, because $script_problem. $script_remedy; or deploy them with the installed copy of the script, which may be much older than they are: read \"When a deployment fails\" in docs/self-hosting.md before you set SELF_UPDATE=off in $config_file."
fi
new_release=$HEARTH_BASE/releases/$stamp
build_log=$HEARTH_BASE/logs/$stamp.log
[[ ! -e $new_release ]] || die "The folder $new_release already exists."
mkdir -- "$new_release"
: >"$build_log"

log "New commits: framework ${framework_commit:0:12}, mini-apps ${apps_commit:0:12}. Building release $stamp (version $version)."
[[ -z $handed_over ]] ||
  log "This run is carried out by the deploy script of framework commit ${handed_over:0:12}."

export_commit "$FRAMEWORK_REPO" "$framework_commit" "$new_release/hearth" >>"$build_log" 2>&1 ||
  die "Could not copy the framework's files into the release."
# The mini-apps lie beside the framework, as hearth-stones does beside hearth
# on a developer's machine: they link the SDK as ../hearth/packages/sdk.
apps_dir=""
if [[ -n $APPS_REPO ]]; then
  apps_dir=$new_release/hearth-stones
  export_commit "$APPS_REPO" "$apps_commit" "$apps_dir" >>"$build_log" 2>&1 ||
    die "Could not copy the mini-apps' files into the release."
fi

log "Installing dependencies (pnpm install --frozen-lockfile)."
(cd -- "$new_release/hearth" &&
  clean_env pnpm install --frozen-lockfile --store-dir "$HEARTH_BASE/pnpm-store") >>"$build_log" 2>&1 ||
  die "pnpm install failed."

# The mini-apps install nothing but that link, so their install needs no
# network, and --offline makes sure it uses none. A mini-apps repository
# without a package.json holds no apps yet, and has nothing to install.
# See docs/mini-app-contract.md, section A7, "SDK only".
if [[ -n $apps_dir && -f $apps_dir/package.json ]]; then
  log "Linking the mini-apps to the release's SDK (pnpm install --frozen-lockfile --offline)."
  (cd -- "$apps_dir" &&
    clean_env pnpm install --frozen-lockfile --offline --store-dir "$HEARTH_BASE/pnpm-store") >>"$build_log" 2>&1 ||
    die "Could not link the mini-apps to the SDK (pnpm install --frozen-lockfile --offline in hearth-stones). Their pnpm-lock.yaml must be up to date and hold nothing but the link to ../hearth/packages/sdk; see the lines below."
fi

# Which mini-apps a release holds is decided now: pnpm build first runs
# hearth-apps sync, which reads HEARTH_APPS_DIR. The running server reads no
# apps folder. Without APPS_REPO the release holds no mini-apps.
build_env=(HEARTH_VERSION="$version")
[[ -z $apps_dir ]] || build_env+=(HEARTH_APPS_DIR="$apps_dir")
log "Building (pnpm build)."
build_status=0
(cd -- "$new_release/hearth" && clean_env "${build_env[@]}" pnpm build) >>"$build_log" 2>&1 ||
  build_status=$?
if ((build_status == 3)); then
  # hearth-apps sync ends with status 3 for one thing only, and pnpm passes
  # it on: mini-apps written for another version of the SDK than this one.
  attempt_stage=sdk
  die "The mini-apps (commit ${apps_commit:0:12}) were written for another version of the SDK than the framework (commit ${framework_commit:0:12}) holds; the lines below name both. This is expected between merging a new SDK version into one repository and the matching change into the other. These commits are not built again: the next commit of either repository is built at once."
fi
((build_status == 0)) || die "pnpm build failed."

# hearth-apps sync names what the build holds: "this build holds 2 mini-apps
# (grocery, notes)." or "this build holds no mini-apps."
holds=$(sed -n 's/^hearth-apps sync: this build holds //p' -- "$build_log" | tail -n 1)
[[ -z $holds ]] || log "The build holds $holds"

server_dir=$new_release/hearth/packages/server
[[ -f $server_dir/dist/main.js ]] || die "The build did not produce packages/server/dist/main.js."
[[ -f $new_release/hearth/packages/web/dist/index.html ]] || die "The build did not produce packages/web/dist/index.html."

# ---------------------------------------------------------------------------
# 3. Start the new build on a spare port and check it
# ---------------------------------------------------------------------------
# It runs with made-up settings, so it does not touch the secrets file, and
# against a fresh copy of the database, so its migrations meet the real rows
# without changing them. Sign-in stays on, so it would let nobody in even if
# something could reach it. Its mini-apps' jobs are switched off
# (HEARTH_JOBS=off), so a release on trial fetches nothing from outside.
log "Checking the new build on port $HEALTH_PORT."
if port_in_use "$HEALTH_PORT"; then
  die "Port $HEALTH_PORT is already in use, so the new build cannot be checked there. Free it or change HEALTH_PORT."
fi
trial_database=":memory:"
if [[ -n $database_dir ]]; then
  trial_db=$database_dir/hearth-deploy-trial-$stamp.db
  snapshot_database "$DATABASE" "$trial_db" >>"$build_log" 2>&1 ||
    die "Could not copy the database $DATABASE for the trial start."
  trial_database=$trial_db
elif [[ -n $DATABASE ]]; then
  log "There is no database at $DATABASE yet, so the new build is checked with an empty one."
else
  log "DATABASE is not set: the new build is checked with an empty database, and a failed switch cannot put the database back."
fi
(cd -- "$server_dir" && umask 077 && exec env -i PATH="$PATH" NODE_ENV=production \
  HOST=127.0.0.1 PORT="$HEALTH_PORT" HEARTH_DB="$trial_database" \
  HEARTH_AUTH=cloudflare-access HEARTH_CF_TEAM_DOMAIN=health-check.example.com \
  HEARTH_CF_AUDIENCE=health-check HEARTH_OWNER_EMAIL=health-check@example.com \
  HEARTH_JOBS=off HEARTH_VERSION="$version" node dist/main.js) >>"$build_log" 2>&1 9>&- &
health_pid=$!
if ! wait_healthy "http://127.0.0.1:$HEALTH_PORT" "$version" page "$health_pid"; then
  if [[ -n $trial_db ]]; then
    die "The new build failed its check on port $HEALTH_PORT, running against a copy of the database: $probe_reason."
  fi
  die "The new build failed its check on port $HEALTH_PORT: $probe_reason."
fi
stop_health_server
remove_trial_database
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
backup_file=""
if [[ -n $SERVICE ]]; then
  : >"$state_dir/restart-pending"
  if [[ -n $database_dir ]]; then
    # Stopped first, so the copy holds every change the old release made and
    # going back loses nothing of them.
    log "Stopping $SERVICE for a moment to copy the database before the switch."
    service_command stop ||
      die "systemctl could not stop $SERVICE (may this user stop it? see docs/self-hosting.md)."
    # From here on a failure has interrupted the site, so it is not retried on a timer.
    attempt_stage=live
    backup_file=$database_dir/hearth-deploy-before-$stamp.db
    if ! snapshot_database "$DATABASE" "$backup_file" >>"$build_log" 2>&1; then
      rm -f -- "$backup_file"
      resume_previous
      die "Could not copy the database $DATABASE before the switch."
    fi
  fi
fi
if ! point_current "$stamp"; then
  [[ -z $backup_file ]] || resume_previous
  die "Could not point \"current\" at the new release."
fi
activated=yes
attempt_stage=live
build_log="" # from here on a failure is not about the build

if [[ -z $SERVICE ]]; then
  log "SERVICE is empty, so nothing was restarted."
elif restart_and_check "$version"; then
  rm -f -- "$state_dir/restart-pending"
elif [[ -n $previous_name ]]; then
  failure=$probe_reason
  log "ERROR: $SERVICE did not come up on release $stamp: $failure. Going back to release $previous_name." >&2
  # The failed release may have migrated the database, and the previous
  # release refuses a database with a migration it does not know.
  database_note=""
  if [[ -n $backup_file ]]; then
    if service_command stop && restore_database "$backup_file"; then
      database_note=" The database is as it was just before the switch; what release $stamp left is kept in $failed_copy."
    else
      database_note=" The database could NOT be put back. If release $previous_name refuses it, stop $SERVICE and copy $backup_file over $DATABASE by hand; see docs/self-hosting.md."
    fi
  elif [[ -z $DATABASE ]]; then
    database_note=" The database was not put back, because DATABASE is not set. If release $previous_name refuses it, see docs/self-hosting.md."
  fi
  point_current "$previous_name"
  activated=no
  previous_version=$(release_value "$HEARTH_BASE/current/RELEASE" version)
  if restart_and_check "$previous_version"; then
    rm -f -- "$state_dir/restart-pending"
    previous_note="Release $previous_name is running again.$database_note"
  else
    previous_note="\"current\" points at release $previous_name again, but $SERVICE could not be confirmed on it: $probe_reason.$database_note Check: systemctl status $SERVICE"
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

# With SELF_UPDATE on, the release was deployed by its own deploy script,
# whatever the installed copy holds. With it off, the installed copy has just
# deployed a release whose own script it never looked at, and "off" is also
# the way to deploy a commit whose script is broken: installed, a script
# that is empty or not parsed would end every run from then on. So the note
# asks for an install only of a script that a hand-over would have started.
# Every check is the condition of an "if": nothing here may fail a deploy
# that went well.
if [[ $SELF_UPDATE == off ]]; then
  release_script=$new_release/hearth/deploy/hearth-deploy.sh
  if [[ -L $release_script || ! -f $release_script || ! -s $release_script ]] ||
    ! "$BASH" -n "$release_script" >/dev/null 2>&1; then
    log "NOTE: deploy/hearth-deploy.sh in this release is missing, empty, not a regular file or not parsed by bash. Do NOT install it: keep the installed copy ($installed_script). See \"When a deployment fails\" in docs/self-hosting.md."
  elif ! cmp -s -- "$installed_script" "$release_script"; then
    log "NOTE: deploy/hearth-deploy.sh in this release differs from the installed copy ($installed_script). Install the new one when convenient; see docs/self-hosting.md."
  fi
fi
exit 0
