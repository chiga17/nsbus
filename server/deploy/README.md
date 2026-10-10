# Droplet

Runs the poller on an Ubuntu droplet. SSH host `droplet` comes from `~/.ssh/config`.

The service is `nsbus`, installed in `/opt/nsbus`. It listens on `PORT` from `server/.env.droplet` (8080 unless you change it).

## First time

```bash
cp server/.env.example server/.env.droplet
```

Fill in the secrets. Set `HOST=0.0.0.0` and `CLIENT_ORIGIN` to the public site.

```bash
bash server/deploy/setup.sh
bash server/deploy/update.sh
```

## Later updates

```bash
bash server/deploy/update.sh
```

That replaces the poller code and `server/stops.json`, reinstalls dependencies, and restarts the service.

## Logs

```bash
bash server/deploy/logs.sh
ssh droplet systemctl restart nsbus
```

If the port is still closed, open TCP `PORT` in the DigitalOcean firewall. `ufw`, when it is already enabled, is opened by the update script.
