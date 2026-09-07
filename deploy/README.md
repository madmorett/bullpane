# Deploy

Formas de rodar o Bullpane em produção. Escolha uma.

| Caminho | Quando faz sentido | Custo aproximado |
|---|---|---|
| **EC2 + Docker** (`instalar-ec2.sh`) | Uma máquina, o jeito mais rápido de começar | ~USD 15/mês |
| **ECS Fargate** (`ecs/`) | Já usa ECS e quer o sistema gerenciado | ~USD 33/mês com ALB |
| **Docker Compose** (raiz do repo) | Local, ou um servidor que você já tem | — |

Em todos os casos o dashboard precisa de:

1. **MySQL** para os dados dele (usuários, conexões, pastas, alertas). São
   centenas de KB, não gigabytes: um container ou a menor instância serve.
2. **Rota de rede até o seu Redis.** É o passo que mais trava deploys.
3. **`SESSION_SECRET`**, 32+ caracteres aleatórios. Trocar desloga todo mundo.

E, opcionalmente, `BULLPANE_LICENSE_KEY` para habilitar a edição Pro.

## Comece em modo leitura

`BULLPANE_READ_ONLY=true` recusa toda escrita com HTTP 423, mantendo a leitura intacta.
Ao apontar para uma produção movimentada pela primeira vez, use isso por alguns
dias. Ver `ecs/RISCO-PRODUCAO.md`.

## Arquivos

- `instalar-ec2.sh` — instala Docker, gera senhas e sobe app + MySQL numa EC2
- `ecs/task-definition.example.json` — task definition genérica, com placeholders
- `ecs/RISCO-PRODUCAO.md` — o que o dashboard faz no seu Redis, medido
