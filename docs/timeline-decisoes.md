# Editor de vídeo com timeline: decisões e estado

Ponto de situação do branch `feature/timeline` a 15/10/2026, para retomar o trabalho numa sessão nova.

## Estado atual

- Tudo está no branch `feature/timeline`, criado a partir da `main` (`7b5a938`), com push para `grupo/feature/timeline`. **Ainda não houve PR nem merge.**
- Remotes: `grupo` é o repo do grupo (karaasu13/picturas-27); `origin` (picturas-um/picturas-27) **não se mexe**.
- As 4 fases do plano estão feitas, a ronda de testes com Playwright também, e os bugs 1 a 8 estão corrigidos.
- **Próximo passo:** o PR e o merge, quando o utilizador pedir.

Commits do branch (`git log --oneline main..HEAD`), do mais antigo para o mais recente:

| Commit | O quê |
|---|---|
| `4cf374c` | fase 1: modelo de timeline e API |
| `b95610f` | fase 2: motor de render e pré-visualizações |
| `1616d23` | fase 3: exportação da timeline como tarefa de render |
| `6f50e51` | fix: guardar a duração da faixa de vídeo e não a do contentor |
| `a93ee7a` | fase 4: editor de vídeo com timeline no frontend |
| `8dc3f5b` | fix(ws_gateway): voltar a ligar ao RabbitMQ |
| `5590514` | fix(nginx): resolver os nomes dos serviços em runtime |
| `c9b0464` | fix(projects): voltar a ligar ao RabbitMQ |
| `8bc5f7c` | fix(video_render): religar sem perder a exportação em curso |
| `9c7b310` | fix(tools): ferramentas de imagem religam dentro do processo |
| `620503f` | ronda de testes E2E com Playwright |
| `d552ccc` | bug 2: apagar/renomear o projeto pela barra lateral em qualquer página |
| `b0c1843` | bug 4: textos da barra lateral em inglês |
| `49e9547` | bug 5: nome acessível no botão "…" de cada projeto |
| `340ed43` | Playwright grava vídeo e trace de todos os testes |
| `31db6f0` | bug 3: ferramentas de imagem com ack manual |
| `56b0866` | bug 1: um volume de 128 MB por bucket no SeaweedFS |
| `7e075d7` | relatório E2E da segunda ronda |
| `b19e63e` | bug 6: pedidos e respostas das ferramentas de imagem persistentes |
| `b38baf3` | demonstração gravada do editor (`e2e/demo/`, fora da suite) |
| `2b75488` | bug 7: arrastar vídeos para o ecrã inicial cria o projeto |
| `be93c4c` | bug 8: o login voltou a funcionar |
| `b994ea2` | a roda do rato desloca a timeline |
| `adb3d65` | layout do editor: painéis redimensionáveis e modo Focus |

## Decisões

### Editor não destrutivo

- Editar a timeline não gera ficheiros nem gasta quota. Só a exportação cria uma tarefa.
- A tarefa reutiliza a infraestrutura de tarefas que já existia: estados, quota, prioridade, cancelamento e eventos por WebSocket.
- A pré-visualização no browser usa só proxies. O render final usa sempre os originais.

### Modelo de timeline com `link_id`

`projects/models/timeline.js`, um documento por projeto:

```
output: { formato: mp4|mov|avi, qualidade: baixa|media|alta, largura, altura, fit: pad|crop }
faixas: [{ tipo: video|audio, clips: [{ link_id, video_id, in, out, speed, posicao }] }]
version                 // controlo de concorrência
undo, redo              // cópias de {output, faixas}, no máximo 50
```

- `in`/`out` são tempos na origem e `posicao` é o início do clip na timeline, tudo em segundos e arredondado ao milissegundo. `speed` vai de 0,25 a 4.
- **`link_id`:** os clips de vídeo e de áudio com o mesmo `link_id` formam um grupo.
  - Na UI começam ligados: as operações aplicam-se ao grupo, com ripple em todas as faixas.
  - O menu de contexto tem Unlink/Link. Desligados, cada faixa edita-se à parte; os buracos saem a preto ou em silêncio no render.
  - Ao dividir, as segundas metades ficam com um `link_id` novo, partilhado entre elas.
- **Uma faixa por tipo:** o `validateTimeline` aceita no máximo uma faixa de vídeo e uma de áudio. O render junta as duas, sem sobrepor imagens nem misturar áudio. O schema aceitaria mais.
- **API** (`projects/routes/videos.js`, também exposta no gateway):
  - `GET/PUT /projects/:user/:project/timeline`;
  - `POST .../timeline/undo` e `.../timeline/redo`;
  - `POST .../timeline/export`.

  A versão vai no corpo: sem versão responde 428, com uma versão desatualizada 409 `version_conflict`, e com uma timeline inválida 422. Apagar um vídeo usado na timeline responde 409 `video_in_timeline`.
