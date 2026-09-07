# "Tem risco de foder produção?"

Resposta curta: o risco existe, mas dá para reduzir a praticamente zero com duas camadas
que **não dependem do meu código estar certo**. Abaixo, o que foi de fato medido.

---

## Camada 1 — usuário Redis só-leitura (a que importa)

A proteção mais forte não é uma flag do dashboard, é o **próprio Redis recusar**. Crie um
usuário que fisicamente não consegue escrever:

```bash
redis-cli ACL SETUSER bullpane on '>SENHA_FORTE' '~*' '&*' \
  -@all +@read +@scripting -@dangerous -keys -sort \
  +info '+client|list' +ping +echo +hello +auth
```

**A ordem importa.** No Redis 7, `INFO` faz parte de `@dangerous`; se `-@dangerous` vier
depois de `+info`, ele cancela o `+info` e o monitor de saúde para de funcionar. Descobri
isso testando, não lendo documentação.

Verificado num Redis 7.0.11 real:

```
DEL          -> NOPERM this user has no permissions to run the 'del' command
SET          -> NOPERM ...
LPUSH        -> NOPERM ...
ZADD         -> NOPERM ...
FLUSHALL     -> NOPERM ...
KEYS *       -> NOPERM ...
```

E o dashboard **funciona inteiro** com esse usuário. Testado contra 13 filas com dados reais:

```
ok  status da conexão verde        redis 7.0.11 · 0.6ms
ok  monitor de saúde do Redis      mem=7.71M cpuSec=2.25 clients=42 evicted=0
ok  filas + métricas               13 filas, 12 com métricas
ok  setup mostra workers           lib=bullmq:5.81.4 workers=1
ok  lista jobs / detalhe / busca em job data
```

E ao tentar escrever pelo dashboard:

```
add job  -> HTTP 409  NOPERM this user has no permissions...
pause    -> HTTP 409  NOPERM this user has no permissions...
```

O Redis recusou sozinho. Nem chegou a depender do `BULLPANE_READ_ONLY`.

> Detalhe conhecido: a mensagem de erro cita o comando `info` mesmo numa tentativa de
> escrita, porque a biblioteca `bullmq` chama `INFO` antes de escrever. O bloqueio está
> correto, o texto é que confunde. Vale melhorar.

Se o seu Redis for anterior ao 6 e não tiver ACL, use uma **réplica de leitura**: aponte o
dashboard para ela e nenhuma escrita é possível por definição.

---

## Camada 2 — `BULLPANE_READ_ONLY=true`

Já está `true` na task definition. Recusa toda requisição de escrita com HTTP 423 antes de
chegar no handler, num único hook, então nenhuma rota nova pode esquecer. Testado: 14 rotas
de escrita bloqueadas.

É a rede de segurança contra alguém clicar em algo, não contra bug meu. A camada 1 é a que
protege contra bug meu.

---

## E a carga? (o medo legítimo com 10M jobs/dia)

Todo comando que o dashboard executa no seu Redis:

```
ZCARD · ZCOUNT · ZRANGE · ZREVRANGE · LLEN · LRANGE · LINDEX · LPOS
HGETALL · HMGET · HGET · HEXISTS · EXISTS · ZSCORE · SISMEMBER · PTTL
SCAN · INFO · CLIENT LIST · PING · EVALSHA
```

Nenhum `KEYS`. Nenhum `DEL`. Nenhum `FLUSHALL`. Nada de complexidade O(N) sobre o keyspace.

Por ciclo de atualização, por conexão:

| O quê | Custo |
|---|---|
| Lista de filas (5s) | 1 pipeline, 1 EVALSHA por fila |
| Página de fila (3s) | 1 EVALSHA para contagens, 1 para a página visível |
| Descoberta (30s) | 1 passe de SCAN limitado, `MATCH prefix:*:meta COUNT 500` |
| Monitor de saúde (3s) | 1 INFO, que é O(1) |

As contagens de sucesso usam `ZCOUNT`, que é O(log N): custa o mesmo numa fila de 100 ou de
21 milhões de jobs. Os payloads são truncados **dentro do Lua**, então uma fila com jobs de
500 KB custa o mesmo que uma com jobs minúsculos.

**Tire a foto do "antes"** e compare, é o que resolve a discussão:

```bash
redis-cli -h seu-cluster info stats | grep instantaneous_ops_per_sec
redis-cli -h seu-cluster --latency -i 5
```

Abra o dashboard na fila mais movimentada e compare. Se mexer o ponteiro, o botão
**Pause monitoring** na home corta o tráfego do dashboard na hora.

---

## E o Aurora?

Você disse que dá medo usar o banco de produção, e é um receio razoável. Duas observações:

1. O que o dashboard grava é **304 KB** medidos numa instância real com filas, usuários,
   pastas e alertas configurados. Ele nunca toca em nada que já exista: cria as tabelas
   dele num database próprio (`bullpane`) e só.
2. Ainda assim, **se dá medo, não reaproveite**. Um `db.t4g.micro` separado custa ~USD 15/mês
   e encerra o assunto. Eu sugeri reaproveitar por causa dos 304 KB, mas otimizar USD 15 num
   cluster que te deixa desconfortável é a otimização errada.

Se reaproveitar, crie um usuário MySQL com permissão **só no database `bullpane`**:

```sql
CREATE DATABASE bullpane CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'bullpane'@'%' IDENTIFIED BY 'SENHA_FORTE';
GRANT ALL PRIVILEGES ON bullpane.* TO 'bullpane'@'%';   -- só nesse database
```

Assim, mesmo com um bug meu, o alcance é um database de 304 KB.

---

## Ordem recomendada

1. Usuário Redis só-leitura (ou uma réplica).
2. `BULLPANE_READ_ONLY=true`.
3. Usuário MySQL restrito ao database `bullpane`.
4. Rode uns dias e compare as métricas do Redis com a foto do "antes".
5. Só depois, se quiser escrita, troque para um usuário Redis com permissão e
   `BULLPANE_READ_ONLY=false`. Um passo de cada vez.

Nos passos 1 a 4, o pior caso é o dashboard não funcionar. Não existe caminho para perda de
dados, porque nem o Redis nem o MySQL aceitam escrita dele.
