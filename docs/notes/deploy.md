# Notes: the deploy script

`deploy/hearth-deploy.sh` and its tests. The script on `main` is live code on the server: read all of this before changing a line of it.

Notes for whoever changes this part, people and agents alike. They are read when needed, not at the start of every session: add what you learn as one line, and correct a note in the change that makes it untrue.

- The deploy script stops the service for a moment at each switch to copy the
  database, and puts that copy back if the new release does not come up. A
  migration must therefore work on a copy of the real data in the trial start.
- `deploy/hearth-deploy.sh` on `main` is live code: a server runs it at its
  next run, about a minute after the merge, to deploy the very commit that
  brought it. The copy installed there (`/usr/local/bin/hearth-deploy`,
  root's) is only a starter, which no push ever updates: it fetches the
  framework, and when the newest commit's script differs from itself, byte
  for byte, and `bash -n` takes it, it writes it to `state/deploy-script`,
  gives up the lock and starts it in its own place (`SELF_UPDATE=off` in
  `deploy.conf` switches this off). What a starter counts on must therefore
  never change, in any later version of the script: the script is the
  regular file `deploy/hearth-deploy.sh` of the framework repository; it
  does a run when started as `bash <file> <the starter's arguments>` (the
  config file, if one was given), holding no lock, with
  `HEARTH_DEPLOY_HANDED_OVER=<the commit whose script it is>` in its
  environment and, when the starter has just fetched the framework's
  branch, `HEARTH_DEPLOY_FETCHED=<that commit>`; the lock is a flock on
  `$HEARTH_BASE/deploy.lock`; the five settings a starter reads
  (`HEARTH_BASE`, `FRAMEWORK_REPO`, `REMOTE`, `BRANCH`, `SELF_UPDATE`) keep
  their names, meanings and defaults, in a config file of `NAME=value`
  lines found as today; and `state/deploy-script` and
  `state/deploy-script.new` are the starter's to write (whatever lies at
  the second, a link or a folder too, is removed before it is written, and
  so is a folder at the first).
  That is all a hand-over needs. But an installed copy that cannot hand a
  run over does that run's work itself, by what it knew on the day it was
  installed.
  There are two such runs: the newest commit's script is missing, empty,
  not a regular file or not parsed, or could not be copied under `state/`
  (the work as far as the build); and the copy knows no commit of the
  framework, because the clone cannot be read (`FRAMEWORK_REPO` names none,
  or one git refuses the deploy user) or the branch was never fetched and
  the fetch fails (the work as far as step 1, which reports the fetch).
  So these may not change either, except in a way the oldest installed copy
  gets right: a release is `releases/<time>` and a finished one holds
  `RELEASE` with `framework=`, `apps=` and `version=` (such a copy deletes
  every folder named like a release that has no `RELEASE` and is not
  `current`); `current` is a link to a release; `state/restart-pending`
  makes it restart `SERVICE` until `/api/health` at `LIVE_URL` reports that
  version; `state/failed` is one line, `<stage> <framework commit> <apps
  commit>`; and it deletes `hearth-deploy-trial-*.db` and
  `DATABASE.restoring` beside the database. It stops before any of that on
  a setting it does not know or a value it refuses, so adding a setting is
  safe, and giving an old file or folder a new meaning is not. Everything
  else may change. Both lists are at the top of the script: keep them
  alike.