- **Frontend:**
  - `frontend/lib/timeline.ts` tem as operações puras (split, remove com ou sem ripple, trim, setSpeed, move, unlink/link, inserir);
  - `hooks/use-timeline.ts` grava as edições em fila e de forma otimista;
  - os componentes estão em `components/videos/`;
  - layout (`adb3d65`):
    - painéis redimensionáveis (`components/ui/resizable.tsx`, react-resizable-panels 2.1.7) em %, com os mínimos em px do conteúdo convertidos em % do espaço medido; os tamanhos ficam no localStorage;
    - a barra lateral começa recolhida no editor e volta ao estado anterior ao sair;
    - a timeline começa com ~40 % da altura, sem passar do que as faixas no máximo precisam (V1 64–128 px, A1 48–96 px);
    - modo Focus (F) e Ctrl+B para a barra lateral.
- A timeline foi escrita de raiz, com pointer events e componentes da casa. A react-timeline-editor foi avaliada e rejeitada:
  - não tem in/out de origem, `link_id` nem ripple;
  - altera as ações diretamente, antes do `onChange`;
  - tem uma paleta fixa e manutenção fraca.

### Um só motor de render

`Tools/video_render` (`renderer.py`, `preview.py`, `video_render.py`) faz tudo com um só encode do ffmpeg:
- **Entradas:** um `-ss/-t/-i` por clip. Um `split` sobre uma só entrada guardava GB de fotogramas em memória.
- **Fronteiras:** os limites de cada segmento são arredondados à grelha de fotogramas de saída, para o áudio e o vídeo não se desfasarem de clip para clip.
- **Filtros:** `trim`/`atrim`, `setpts` com a cadeia `atempo` para a velocidade, `scale` + `pad` ou `crop` para o reenquadramento, e um `concat` por faixa. Os buracos ficam a preto ou em silêncio.
- **fps:** é o do primeiro clip de vídeo.
- **Timeout:** `max(900 s, 2 × duração final)`.
- **Ligação:** o worker confirma a mensagem só no fim. Numa falha de ligação não faz ack nem apaga ficheiros, e volta a ligar-se com espera crescente.
- **O que saiu:** o corte antigo (`/cut`, `Tools/video_cut`, `video_cut_queue`) foi removido. Um corte agora é uma timeline exportada.

### Proxies

- No upload, o `projects` envia um pedido `video_prepare`. O worker faz uma só passagem do ffmpeg, com três saídas guardadas no SeaweedFS ao lado do original:
  - um proxy H.264 de 480p com GOP de 0,5 s;
  - um `sprite.jpg` de miniaturas;
  - um `waveform.json`.
- Há dois serviços com a mesma imagem e filas separadas: `video_render_tool` (`video_render_queue`) e `video_prepare_tool` (`video_prepare_queue`). Assim os proxies nunca esperam por um render longo.
- `Video.preview.state` passa por `pending`, depois `ready` ou `failed`.
  - `POST /videos/:video/preview` volta a gerar a pré-visualização; na UI é o botão Retry.
  - No arranque do `projects`, as que ficaram `pending` voltam a ser pedidas.
- O resultado de uma exportação também recebe proxy.

### Regras de exportação por perfil

`checkExportLimits` em `projects/utils/video.js`. Cada regra responde 422 com um código próprio, e a UI avisa antes de desativar o Export.

| Regra (código) | Registado | Premium |
|---|---|---|
| Duração mínima (`result_too_short`) | ≥ 5 s | ≥ 5 s |
| Duração final (`duration_limit`) | ≤ 10 min | sem limite |
| Resolução (`resolution_limit`) | ≤ 1080p (lado maior ≤ 1920, lado menor ≤ 1080) | ≤ 4096 |
| Vídeos de origem distintos (`too_many_sources`) | ≤ 5 | ≤ 20 |

- Os anónimos não exportam (403).
- O Registado reserva 1 operação da quota diária, devolvida se a exportação for cancelada ou o projeto apagado. O Premium não gasta quota e tem prioridade 5 na fila (o Registado tem 1).
- Upload até 2 GB.
- O nome do resultado é `<base>_edit[_n].<fmt>`.

### Codec por formato

- **Mesmo formato:** se o formato de saída for o da origem do primeiro clip de vídeo, mantém-se o codec dessa origem (H.264 ou HEVC). Um corte não muda o codec.
- **Formato diferente:** H.264. O áudio é AAC 192k em MP4/MOV e MP3 192k em AVI.
- **AVI:** nunca leva HEVC.
- **CRF por qualidade:** x264 com alta 18, média 23 e baixa 28; x265 com 22, 28 e 32.

