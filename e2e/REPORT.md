# Testes E2E do editor de vídeo: relatório

Ronda de testes com Playwright no branch `feature/timeline`, a 15/10/2026, contra a stack local (`docker compose`), em Google Chrome 155 e no Firefox do Playwright 1.48.

Depois da primeira ronda, os bugs 1 a 5 foram corrigidos e a suite voltou a correr completa (ver «Segunda ronda»). Ao validar a correção do bug 3 apareceu um problema novo, o 6, que ficou por corrigir.

## Resultado

**Segunda ronda, depois das correções: 34 testes passam e nenhum falha.** 1 é saltado no Firefox (o Retry, que usa o Docker).

| Área | Testes | Chrome | Firefox |
|---|---|---|---|
| Corte (split + delete) e exportação | `editor.spec.ts` | ✓ | ✓ |
| Velocidade 2× (duração, playbackRate e preservesPitch, exportação) | `editor.spec.ts` | ✓ | ✓ |
| Conversão MOV/H.265 → AVI, qualidade baixa (sai H.264 + MP3) | `editor.spec.ts` | ✓ | ✓ |
| Concatenação de 3 origens, uma sem áudio | `editor.spec.ts` | ✓ | ✓ |
| Redimensionar 4:3 → 16:9 com pad e crop (barras pretas medidas no fotograma exportado) | `editor.spec.ts` | ✓ | ✓ |
| Reprodução dos proxies de MP4, MOV/HEVC e AVI: imagem e som seguem o relógio | `playback.spec.ts` | ✓ | ✓ |
| Reprodução a saltar um segmento apagado | `playback.spec.ts` | ✓ | ✓ |
| Registado: 10 min, 1080p, 5 origens, mínimo de 5 s (aviso na UI e 422 na API) | `limits.spec.ts` | ✓ | — |
| Premium: 11 min, 1440p e 6 origens aceites, sem gastar quota | `limits.spec.ts` | ✓ | — |
| Quota: reserva ao exportar e devolução ao cancelar | `quota.spec.ts` | ✓ | — |
| Apagar o projeto pela barra lateral do editor com uma exportação a decorrer (cancela, devolve a quota, o worker para) | `quota.spec.ts` | ✓ | — |
| Apagar o projeto pela barra lateral dentro do editor | `quota.spec.ts` | ✓ (era o bug 2) | — |
| Undo/redo (botões, teclado, depois de recarregar a página) | `history.spec.ts` | ✓ | ✓ |
| Unlink/Link e edição só do áudio | `history.spec.ts` | ✓ | ✓ |
| "Video in use" ao apagar um vídeo usado na timeline | `history.spec.ts` | ✓ | ✓ |
| Retry de uma pré-visualização falhada | `history.spec.ts` | ✓ | saltado (usa o Docker; basta um browser) |
| Exportação termina depois de reiniciar o RabbitMQ a meio | `resilience.spec.ts` | ✓ | — |

Os testes de backend (limites, quota, resiliência) só correm no Chrome, porque não dependem do browser.

### Primeira ronda

33 testes passaram, 1 falhou de propósito (`test.fail`, o bug 2) e 1 foi saltado. O relatório dizia «34 passam», porque o Playwright conta como «passed» um teste com `test.fail` que falha. Foram precisas três passagens:
1. **Primeira passagem:** falharam 7 testes por erros meus. 6 eram de seletores: o texto dos toasts está repetido numa região `aria-live` e o Next.js também usa `role="alert"`. O sétimo era o teste de velocidade, que exportava 4 s, abaixo do mínimo de 5 s.
2. **Segunda passagem:** os testes já corrigidos passaram, mas os uploads começaram a falhar por causa do bug 1.
3. **Terceira passagem:** libertei os volumes vazios do SeaweedFS (ver bug 1) e corri os 6 testes em falta, que passaram.

### Segunda ronda

Depois das correções dos bugs 1 a 5, a suite correu toda de uma vez, nos dois browsers, com vídeo e trace gravados em todos os testes. Passaram todos à primeira, em 7,9 min: 22 no Chrome e 12 no Firefox, mais o saltado.

