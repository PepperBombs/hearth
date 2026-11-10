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
```

## 3. Check out the repositories side by side

```sh
sudo -u hearth git clone https://github.com/YOUR-ORG/hearth.git /opt/hearth/repos/hearth
sudo -u hearth git clone https://github.com/YOUR-ORG/hearth-apps.git /opt/hearth/repos/hearth-apps
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
Cloudflare values from step 6.

## 5. Install the service and the deploy timer

```sh
cd /opt/hearth/repos/hearth/deploy
sudo install -m 755 hearth-deploy.sh /usr/local/bin/hearth-deploy
sudo cp systemd/hearth.service systemd/hearth-deploy.service systemd/hearth-deploy.timer /etc/systemd/system/
sudo cp polkit/50-hearth-deploy.rules /etc/polkit-1/rules.d/
sudo systemctl daemon-reload
sudo systemctl enable hearth.service
```

The polkit rule lets the `hearth` user restart `hearth.service` and nothing
else, so deployments need no root access.

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
`main` is picked up within about a minute. A failed build leaves the running
release untouched; the reason is in the journal and in `/opt/hearth/logs`.

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
