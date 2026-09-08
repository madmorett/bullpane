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

## Start in read-only mode

`BULLPANE_READ_ONLY=true` refuses every write with HTTP 423 and leaves reads
untouched. The first time you point the dashboard at a busy production Redis,
run it this way for a few days. See `ecs/REDIS-SAFETY.md`.

## Files

- `install-ec2.sh` — installs Docker, generates passwords and brings up app + MySQL on an EC2 box
- `ecs/task-definition.example.json` — generic task definition, with placeholders
- `ecs/REDIS-SAFETY.md` — what the dashboard does to your Redis, measured
