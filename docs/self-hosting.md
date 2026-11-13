# Running Hearth on your own server

This guide sets up one Linux server with no public ports. Cloudflare Tunnel
carries traffic to it and Cloudflare Access decides who gets in.

**Tested on one real server so far.** The steps below have been run end to
end once, with the releases up to the grocery list. Scheduled jobs and what
they fetch from outside (GitHub Trending) came later, and so did the deploy
script's handing each run over to the newest copy of itself (step 5):
neither has run on a real server yet. Expect details to differ on yours,
and correct them here.

Everything personal (your domain, email address, secrets) stays on the server
and never goes into a repository.

## 1. Install the tools

- Node.js 22 or newer, and pnpm 10 (`corepack enable` provides pnpm).
- `git`, `tar`, `curl`, and `flock`, `timeout` and `cmp` (in `util-linux`,
  `coreutils` and `diffutils` on most systems).
- `cloudflared`, Cloudflare's tunnel program.

## 2. Create the user and folders

```sh
sudo useradd --system --create-home --home-dir /opt/hearth --shell /usr/sbin/nologin hearth
sudo mkdir -p /opt/hearth/repos /var/lib/hearth /etc/hearth
sudo chown -R hearth:hearth /opt/hearth /var/lib/hearth
sudo chmod 700 /var/lib/hearth
```

`/var/lib/hearth` holds the database, so only the `hearth` user may look
inside it. The service also creates its files there readable by that user
only (`UMask=0077` in `hearth.service`).

## 3. Check out the repositories side by side

```sh
sudo -u hearth git clone https://github.com/YOUR-ORG/hearth.git /opt/hearth/repos/hearth
sudo -u hearth git clone https://github.com/YOUR-ORG/hearth-stones.git /opt/hearth/repos/hearth-stones
```

`hearth-data` is private and is only needed once notes exist; it will need a
deploy key with write access.

Which mini-apps a release holds is decided when the release is built: the
deploy script copies `main` of `hearth-stones` (`APPS_REPO` in
`deploy.conf`) into the release beside the framework, links it to that
release's SDK with `pnpm install --offline` (its lockfile holds nothing but
that link, so nothing is downloaded) and builds the two together. There is
no setting for it in `hearth.env`: an older one may still have a
`HEARTH_APPS_DIR` line, which the server ignores and you can delete. With
`APPS_REPO` empty, releases hold no mini-apps: they disappear from the site,
and their data stays in the database until they come back.

## 4. Write the settings

```sh
sudo cp /opt/hearth/repos/hearth/deploy/hearth.env.example /etc/hearth/hearth.env
sudo cp /opt/hearth/repos/hearth/deploy/deploy.conf.example /etc/hearth/deploy.conf
sudo chown root:hearth /etc/hearth/hearth.env && sudo chmod 640 /etc/hearth/hearth.env
```

Edit `/etc/hearth/hearth.env`: your email address as owner, and the two
Cloudflare values from step 6. Leave `HEARTH_AUTH=cloudflare-access` as it
is: `dev` signs nobody in and is for a developer's own machine only.

The mini-apps' jobs run in the server (GitHub Trending's hourly searches of
`api.github.com`), and they are what connects to outside hosts; see "What
the server connects to" below. `HEARTH_JOBS=off` in
`hearth.env` stops every job, and with it every such connection: the apps
show what their last runs left.
Never set `HEARTH_FETCH_STANDINS` on a server: it answers every job from a
file of made-up answers, for end-to-end tests, and the server refuses it
unless sign-in is switched off.

`/etc/hearth/deploy.conf` works as it is for the layout in this guide. If you
move the database (`HEARTH_DB` in `hearth.env`), give `DATABASE` in
`deploy.conf` the same path: the deploy script copies that file before every
switch.

## 5. Install the service and the deploy timer

