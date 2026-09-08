# Deploy

Ways to run Bullpane in production. Pick one.

| Path | When it makes sense | Rough cost |
|---|---|---|
| **EC2 + Docker** (`install-ec2.sh`) | One box, the fastest way to start | ~USD 15/month |
| **ECS Fargate** (`ecs/`) | You already run ECS and want it managed | ~USD 33/month with an ALB |
| **Docker Compose** (repo root) | Local, or a server you already have | — |

In every case the dashboard needs:

1. **MySQL** for its own data (users, connections, folders, alerts). That is
   hundreds of KB, not gigabytes: a container or the smallest instance is fine.
2. **A network route to your Redis.** This is the step that stalls most deploys.
3. **`SESSION_SECRET`**, 32+ random characters. Changing it signs everyone out.

Optionally, `BULLPANE_LICENSE_KEY` to unlock the Pro edition.

## Updating an existing box

The dashboard keeps nothing in the container: users, connections, folders,
alerts and the audit log live in MySQL, and the licence key with them. Updating
is therefore pulling a new image and recreating the app container — MySQL is
left alone.

```sh
cd /opt/bullpane                      # wherever your compose file lives
docker compose --env-file .env pull app
docker compose --env-file .env up -d app
docker compose --env-file .env logs -f app     # ctrl-C once it says "Bullpane <version>"
```

Pin the version you want in `.env` (`IMAGE=ghcr.io/madmorett/bullpane:0.1.0`)
rather than tracking `:latest`, so an update is a decision and not a surprise
on the next `pull`. `docker image prune` afterwards reclaims the old layers.

**Rolling back** is the same two commands with the previous tag. Migrations run
forward on boot and are not reversed, so a rollback across a schema change
means restoring the MySQL dump you took first:

```sh
docker compose --env-file .env exec mysql \
  mysqldump -u root -p"$MYSQL_ROOT_PASSWORD" bullpane > backup-$(date +%F).sql
```

### Coming from `bullmq-visualizer`

The image was renamed when the product became Bullpane, and the env prefix
changed from `BMV_*` to `BULLPANE_*` (the old names still work and log a
warning). Update the `image:` line to `ghcr.io/madmorett/bullpane:<version>`
and keep the same MySQL: the schema is continuous, and migrations bring an
older database forward on the first boot.

**0.1.0 removes the login from the free edition.** If that box is not licensed,
it will stop asking for a password — anyone who can reach it can retry, promote
and delete jobs. Put it behind a security group or a VPN before updating, or
activate a Pro key, which brings login, roles and the audit log back.

## Start in read-only mode

`BULLPANE_READ_ONLY=true` refuses every write with HTTP 423 and leaves reads
untouched. The first time you point the dashboard at a busy production Redis,
run it this way for a few days. See `ecs/REDIS-SAFETY.md`.

## Files

- `install-ec2.sh` — installs Docker, generates passwords and brings up app + MySQL on an EC2 box
- `ecs/task-definition.example.json` — generic task definition, with placeholders
- `ecs/REDIS-SAFETY.md` — what the dashboard does to your Redis, measured