Mudanças nos testes:
- `quota.spec.ts`: o teste do bug 2 deixou de ter `test.fail` e confirma também o aviso e que o projeto deixou de existir. O teste de apagar durante uma exportação passou a apagar a partir do editor (antes tinha de ir à página do projeto por causa do bug 2).
- O botão "…" do projeto é encontrado pelo nome acessível (bug 5), e não pela posição.

## Bugs encontrados

Ordenados por impacto na experiência do utilizador.

| # | Bug | Estado |
|---|---|---|
| 1 | Contas novas deixam de conseguir enviar ficheiros (SeaweedFS sem volumes) | Corrigido com configuração do SeaweedFS (`56b0866`) |
| 2 | No editor de vídeo não dá para apagar o projeto pela barra lateral | Corrigido (`d552ccc`) |
| 3 | Pedidos das ferramentas de imagem perdem-se se a ligação cair a meio | Corrigido (`31db6f0`) |
| 4 | Textos em português na interface em inglês | Corrigido (`b0c1843`) |
| 5 | O botão "…" de cada projeto não tem nome acessível | Corrigido (`49e9547`) |
| 6 | Pedidos das ferramentas de imagem perdem-se se o RabbitMQ reiniciar | **Por corrigir** (encontrado ao validar o 3; fica para a próxima sessão) |

### 1. Depois de ~50 contas, as contas novas deixam de conseguir enviar ficheiros (SeaweedFS sem volumes)

**Impacto: crítico.**
- Qualquer conta nova recebe "The video could not be saved. Try again." ao enviar um vídeo. As imagens usam o mesmo storage, por isso o mais provável é falharem também (não testei).
- As contas antigas continuam a funcionar, por isso é fácil o problema passar despercebido.
- Tentar outra vez não resolve.

**Passos para reproduzir (antes da correção):**
1. Com a stack a correr, criar contas novas e, em cada uma, enviar um vídeo. Por exemplo, correr esta suite duas vezes, porque cada teste cria a sua conta.
2. Por volta da 54.ª conta com ficheiros, o upload responde `500 storage_error`.
3. Log do `seaweedfs`: `No writable volumes and no free volumes left for {"collection":"user-…"}`.
4. `docker exec picturas-seaweedfs-1 sh -c 'echo volume.list | weed shell -master=localhost:9333' | head -1` mostra `volume:375/375 … free:0`, com só **169 MB** de dados.

**Causa:**
- Cada utilizador tem um bucket próprio (`user-<id>`), que no SeaweedFS é uma *collection*.
- Cada collection reservava logo 7 volumes de 1 GB (`-master.volumeSizeLimitMB=1024`).
- O servidor tem `free disk / 1 GB` ≈ 375 espaços. 60 collections esgotaram-nos.

**Correção (só configuração, no `docker-compose.yaml`; o modelo de um bucket por utilizador não muda):**
- `WEED_MASTER_VOLUME_GROWTH_COPY_1: "1"`: cada collection nova reserva 1 volume em vez de 7. É a chave `[master.volume_growth] copy_1` do `master.toml`, passada por variável de ambiente.
- `-master.volumeSizeLimitMB=128`: com volumes de 128 MB, o mesmo disco dá 8× mais espaços (3001 em vez de 375). Os ficheiros grandes não são afetados, porque o SeaweedFS os parte em blocos de 4 MB (`-filer.maxMB`); um vídeo de 2 GB (o máximo de upload) ocupa 16 volumes.
- Com as duas, uma conta quase vazia ocupa 1 espaço em vez de 7, e cada espaço vale 128 MB em vez de 1 GB: neste disco cabem ~3000 contas com ficheiros, em vez de ~53.

**Validação:** recriei o `seaweedfs` com a configuração nova sobre os dados que já existiam (342 volumes de 61 collections) e criei 100 contas novas, cada uma com um upload de vídeo:
- os 100 uploads responderam 201 e as 100 pré-visualizações ficaram `ready` (cada uma grava mais 3 ficheiros no mesmo bucket);
- os volumes passaram de 342 para 442, ou seja, exatamente 1 por collection nova;
- espaços livres no fim: 2559 de 3001.