- In the deploy script, everything above "From here on this copy does the
  work" also runs in a copy that only hands the run over, which may be much
  older than the config file and than the script it starts. So nothing
  there may stop on what only the work needs: a line of the config file
  that the copy cannot read, or a setting it does not know, is remembered
  (`config_problem`) for the copy that does the work to stop on; only
  `check_starter_settings` runs there; and the tools, folders and database
  that the work needs are looked at below that line. One kind of line
  stops a starter at once, in `load_config`: one it cannot read that begins
  with the name of one of its own five settings, in any mix of capitals,
  with a hyphen or after the word "export" ("Branch=stable",
  "SELF-UPDATE=off", "BRANCH stable", "export BRANCH=stable"), which no
  later script can mean anything by, and which would otherwise leave the
  starter going by the default. A name it can read and does not know
  (`SELF_UPDATES`) is still only remembered, and said after "Also:" with
  the error when one of the five is then wrong (`starter_setting`) or the
  base folder cannot be used: `HEARTH_BASES=...` leaves the base folder at
  its default. A new setting goes
  into `check_settings`, never among the starter's five. Nor may anything
  there read or change the server's state (the releases, `state/failed`, a
  pending restart): the root refusal, the lock, the fetch of the framework
  and `state/deploy-script` are all there is. Nor may it change folder: a
  copy that is handed a run reads the starter's arguments, a config file
  named relative to the caller's folder among them, where the starter was
  started; a test hands a run over with a config file named that way. A
  change above that line reaches no server by being merged: with the
  hand-over on, the lock, the fetch and the decision to hand over are the
  installed copy's, which no push updates, and nothing tells the owner that
  it is behind (the note that a release's script differs is written only
  with `SELF_UPDATE=off`). Say so in the pull request, and add to
  `docs/self-hosting.md` that the installed copy must be installed again
  for it, with the reason. The copy that does the work begins with `cd /`,
  as the timer
  starts every run: a run by hand (`sudo -u hearth hearth-deploy`) keeps
  the caller's folder, which the deploy user may not be allowed to enter,
  and `find` then ends with an error although it found everything, so
  that a deploy that went well ended with a warning. So nothing below that
  line may read a path the caller gave relative to its folder; the copy's
  own file is worked out just before (`installed_script`).
- The installed copy knows itself by its own file. A copy that was handed
  a run knows itself by commit: it is the script of the commit in
  `HEARTH_DEPLOY_HANDED_OVER`, on the starter's word. With its branch at
  that commit it compares nothing and does the work, which is what keeps
  two copies from handing a run to and fro; if the branch has moved on
  meanwhile, it compares the two commits' scripts, both read from the
  clone, never its own file, which a run that got in between may have
  replaced (by rename: a running copy goes on reading the old one). A
  commit whose deploy script is missing, empty, not a regular file or not
  parsed is not deployed while `SELF_UPDATE` is on: the copy that found out
  goes on, clears leftovers away, finishes a pending restart, and stops
  where the build would start, so that `state/failed` holds it like any
  failed build. If that copy stops earlier, on the config file, a value, a
  tool or the database (the checks between "From here on" and the
  leftovers, while `explain_this_copy` is yes), `die` first says why it is
  the copy doing the work (`say_script_problem`: what bash said, the NOTE,
  what to do), because what stopped it may be right for the script it
  could not start; nothing is recorded then, and it is said at every run.
  A framework fetch that fails before the hand-over is remembered
  (`framework_fetch`) and reported in step 1, after the leftovers and a
  pending restart, with what git said (also of a clone it cannot use, such
  as one that belongs to another user: "git cannot use ..."), and the run
  goes by the commit fetched last. A pending
  restart therefore waits for that fetch to fail, up to its limit of two
  minutes from a remote that does not answer, and for two such fetches
  when the run is handed over, since the copy that takes over is not told
  of a fetch that failed and tries again; with `SELF_UPDATE=off` nothing is
  fetched before the restart, which a test holds it to. A script that
  parses is handed every run while its commit is the newest, whatever it
  then does: if it fails or does nothing, no run does anything, a pending
  restart and newer mini-apps included, and one that ends with status 0
  says nothing. `SELF_UPDATE=off` is the way out then, once the script of
  the running release is installed in the old copy's place (of the release
  before it, when the faulty script deployed its own commit before its
  fault showed); so is the next commit whose script works. With
  `SELF_UPDATE=off` the installed copy says after a deploy when the
  release's script differs from it, and says instead that it must not be
  installed when it is missing, empty, not a regular file or not parsed:
  "off" is also how a commit with such a script gets deployed, and
  installed it would end every run. Each of those checks is the condition
  of an `if`, since nothing after "is live" may fail a deploy that went
  well. A script that parses and does not work it cannot tell from a good
  one; the guide warns of that. An unexpected error names the file with the
  line, since after a hand-over the copy that speaks is
  `state/deploy-script`.