```sh
cd /opt/hearth/repos/hearth/deploy
sudo install -m 755 hearth-deploy.sh /usr/local/bin/hearth-deploy
sudo cp systemd/hearth.service systemd/hearth-deploy.service systemd/hearth-deploy.timer /etc/systemd/system/
sudo cp polkit/50-hearth-deploy.rules /etc/polkit-1/rules.d/
sudo systemctl daemon-reload
sudo systemctl enable hearth.service
```

The polkit rule lets the `hearth` user restart and stop `hearth.service` and
nothing else, so deployments need no root access. The deploy script restarts
the service to switch releases, and stops it for the moment it copies the
database or puts it back.

The deploy script keeps itself up to date. The copy you installed only
starts each run: it fetches `main` of the framework, and when that commit's
`deploy/hearth-deploy.sh` differs from itself, it hands the whole run over
to it. So every release is built, tried and switched to by its own deploy
script, also the release that brings a newer one, and
`/usr/local/bin/hearth-deploy` never needs installing again, unless a later
version of this guide asks for it: what the installed copy does before it
hands a run over is the one part of the script that no push reaches. The
newer script is kept in `/opt/hearth/state/deploy-script` and runs as the
`hearth` user, as the code of that commit does in every build, so this
gives it no right it did not have.

A hand-over itself writes nothing in the journal. A run that was handed
over and builds a release says so ("This run is carried out by the deploy
script of framework commit ..."). A run that the installed copy does itself
says nothing of it, and neither does a run that finds nothing new or stops
on an error before the build. The installed copy does a run itself while
the newest commit's script is the same as it: that is so from the day you
install it until a commit next changes the script, so do not look for that
line as proof right after installing. Two things follow. In a line such as
"An unexpected error occurred on line 752 of
/opt/hearth/state/deploy-script", the line number is a line of the file it
names, not of `/usr/local/bin/hearth-deploy`. And a change you make to the
installed copy on the server has no effect while `main` holds another
script: every run is handed to that one. To see a hand-over happen without
waiting for a release, start one run by hand with `HEARTH_DEPLOY_VERBOSE`
set; it is a run like any other, and deploys what is new:

```sh
sudo -u hearth env HEARTH_DEPLOY_VERBOSE=1 /usr/local/bin/hearth-deploy /etc/hearth/deploy.conf
```

A copy that was installed before the script could do this has to be
replaced by hand, one last time. You have such a copy if
`grep -c SELF_UPDATE /usr/local/bin/hearth-deploy` prints 0; its runs say
after each switch that "deploy/hearth-deploy.sh in this release differs
from the installed copy". Install the new one from the release that is
running, not from the checkout of step 3: the deploy only fetches into
`/opt/hearth/repos/hearth`, so the files there stay as they were when you
cloned it, and the `install` line above would put the old copy back. Keep
the old copy, look at the new one, install it, and check:

```sh
sudo cp -p /usr/local/bin/hearth-deploy /usr/local/bin/hearth-deploy.old
sudo -u hearth bash -n /opt/hearth/current/hearth/deploy/hearth-deploy.sh
sudo install -m 755 /opt/hearth/current/hearth/deploy/hearth-deploy.sh /usr/local/bin/hearth-deploy
grep -c SELF_UPDATE /usr/local/bin/hearth-deploy
```

The second line is bash reading the script without running it. It must say
nothing: what it says is an error in a script that must not be installed.
The last line must now print a number above 0. If it still prints 0, the
release that is running does not hold the new script yet, because it is not
deployed or its deploy failed (look at the journal), and you have installed
the old script again, which changes nothing: install once more when that
release runs. The hand-over has not run on a real server yet (see the top
of this guide). Should the new copy misbehave on yours, this puts the old
one back; take a `SELF_UPDATE` line out of `deploy.conf` with it, since the
old copy stops on one:

```sh
sudo install -m 755 /usr/local/bin/hearth-deploy.old /usr/local/bin/hearth-deploy
```

Until the new copy is installed, a copy from before mini-apps were built in
keeps building every release without them, and a copy from before jobs
existed starts the trial of a new release with its jobs on, so that for the
seconds the trial lasts they run against the copy of the database and may
fetch from outside.

`SELF_UPDATE=off` in `/etc/hearth/deploy.conf` switches the hand-over off.
The installed copy then does all the work itself, as it used to, and the
journal says after a switch when the release's script differs from it. Use
it if you would rather read a new deploy script before it runs on your
server, and install it yourself with the `bash -n` and `install` lines
above; or for a while, to deploy with the installed copy when a commit's
own deploy script is broken (see "When a deployment fails"). In that second
case the release that is then deployed holds the broken script: do not
install the script of that release. For a script that is missing, empty or
not parsed the journal says so itself ("Do NOT install it"). For one that
bash can parse and that does not work it cannot know, and asks for the
install as for any script that differs. When a commit whose script works is
on `main`, take the `SELF_UPDATE=off` line out again: the next run is
handed to that script.

Two things to know before you write that line:

- **The installed copy must know the setting.** A copy from before the
  hand-over existed stops on a config file that names `SELF_UPDATE`, at
  every run, and deploys nothing ("SELF_UPDATE is not a setting this script
  knows"). Install the new copy first (the lines above), then write the
  setting. If the `grep` there still prints 0, the release that is running
  is itself from before the hand-over, and installing from it changes
  nothing: take the `SELF_UPDATE` line out of `deploy.conf` again, let the
  next run deploy the release that brings the new script, then install and
  write the setting. To have no run in between, which would be
  handed over because "on" is the default, stop the timer while you do
  both: `sudo systemctl stop hearth-deploy.timer`, install, write the
  setting, `sudo systemctl start hearth-deploy.timer`.
- **With "off" the installed copy does the work, however old it is.** While
  the hand-over is on, that copy stays the one from the day you installed
  it, and by the time you need "off" it may be much older than the release
  it would deploy: it does not know what later deploy scripts learned, and
  it stops on a setting in `deploy.conf` that was added since. So before
  you set `SELF_UPDATE=off`, also as the way out of a broken deploy script,
  install the script of the release that is running, with the lines above.
  In that order: once "off" has deployed a commit whose script is broken,
  the release that is running is the one that holds it. The running
  release's script is the last one that worked, with one exception. A
  script whose fault shows only after it has deployed its own commit (when
  it finds nothing new, tidies up, finishes a restart, or when only the
  mini-apps change) is the script of the running release itself. Then take
  the script of the release before it: `sudo ls /opt/hearth/releases` lists
  the releases that are kept, oldest first, and each holds
  `hearth/deploy/hearth-deploy.sh`.

The name must be written exactly, with nothing before it: `deploy.conf` is
not a shell script. A line the script can tell is `SELF_UPDATE` misspelt
("SELF-UPDATE=off", "self_update=off", "export SELF_UPDATE=off", no "=")
stops every run and names the line. Another name, such as "SELF_UPDATES=off", is
taken for a setting of a newer deploy script: the run is still handed over,
and the copy that does the work then stops on the line it does not know.

The systemd units and the polkit rule are not kept up to date this way:
they need root, and the polkit rule is what limits the `hearth` user.
Should a release change them, install them by hand, again from the release
that is running:

```sh
cd /opt/hearth/current/hearth/deploy
sudo cp systemd/hearth.service systemd/hearth-deploy.service systemd/hearth-deploy.timer /etc/systemd/system/
sudo cp polkit/50-hearth-deploy.rules /etc/polkit-1/rules.d/
sudo systemctl daemon-reload
```

## 6. Cloudflare Access, then the tunnel

Do these in this order, so the site is never reachable without sign-in.

1. In Cloudflare Zero Trust, create a self-hosted **Access application** for
   the hostname you will use, with one **Allow** policy that includes only
   your email address.
2. Copy the application's **Audience (AUD) tag** and your **team domain**
   (`your-team.cloudflareaccess.com`) into `/etc/hearth/hearth.env`.
3. Only now create the tunnel and route the hostname to
   `http://127.0.0.1:4310`.

To let a family member in later, they need both an entry in the Access policy
and an invitation in Hearth. For the invitation, create a group in Hearth's
Settings (for example "Family") and add their email address to it: they are
listed as invited until they first open Hearth, and join the group then.
Only you, the server's owner, can create groups and invite people who are
not on the server yet; `HEARTH_GROUP_POLICY=everyone` in `hearth.env` would
open both to everyone on the server.

## 7. First deployment

```sh
sudo systemctl start hearth-deploy.service
journalctl -u hearth-deploy.service -n 50
sudo systemctl enable --now hearth-deploy.timer
```

The first run builds a release, with the mini-apps of `hearth-stones` in it,
tries it on a spare port, points `/opt/hearth/current` at it and starts the
service. The journal names the mini-apps the release holds ("The build holds
..."). After that, every push to `main` of either repository is picked up
within about a minute.

### When a deployment fails

The reason is always in the journal (`journalctl -u hearth-deploy.service`);
build output is in `/opt/hearth/logs`.

- **The build or the trial start fails.** The running release is untouched.
  The trial start runs against a copy of the database (`DATABASE` in
  `/etc/hearth/deploy.conf`), so a migration that fails on your real data
  fails here. The same commits are tried again after `RETRY_AFTER_MINUTES`.
- **The mini-apps were written for another version of the SDK.** The build
  stops at once, and the lines after the error name the version each side
  has. The running release is untouched. This is expected between merging a
  new SDK version into `hearth` and the matching change into
  `hearth-stones` (in either order): the same commits are not built again,
  and the next commit of either repository is built at once. To deploy a
  framework fix before the two match, empty `APPS_REPO` in `deploy.conf`
  for a while, at the cost described in step 3.
- **The mini-apps cannot be linked to the SDK.** `pnpm install --offline`
  failed in the release's copy of `hearth-stones`, for example because its
  `pnpm-lock.yaml` is out of date or names a package the server does not
  already have: it must hold nothing but the link to the SDK. Fix it there.
  The running release is untouched, and the same commits are tried again
  after `RETRY_AFTER_MINUTES`.
- **A commit's deploy script is missing or broken.** Each commit is
  deployed by its own `deploy/hearth-deploy.sh` (step 5). If the newest
  framework commit has none, or it is empty, or bash cannot parse it, the
  installed copy does the run itself as far as the build: it still clears
  away what an interrupted run left and finishes a restart that is pending.
  Then the journal says that the newest commits "are not deployed: the
  deploy script of that framework commit cannot carry out the run", and
  why. The running release is untouched. Push a commit that puts the script
  right: the run is handed to it and it is deployed at once. Or set
  `SELF_UPDATE=off` in `/etc/hearth/deploy.conf` to deploy with the
  installed copy, after installing the script of the running release in its
  place (step 5): the same commits are tried again after
  `RETRY_AFTER_MINUTES`, or at once when you delete
  `/opt/hearth/state/failed`. The release that is then deployed holds the
  broken script, so do not install the script of that release; the journal
  says "Do NOT install it" after the switch. When a commit whose script
  works is on `main`, take the `SELF_UPDATE=off` line out again.

  The installed copy is as old as the day you installed it, so it may stop
  before it gets that far, on a setting in `deploy.conf` that was added
  since, on a value it would not take, or on a tool it still asks for. The
  journal then says, at every run, "NOTE: the deploy script of framework
  commit ... cannot carry out this run, because ... So this copy does",
  then the error that stopped it, such as "... is not a setting this script
  knows". The config file is probably right; the commit's script is what
  is wrong. Nothing is recorded in `state/failed`, and a pending restart is
  not finished, until a commit puts the script right. `SELF_UPDATE=off`
  alone does not help here, since the same copy stops on the same line:
  install the script of the running release first.
- **A commit's deploy script can be parsed but does not work.** Every run
  is handed to it, so while that commit is the newest, nothing a run does
  happens: nothing is deployed, newer mini-apps included, and a restart
  that is pending is not finished. If the script fails, its own error is in
  the journal at every run, with the file it counts lines in
  (`/opt/hearth/state/deploy-script`). If it ends without an error, the
  journal says nothing at all, and the only sign is that pushes are no
  longer deployed. The ways out are the same: push a commit whose script
  works, which is handed the next run and deployed at once; or install the
  script of the running release and set `SELF_UPDATE=off`, in that order.
  If the faulty script deployed its own commit before its fault showed, it
  is the script of the running release: install the one of the release
  before it instead (step 5 says where to find it). And once "off" has
  deployed a commit whose script does not work, do not install the script
  of that release, although the journal asks for it as for any script that
  differs from the installed copy: it cannot tell that a script which bash
  can parse does not work.
- **The new release fails as the live service.** The script stops the
  service, puts the database back as it was just before the switch, points
  `current` at the previous release and starts it. The database has to go
  back because an older build refuses a database that a newer build has
  migrated. What the failed release left is kept beside the database as
  `hearth-deploy-failed-<release>.db`. These commits are not tried again by
  themselves, because every try interrupts the site: push a fix, or delete
  `/opt/hearth/state/failed` to try the same commits once more.
- **The previous release does not come back either.** `current` points at
  it and the note `/opt/hearth/state/restart-pending` stays. Later runs
  restart the service up to three times, and keep fetching: a newer commit on
  `main` is still built and tried. With the hand-over on, a run fetches the
  framework before it does anything else, so the restart waits for that
  fetch: no time when the remote answers or refuses, up to two minutes when
  it does not answer at all, and twice that when the run is handed over
  after a fetch that failed, since the copy that takes over tries the fetch
  again. With `SELF_UPDATE=off` the restart comes first. Look at
  `systemctl status hearth.service`.
  If the service says the database has a migration it does not know, the
  database was not put back: stop the service, copy the newest
  `/var/lib/hearth/hearth-deploy-before-<release>.db` over
  `/var/lib/hearth/hearth.db`, delete `hearth.db-wal` and `hearth.db-shm` if
  they exist, and start the service.

The copies beside the database (`hearth-deploy-before-…`, one is kept) exist
for going back after a failed switch. They are not a backup: see step 9.

## 8. Check that it works

- `curl http://127.0.0.1:4310/api/health` on the server answers
  `{"ok":true,...}`.
- Opening your hostname in a browser shows the Cloudflare sign-in, then the
  Hearth dashboard.
- Opening it in a private window with a different email address is refused by
  Cloudflare.

## 9. Backups

The plan is continuous replication of `/var/lib/hearth/hearth.db` to
Cloudflare R2 with Litestream. This is **not set up or verified yet**. One
point to settle first: whether the current Litestream release can encrypt
replicas before upload. Older releases could (with `age` keys); that has not
been confirmed for the current one. Until it is, do not rely on this section,
and keep your own copy of the database file.

## What the server connects to

Nothing connects to the server from outside: the tunnel carries every
request to it. It makes these connections itself:

- **Cloudflare Access**, for the public keys that sign each request's
  identity (`https://your-team.cloudflareaccess.com/cdn-cgi/access/certs`).
- **The hosts the mini-apps name**, from their jobs alone. Each app lists in
  its manifest the hosts its jobs fetch from, and the Apps page names them
  when someone adds the app ("Fetches data from api.github.com on its
  own."). GitHub Trending, in `hearth-stones`, uses `api.github.com`: once
  an hour in each space it is in, three searches, and three more for each
  language the space follows. Every request is
  a GET over https that says it is from Hearth (`User-Agent: Hearth`) and
  carries nothing of anyone's: no cookie, no sign-in. Requests to one host
  start at least 6.5 seconds apart across the whole server, which keeps
  every space's apps together within GitHub's limit of 10 searches a minute
  for an address without a token. `HEARTH_JOBS=off` in `hearth.env` stops
  them all; the deploy's trial start always runs with it, so a release on
  trial fetches nothing.

`cloudflared` connects to Cloudflare to carry the tunnel. The deploy script
fetches the repositories from their remotes (GitHub) and, for each release
it builds, installs the framework's packages from the npm registry; the
mini-apps' install is offline.
