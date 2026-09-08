# Documentation

## Understanding the project

| | |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | How the pieces fit together, and the performance contract |
| [API.md](API.md) | Every REST endpoint |
| [PRO.md](PRO.md) | License format, how to issue one, `DEMO_MODE` |

## Running it

| | |
|---|---|
| [../deploy/README.md](../deploy/README.md) | EC2, ECS or Docker Compose |
| [PRODUCTION-TRIAL.md](PRODUCTION-TRIAL.md) | Pointing it at a busy production Redis safely |
| [../deploy/ecs/REDIS-SAFETY.md](../deploy/ecs/REDIS-SAFETY.md) | What the dashboard does to your Redis, measured command by command |
| [STRESS-TEST.md](STRESS-TEST.md) | The harness that proves it does not degrade the operation |
| [DEMO.md](DEMO.md) | The simulator and the public demo |

## Business

| | |
|---|---|
| [LAUNCH.md](LAUNCH.md) | Accounts needed, costs, payments, order of execution |

## Customer configuration

Lives in `private/`, outside git: account ids, endpoints, signed licenses. The
generic equivalent in these docs uses placeholders (`<ACCOUNT_ID>`, `<REGION>`).