As collections criadas antes da correção continuam com os volumes que já tinham.

### 2. No editor de vídeo não dá para apagar o projeto pela barra lateral

**Impacto: alto.**
- A confirmação ficava aberta e o projeto não era apagado.
- Aparecia um aviso em português a pedir para "abrir o projeto", que já estava aberto.
- Renomear pela barra lateral falhava da mesma forma.

**Passos para reproduzir (antes da correção):**
1. Abrir um projeto e carregar em **Video editor** (`/dashboard/<id>/videos`).
2. Na barra lateral, no menu **…** do projeto, escolher **Delete** e depois **Permanently Delete**.
3. Esperado: o projeto é apagado e a página volta para `/dashboard`.
4. Obtido: o toast "Não foi possível obter a versão do projeto — Abre o projeto primeiro (ou aguarda carregar) e tenta novamente." e a janela continuava aberta. A partir da página do projeto funcionava.

**Causa:**
- `components/dashboard-sidebar/project-item.tsx` lia a versão do projeto da cache com a chave `["project", uid, pid, token, ownerId, shareId]`, onde `ownerId` é o próprio utilizador.
- A página do editor carrega o projeto com `useGetProject(uid, pid, token)`, sem `ownerId`.
- A chave não coincidia e a versão vinha `undefined`.

**Correção:** antes de apagar ou renomear, o item da barra lateral pede a versão atual ao servidor (`fetchQuery`), em vez de depender da cache. Funciona em qualquer página, mesmo com um projeto que nunca foi aberto. Se o pedido falhar, aparece o aviso de erro normal (em inglês).

Teste: `quota.spec.ts`, "deleting the project from the sidebar while in the video editor".

### 3. Pedidos das ferramentas de imagem perdem-se se a ligação ao RabbitMQ cair a meio

**Impacto: médio.**
- As ferramentas de imagem consumiam com `auto_ack=True` (`Tools/utils/rabbit_mq.py`): o pedido era confirmado logo que chegava.
- Se a ligação caísse durante o processamento, a ferramenta voltava a ligar-se, mas o resultado não chegava a ser enviado e o pedido não voltava à fila. O processamento do projeto ficava preso.

**Correção:**
- Ack manual com `prefetch_count=1`: o pedido só é confirmado depois de enviada a resposta. Se a ligação cair, a resposta é descartada e o pedido volta à fila.
- O processamento corre numa thread, enquanto a ligação continua a responder aos heartbeats. Sem isto, uma ferramenta com mais de ~60 s perdia a ligação e, com ack manual, o pedido voltava à fila em ciclo. As respostas são publicadas pela thread da ligação, porque o pika não é thread-safe.

**Validação:**
- Contra o RabbitMQ da stack, com um consumidor de teste que usa o `Rabbit_MQ` das ferramentas:
  - uma tarefa de 150 s foi confirmada uma só vez, sem perder a ligação;
  - reiniciar o RabbitMQ a meio de uma tarefa de 40 s fez o pedido voltar à fila; foi repetido (`redelivered=True`) e houve uma só resposta.
- Na app, com o `upgrade_ai` sobre uma imagem de 7000×5000: fechar a ligação da ferramenta aos 3,7 s (`rabbitmqctl close_connection`) fez o pedido voltar à fila, e o resultado chegou aos 9,8 s (sem interrupção chega aos ~6 s).

### 4. Textos em português na interface em inglês

**Impacto: baixo.**
- Na barra lateral aparecia "Operações diárias restantes" (`components/operations-counter.tsx`), e o aviso de projeto criado (`new-project-dialog.tsx`) também estava em português.
- O toast do bug 2 desapareceu com essa correção.

**Correção:** "Daily operations left" e "Project created successfully." / "The images were added to the new project.".

### 5. O botão "…" de cada projeto na barra lateral não tem nome acessível

