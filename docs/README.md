# Documentação

## Para entender o projeto

| | |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Como as peças se encaixam e o contrato de performance |
| [API.md](API.md) | Todos os endpoints REST |
| [PRO.md](PRO.md) | Formato da licença, como emitir, `DEMO_MODE` |

## Para rodar

| | |
|---|---|
| [../deploy/README.md](../deploy/README.md) | EC2, ECS ou Docker Compose |
| [PRODUCTION-TRIAL.md](PRODUCTION-TRIAL.md) | Apontar para uma produção movimentada com segurança |
| [../deploy/ecs/RISCO-PRODUCAO.md](../deploy/ecs/RISCO-PRODUCAO.md) | O que o dashboard faz no seu Redis, medido comando a comando |
| [DEMO.md](DEMO.md) | O simulador e a demo pública |

## Para o negócio

| | |
|---|---|
| [LANCAMENTO.md](LANCAMENTO.md) | Contas necessárias, custos, pagamento, ordem de execução |

## notas/

Anotações e material de referência, não documentação:

- `pedido-folder-view.md` — pedido original da tela de pastas
- `referencia-taskforce-queue-page.html` — DOM da página de fila do Taskforce, usado como referência para a aba de métricas

## Configuração de clientes

Fica em `private/`, fora do git. Se você trabalha com uma instalação existente,
comece por `private/monest/INSTALACAO-ATUAL.md`.