## Correções de infraestrutura

- **RabbitMQ:** todos os consumidores voltam a ligar-se sozinhos, com espera crescente de 1 s até 30 s:
  - `wsGateway` (`8dc3f5b`);
  - `projects` (`project_queue` e resultados de vídeo, `c9b0464`; o `send_rabbit_msg` deixou de fazer throw);
  - o worker de vídeo (`8bc5f7c`);
  - as ferramentas de imagem (`9c7b310`).

  As ferramentas de imagem passaram também a confirmar o pedido só depois de enviada a resposta (`31db6f0`, ver o bug 3), e os pedidos e as respostas passaram a ser mensagens persistentes (`b19e63e`, ver o bug 6).
- **nginx** (`5590514`): `resolver 127.0.0.11`, e `proxy_pass` com variável para o frontend, o api_gateway e o ws_gateway. Assim um contentor recriado com outro IP não deixa o nginx a apontar para o antigo. O seaweedfs ficou como estava.
- **SeaweedFS** (`56b0866`): `-master.volumeSizeLimitMB=128` e `WEED_MASTER_VOLUME_GROWTH_COPY_1=1`, ou seja, um volume de 128 MB por bucket (ver o bug 1).

## Estado dos bugs do `e2e/REPORT.md`

| # | Bug | Estado |
|---|---|---|
| 1 | Contas novas deixam de conseguir enviar ficheiros (SeaweedFS sem volumes) | Corrigido com configuração (`56b0866`); validado com 100 contas novas |
| 2 | No editor de vídeo não dá para apagar o projeto pela barra lateral | Corrigido (`d552ccc`) |
| 3 | Pedidos das ferramentas de imagem perdem-se se a ligação cair a meio | Corrigido (`31db6f0`) |
| 4 | Textos em português na interface em inglês | Corrigido (`b0c1843`) |
| 5 | Botão "…" de cada projeto sem nome acessível | Corrigido (`49e9547`) |
| 6 | Pedidos das ferramentas de imagem perdem-se se o RabbitMQ reiniciar | Corrigido (`b19e63e`); validado com um reinício do RabbitMQ a meio de um pedido |
| 7 | Não dá para criar um projeto a partir de um vídeo (só aceitava imagens) | Corrigido (`2b75488`); encontrado num teste manual |
| 8 | O login falha para todas as contas (vinha da `main`) | Corrigido (`be93c4c`); encontrado num teste manual |

Bug 6: as filas já eram duráveis, mas os pedidos (`projects/utils/rabbit_mq.js`) e as respostas (`Tools/utils/rabbit_mq.py`) saíam como mensagens transitórias, que o broker descarta ao reiniciar. Passaram a ser persistentes, como no caminho do vídeo (`projects/utils/video_msg.js`).

Na revisão do bug 3 confirmou-se que a thread de processamento não chama o pika: as respostas e o `basic_ack` saem da thread da ligação, por isso não é preciso o `add_callback_threadsafe`.

Outras observações do relatório, que não são bugs:
- só há um worker de render, por isso as exportações esperam umas pelas outras;
- a `scale_queue` não tem consumidor.

## Testes

| O quê | Como correr |
|---|---|
| Validação da timeline e limites (`projects/utils/video.test.js`) | `cd projects && npm test` (`node --test`) |
| Operações puras da timeline (`frontend/lib/timeline.test.mjs`, precisa de Node ≥ 22.6) | `docker run --rm -v "$PWD/frontend":/app:ro -w /app node:22-slim node --experimental-strip-types --test lib/timeline.test.mjs` |
| Motor de render (`Tools/video_render/test_renderer.py`, ffmpeg do host) | `cd Tools/video_render && python3 -m unittest test_renderer` |
| `tsc` do frontend | `docker run --rm -v "$PWD/frontend":/src:ro --entrypoint sh picturas-frontend:latest -c 'mkdir /w && cd /w && cp -r /src/. . && rm -rf node_modules && ln -s /usr/src/app/node_modules node_modules && ./node_modules/.bin/tsc --noEmit -p .'` |
| Build do frontend | `docker compose build frontend` |

### E2E (Playwright)