**Impacto: baixo, acessibilidade.**
- O `SidebarMenuAction` em `project-item.tsx` só tinha o ícone, por isso um leitor de ecrã anunciava apenas "button".
- Os testes tinham de o encontrar pela posição dentro do item do projeto.

**Correção:** `aria-label="More actions for <nome do projeto>"`. Os testes passaram a encontrá-lo por esse nome.

### 6. Pedidos das ferramentas de imagem perdem-se se o RabbitMQ reiniciar

**Impacto: médio. Não corrigido.** Encontrado ao validar o bug 3.
- O ack manual cobre a queda da ligação, mas não um reinício do próprio RabbitMQ.
- O `projects` publica os pedidos às ferramentas sem `persistent: true` (`projects/utils/rabbit_mq.js:25`), e as ferramentas publicam as respostas sem `delivery_mode=2` (`Tools/utils/rabbit_mq.py`).
- As filas são duráveis, mas as mensagens não persistentes ficam só em memória e perdem-se quando o broker reinicia. O processamento do projeto fica preso.
- O caminho do vídeo não tem este problema: `projects/utils/video_msg.js` já publica com `persistent: true`.

**Passos para reproduzir:**
1. Numa conta Premium, criar um projeto com uma imagem de 7000×5000 e a ferramenta `upgrade_ai` (~6 s).
2. Pedir o processamento e, 2 s depois, correr `docker restart picturas-rabbitmq-1`.
3. A ferramenta e o `projects` voltam a ligar-se, a fila `upgrade_ai_queue` fica vazia, e o resultado nunca chega (esperei 10 min).

**Correção proposta (não aplicada):** publicar como persistente nos dois sentidos, ou seja, `{ persistent: true }` no `channel.publish` de `projects/utils/rabbit_mq.js` e `properties=pika.BasicProperties(delivery_mode=2)` no `basic_publish` de `Tools/utils/rabbit_mq.py`.

## Observações (não são bugs)

- **H.264 no Chromium:** o Chromium do Playwright não descodifica H.264. Por isso os testes usam o Google Chrome (`channel: "chrome"`). No Chromium, a pré-visualização ficava preta.
- **Um só worker de render:** as exportações esperam umas pelas outras. Numa passagem, uma exportação de 2 min que sobrou de um teste atrasou a seguinte; a tarefa mostra só "Queued", sem posição na fila.
- **Fila sem consumidor:** a `scale_queue` não tem consumidor, porque não existe serviço `scale`. Nenhuma ferramenta da UI a usa.

## Como correr

Os testes correm contra a stack local (`docker compose up -d`), em `https://localhost:8080`.

```sh
cd e2e
npm ci
npx playwright install --with-deps chrome firefox   # o Chrome a sério tem H.264; o Chromium do Playwright não
npm run fixtures                                      # gera os vídeos de teste com ffmpeg (não vão para o git)
npm test                                              # Chrome + Firefox
```

- Alguns testes usam o Docker do anfitrião: reiniciar o RabbitMQ, ler o log do worker e pôr uma pré-visualização como falhada no Mongo. Precisam do comando `docker` com acesso aos contentores `picturas-*`. O prefixo muda-se com `COMPOSE_PROJECT`.
- Os testes correm um de cada vez, porque há um só worker de render e um deles reinicia o RabbitMQ.
- Cada teste cria a sua conta (`@test.local`).
- Outra URL: `BASE_URL=https://… npm test`.

### Vídeo, trace e relatório

Todos os testes gravam vídeo e trace (`video: "on"`, `trace: "on"` no `playwright.config.ts`), passem ou falhem.

```sh
cd e2e
npx playwright show-report                                  # relatório HTML (playwright-report/), com o vídeo e o trace de cada teste
npx playwright show-trace test-results/<pasta-do-teste>/trace.zip   # um trace sozinho
```

No relatório, cada teste tem o vídeo embutido e um botão para abrir o trace (linha do tempo com capturas, DOM, rede e consola de cada passo). As pastas `playwright-report/` e `test-results/` não vão para o git.