- The deploy tests run the real `hearth-apps sync`: each made-up framework
  commit in `deploy/tests/deploy.test.sh` carries a copy of
  `packages/sdk/bin` and `packages/sdk/tools/*.mjs` with an SDK version of
  its own, and the pnpm stand-in's `build` runs it. In the mini-apps folder
  the stand-in makes the links a `link:` dependency asks for, as pnpm does.
  The made-up server writes each start into `started-with` beside it, the
  trial's or the service's, with the `HEARTH_JOBS` it was given.
- Every made-up framework commit of the deploy tests also carries the
  deploy script under test (`commit_files`), so no run is handed over
  unless a test gives a commit another script. `newer_script` writes that
  other one: the script under test with one line added, which notes in
  `started.log` how it was started (its arguments, the two variables,
  whether the lock was free). It stands for the newer script of a later
  commit, and the script under test for the copy installed before it;
  `started_as` is the line a correct hand-over leaves. The pnpm stand-in
  notes which copy asked and whether the lock was held (`pnpm-by.log`,
  `pnpm_askers`). The git stand-in keeps the remote's branch (`main`)
  apart from what the last fetch brought (`fetched`), answers `ls-tree` and
  `show`, says of a folder without commits what git says of one that is no
  repository, and through files in the test folder makes a fetch fail (in the
  words `fetch-fails` holds, if it holds any), leave a process behind or
  run something in its middle, and `show` stop short or give another text
  each time; it writes down every call that finds
  `HEARTH_DEPLOY_HANDED_OVER` or `HEARTH_DEPLOY_FETCHED` in its environment
  (`git-told.log`), which no call may. The last test runs the script with
  the real git on a repository it makes up, so the git commands the script
  uses must work there as well as in the stand-in. The refusal to run as
  root is tried as a user who is root in the script's eyes only, in one of
  two ways: a user namespace (`unshare --map-root-user`), which Ubuntu
  24.04 keeps from ordinary users unless a kernel setting is switched off
  (`ci.yml` does not switch it off), or else `fakeroot`, which the list of
  packages of GitHub's `ubuntu-24.04` image names. The tests never run
  anything as the real root. Where neither works the test is skipped with
  a line that says so, and where `CI` is set a skipped test fails the
  whole run at its end (an error on the run's page under GitHub Actions):
  a test nobody runs holds the script to nothing. The same holds for the
  whole file: started as root it runs itself as another user with
  `setpriv`, and where that is missing it skips every test, which fails at
  once where `CI` is set. On GitHub's `ubuntu-24.04` runner the test runs:
  the first CI run with this rule passed with nothing skipped (its log does
  not say which of the two ways it took). If the `check` job ever fails on
  the skip, add `fakeroot` or the kernel setting there, never a way around
  the test. What a starter must do without is tested by taking it away: a
  `PATH` of links that leaves out node, pnpm, tar and systemctl
  (`starter-bin`), the folder for the build logs removed, a database
  nobody may read, and another `bash` first on `PATH` that writes down
  what it is asked to run. `run` is a run that
  builds nothing, and
  `deploy` waits a second first, because releases are named after the
  second.
- `APPS_REPO` names one clone of mini-apps or several separated by colons. A release holds them as `hearth-stones`, `hearth-stones-2`, ... in that order, and `apps=` in `RELEASE` (so the key in `state/failed` too) is their commits joined by "+": with one repository it is the bare commit it always was, which is why nothing changed for a server that names one. Adding or taking out a repository changes that key, so it is built at once. An installed copy from before this that must do the work itself takes the line for one clone and stops at its fetch ("git cannot use"), after the leftovers and a pending restart.