Os testes estão em `e2e/` e correm contra a stack local (`docker compose up -d`, `https://localhost:8080`). Resultado da última corrida (terceira ronda, depois do bug 6): 34 passam, 1 é saltado no Firefox, nenhum falha.
- **Demonstração gravada:** `e2e/demo/demo.spec.ts`, fora da suite. Corre no host com `DISPLAY=:0 npx playwright test -c demo` e grava `~/picturas-demo/demo.webm` (ver o `e2e/REPORT.md`).
- **Fixtures:** `npm run fixtures` gera os vídeos de teste com ffmpeg; não vão para o git.
- **Onde correm:** a suite oficial (Chrome + Firefox) corre na imagem local `picturas-e2e-runner:local`, porque o host não tem o Chrome em `/opt/google/chrome` (`channel: "chrome"`).
  - A imagem é `mcr.microsoft.com/playwright:v1.48.0-jammy` com `npm install` em `/work` e `npx playwright install chrome`.
  - Os testes copiam-se para `/work` dentro do contentor, para não escrever ficheiros como root no repo:

```sh
docker run --rm --network host --ipc=host \
  -v "$PWD/e2e":/src:ro -v /tmp/e2e-out:/out \
  -v /var/run/docker.sock:/var/run/docker.sock -v /usr/bin/docker:/usr/bin/docker:ro \
  picturas-e2e-runner:local sh -c '
    cd /work && cp -r /src/tests /src/fixtures /src/playwright.config.ts .
    npx playwright test; s=$?
    cp -r playwright-report test-results /out/; exit $s'
cp -r /tmp/e2e-out/playwright-report /tmp/e2e-out/test-results e2e/   # para abrir o relatório no host
```

- **Docker do anfitrião:** alguns testes precisam dele (reiniciar o RabbitMQ, ler logs, alterar o Mongo). Correm um de cada vez (`workers: 1`).
- **Vídeo e trace:** todos os testes gravam os dois (`video: "on"`, `trace: "on"`).
- **Abrir o relatório no host:**

```sh
cd e2e
PATH=~/.local/opt/node-v22.23.3-linux-x64/bin:$PATH npx playwright show-report
PATH=~/.local/opt/node-v22.23.3-linux-x64/bin:$PATH npx playwright show-trace test-results/<pasta-do-teste>/trace.zip
```

`playwright-report/`, `test-results/` e `node_modules/` estão no `.gitignore` de `e2e/`. O relatório da última corrida já está copiado para `e2e/`.

## Ferramentas no host

- O sistema tem Node 18.19 **sem npm**, e o `sudo` pede senha. Tudo o que foi instalado ficou só para o utilizador, **fora do PATH**:
  - **Node 22.23.3 com npm:** `~/.local/opt/node-v22.23.3-linux-x64/bin`. Para o usar: `PATH=~/.local/opt/node-v22.23.3-linux-x64/bin:$PATH`.
  - **Google Chrome 155,** extraído do `.deb` oficial sem o instalar: `~/.local/opt/google-chrome-deb/opt/google/chrome/chrome`.
- **Playwright no host:** `e2e/node_modules` (Playwright 1.48), com o Firefox e o ffmpeg do Playwright (o ffmpeg é preciso para gravar vídeo) em `~/.cache/ms-playwright`.
- **Playwright MCP:** `@playwright/mcp@0.0.83`, registado com `claude mcp add --scope local`.
  - Fica em `~/.claude.json`, neste projeto, e não no repo.
  - Usa esse Chrome com `DISPLAY=:0.0`, por isso o browser fica visível. As ferramentas só aparecem numa sessão nova do Claude Code.
  - Remove-se com `claude mcp remove playwright -s local`.
- **Contas de teste:** ficaram contas `@test.local` na base de dados local, incluindo as 100 da validação do bug 1.

## Regras de trabalho

- **Git:**
  - Nada de push, PR nem merge sem o utilizador pedir.
  - Um commit por fase ou por correção, com o número da fase ou do bug na mensagem; no fim, parar para revisão.
  - Não mexer em `origin` (picturas-um/picturas-27).
- **Bugs encontrados em testes:** não se corrigem sem perguntar primeiro.
- **Skills:**
  - **ponytail** ao programar: a mudança mínima completa, sem código extra (`/ponytail-review` para reviews e `/ponytail-audit` para auditorias);
  - **rtk:** funciona sozinho pelo hook;
  - **graphify:** consultar o grafo (`graphify query`/`path`/`explain`) antes de procurar ficheiros um a um.
- **UI:**
  - em inglês;
  - componentes shadcn/ui de `components/ui` e variáveis do tema, com dark mode;
  - nada de paletas novas nem estilos inline (`style` só para geometria calculada em runtime, como a posição dos clips e do playhead).
- **Comentários no código:** em português.
- **Repo:**
  - nada de código, testes ou ficheiros que não tenham sido pedidos;
  - os ignores de ferramentas locais vão para `.git/info/exclude`.
- **Prioridades:** a experiência do utilizador vem primeiro. Segurança não é prioridade, mas não se removem proteções que já existem.
