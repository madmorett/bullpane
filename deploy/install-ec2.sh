#!/usr/bin/env bash
#
# Installs Bullpane on an EC2 box (Amazon Linux 2023 / Ubuntu).
# Run it INSIDE the instance, over Session Manager or SSH.
#
#   sudo bash install-ec2.sh
#
# It clones nothing and needs no token: it pulls the public image from ghcr.
# Brings up the app (port 3000) + MySQL, both in Docker, with automatic restart.
set -euo pipefail

IMAGE="${IMAGE:-ghcr.io/madmorett/bullpane:0.1.0}"
APP_DIR="${APP_DIR:-/opt/bullpane}"
LICENSE_KEY="${LICENSE_KEY:-}"
READ_ONLY="${READ_ONLY:-false}"

echo "==> 1/4 Docker"
if ! command -v docker >/dev/null 2>&1; then
  if command -v dnf >/dev/null 2>&1; then dnf install -y docker >/dev/null
  elif command -v yum >/dev/null 2>&1; then yum install -y docker >/dev/null
  else apt-get update -qq && apt-get install -y docker.io >/dev/null; fi
fi
systemctl enable --now docker >/dev/null 2>&1 || service docker start

if ! docker compose version >/dev/null 2>&1; then
  mkdir -p /usr/libexec/docker/cli-plugins
  curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m)" \
    -o /usr/libexec/docker/cli-plugins/docker-compose
  chmod +x /usr/libexec/docker/cli-plugins/docker-compose
fi
echo "    $(docker --version), compose $(docker compose version --short)"

echo "==> 2/4 Configuration in $APP_DIR"
mkdir -p "$APP_DIR" && cd "$APP_DIR"

if [ ! -f .env ]; then
  MYSQL_PASS=$(openssl rand -hex 16)
  cat > .env <<ENVEOF
IMAGE=${IMAGE}
SESSION_SECRET=$(openssl rand -hex 32)
MYSQL_PASSWORD=${MYSQL_PASS}
DATABASE_URL=mysql://bullpane:${MYSQL_PASS}@mysql:3306/bullpane
BULLPANE_LICENSE_KEY=${LICENSE_KEY}
BULLPANE_READ_ONLY=${READ_ONLY}
PUBLIC_URL=http://$(hostname -I | awk '{print $1}'):3000
LOG_LEVEL=info
ENVEOF
  chmod 600 .env
  echo "    .env created (passwords generated at random)"
else
  echo "    .env already exists, keeping it"
fi

# self-contained compose file: does not depend on the repo
cat > docker-compose.yml <<'YMLEOF'
services:
  app:
    image: ${IMAGE}
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      DATABASE_URL: ${DATABASE_URL}
      SESSION_SECRET: ${SESSION_SECRET}
      PUBLIC_URL: ${PUBLIC_URL}
      BULLPANE_LICENSE_KEY: ${BULLPANE_LICENSE_KEY}
      BULLPANE_READ_ONLY: ${BULLPANE_READ_ONLY}
      LOG_LEVEL: ${LOG_LEVEL}
    depends_on:
      mysql:
        condition: service_healthy

  mysql:
    image: mysql:8.4
    restart: unless-stopped
    environment:
      MYSQL_DATABASE: bullpane
      MYSQL_USER: bullpane
      MYSQL_PASSWORD: ${MYSQL_PASSWORD}
      MYSQL_ROOT_PASSWORD: ${MYSQL_PASSWORD}
    volumes:
      - mysql-data:/var/lib/mysql
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "127.0.0.1", "-uroot", "-p${MYSQL_PASSWORD}"]
      interval: 5s
      timeout: 5s
      retries: 30

volumes:
  mysql-data:
YMLEOF

echo "==> 3/4 Pulling the image and starting"
docker compose --env-file .env pull
docker compose --env-file .env up -d

echo "==> 4/4 Waiting for it to come up"
for i in $(seq 1 60); do
  curl -sf http://localhost:3000/api/health >/dev/null 2>&1 && break
  sleep 5
done

IP=$(hostname -I | awk '{print $1}')
echo
echo "====================================================================="
if curl -sf http://localhost:3000/api/health >/dev/null 2>&1; then
  echo " UP at http://$IP:3000"
  echo
  echo " health : $(curl -s http://localhost:3000/api/health)"
  echo " edition: $(curl -s http://localhost:3000/api/edition | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["tier"], "| licensed to:", (d.get("license") or {}).get("licensee","-"))' 2>/dev/null || echo '?')"
  echo
  echo " The free edition has NO LOGIN: anyone who can reach this address can"
  echo " retry, promote and delete jobs. Keep it behind a security group, or set"
  echo " BULLPANE_LICENSE_KEY in $APP_DIR/.env and run:"
  echo "   docker compose --env-file .env up -d"
else
  echo " DID NOT START. Logs:"
  echo "   cd $APP_DIR && docker compose --env-file .env logs --tail 50"
fi
echo "====================================================================="
