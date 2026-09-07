#!/usr/bin/env bash
#
# Instala o Bullpane Pro numa EC2 (Amazon Linux 2023 / Ubuntu).
# Roda DENTRO da instância, via Session Manager ou SSH.
#
#   sudo bash instalar-ec2.sh
#
# Não clona repositório e não precisa de token: puxa a imagem pública do ghcr.
# Sobe o app (porta 3000) + MySQL, ambos em Docker, com restart automático.
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

echo "==> 2/4 Configuração em $APP_DIR"
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
  echo "    .env criado (senhas geradas aleatoriamente)"
else
  echo "    .env já existe, mantendo"
fi

# compose autocontido: não depende do repositório
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

echo "==> 3/4 Puxando a imagem e subindo"
docker compose --env-file .env pull
docker compose --env-file .env up -d

echo "==> 4/4 Aguardando"
for i in $(seq 1 60); do
  curl -sf http://localhost:3000/api/health >/dev/null 2>&1 && break
  sleep 5
done

IP=$(hostname -I | awk '{print $1}')
echo
echo "====================================================================="
if curl -sf http://localhost:3000/api/health >/dev/null 2>&1; then
  echo " NO AR em http://$IP:3000"
  echo
  echo " health : $(curl -s http://localhost:3000/api/health)"
  echo " edição : $(curl -s http://localhost:3000/api/edition | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["tier"], "| licenciado para:", (d.get("license") or {}).get("licensee","-"))' 2>/dev/null || echo '?')"
  echo
  echo " Se disser 'free', o BULLPANE_LICENSE_KEY não chegou: edite $APP_DIR/.env"
  echo " e rode: docker compose --env-file .env up -d"
else
  echo " NÃO SUBIU. Logs:"
  echo "   cd $APP_DIR && docker compose --env-file .env logs --tail 50"
fi
echo "====================================================================="
