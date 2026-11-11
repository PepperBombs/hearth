# Running Hearth on your own server

This guide sets up one Linux server with no public ports. Cloudflare Tunnel
carries traffic to it and Cloudflare Access decides who gets in.

**Not yet tested on a real server.** The steps below were written alongside
the code and the deploy script, but nobody has run them end to end. Treat the
first installation as a test, and expect to correct details.

Everything personal (your domain, email address, secrets) stays on the server
and never goes into a repository.

## 1. Install the tools

- Node.js 22 or newer, and pnpm 10 (`corepack enable` provides pnpm).
- `git`, `tar`, `curl`, and `flock` and `timeout` (in `util-linux` and
  `coreutils` on most systems).
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

## 4. Write the settings

```sh
sudo cp /opt/hearth/repos/hearth/deploy/hearth.env.example /etc/hearth/hearth.env
sudo cp /opt/hearth/repos/hearth/deploy/deploy.conf.example /etc/hearth/deploy.conf
sudo chown root:hearth /etc/hearth/hearth.env && sudo chmod 640 /etc/hearth/hearth.env
```

Edit `/etc/hearth/hearth.env`: your email address as owner, and the two
Cloudflare values from step 6. Leave `HEARTH_AUTH=cloudflare-access` as it
is: `dev` signs nobody in and is for a developer's own machine only.

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
and an invitation in Hearth. Inviting from the interface does not exist yet;
it arrives with a later step.

## 7. First deployment

```sh
sudo systemctl start hearth-deploy.service
journalctl -u hearth-deploy.service -n 50
sudo systemctl enable --now hearth-deploy.timer
```

The first run builds a release, tries it on a spare port, points
`/opt/hearth/current` at it and starts the service. After that, every push to
`main` is picked up within about a minute.

### When a deployment fails

The reason is always in the journal (`journalctl -u hearth-deploy.service`);
build output is in `/opt/hearth/logs`.

- **The build or the trial start fails.** The running release is untouched.
  The trial start runs against a copy of the database (`DATABASE` in
  `/etc/hearth/deploy.conf`), so a migration that fails on your real data
  fails here. The same commits are tried again after `RETRY_AFTER_MINUTES`.
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
  `main` is still built and tried. Look at `systemctl status hearth.service`.
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
