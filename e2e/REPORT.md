# Testes E2E do editor de vídeo: relatório

Ronda de testes com Playwright no branch `feature/timeline`, a 15/10/2026, contra a stack local (`docker compose`), em Google Chrome 155 e no Firefox do Playwright 1.48.

## Resultado

**34 testes passam e 1 falha de propósito** (marcado com `test.fail`): é o bug 2, que fica documentado. 1 teste é saltado no Firefox.

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
| Apagar o projeto com uma exportação a decorrer (cancela, devolve a quota, o worker para) | `quota.spec.ts` | ✓ | — |
| Apagar o projeto pela barra lateral dentro do editor | `quota.spec.ts` | ✘ bug 2 | — |
| Undo/redo (botões, teclado, depois de recarregar a página) | `history.spec.ts` | ✓ | ✓ |
| Unlink/Link e edição só do áudio | `history.spec.ts` | ✓ | ✓ |
| "Video in use" ao apagar um vídeo usado na timeline | `history.spec.ts` | ✓ | ✓ |
| Retry de uma pré-visualização falhada | `history.spec.ts` | ✓ | saltado (usa o Docker; basta um browser) |
| Exportação termina depois de reiniciar o RabbitMQ a meio | `resilience.spec.ts` | ✓ | — |

Os testes de backend (limites, quota, resiliência) só correm no Chrome, porque não dependem do browser.

Os resultados vêm de três passagens:
1. **Primeira passagem:** falharam 7 testes por erros meus. 6 eram de seletores: o texto dos toasts está repetido numa região `aria-live` e o Next.js também usa `role="alert"`. O sétimo era o teste de velocidade, que exportava 4 s, abaixo do mínimo de 5 s.
2. **Segunda passagem:** os testes já corrigidos passaram, mas os uploads começaram a falhar por causa do bug 1.
3. **Terceira passagem:** libertei os volumes vazios do SeaweedFS (ver bug 1) e corri os 6 testes em falta, que passaram.

## Bugs encontrados

Ordenados por impacto na experiência do utilizador. Não corrigi nenhum.

### 1. Depois de ~50 contas, as contas novas deixam de conseguir enviar ficheiros (SeaweedFS sem volumes)

**Impacto: crítico.**
- Qualquer conta nova recebe "The video could not be saved. Try again." ao enviar um vídeo. As imagens usam o mesmo storage, por isso o mais provável é falharem também (não testei).
- As contas antigas continuam a funcionar, por isso é fácil o problema passar despercebido.
- Tentar outra vez não resolve.

**Passos para reproduzir:**
1. Com a stack a correr, criar contas novas e, em cada uma, enviar um vídeo. Por exemplo, correr esta suite duas vezes, porque cada teste cria a sua conta.
2. Por volta da 54.ª conta com ficheiros, o upload responde `500 storage_error`.
3. Log do `seaweedfs`: `No writable volumes and no free volumes left for {"collection":"user-…"}`.
4. `docker exec picturas-seaweedfs-1 sh -c 'echo volume.list | weed shell -master=localhost:9333' | head -1` mostra `volume:375/375 … free:0`, com só **169 MB** de dados.

**Causa:**
- Cada utilizador tem um bucket próprio (`user-<id>`), que no SeaweedFS é uma *collection*.
- Cada collection reserva logo 7 volumes de 1 GB (`-master.volumeSizeLimitMB=1024`).
- O servidor tem `free disk / 1 GB` ≈ 375 espaços. 60 collections esgotaram-nos.

**Correções possíveis (não aplicadas):**
- Reduzir o crescimento por collection: `master.toml`, `[master.volume_growth] copy_1 = 1`.
- Volumes mais pequenos: `-master.volumeSizeLimitMB`.
- Um só bucket com prefixos por utilizador.

**O que fiz no ambiente local:** para acabar a ronda, corri `volume.deleteEmpty`, que só apaga volumes sem ficheiros. Libertou 89 espaços, mas é um paliativo e o problema volta.

### 2. No editor de vídeo não dá para apagar o projeto pela barra lateral

**Impacto: alto.**
- A confirmação fica aberta e o projeto não é apagado.
- Aparece um aviso em português a pedir para "abrir o projeto", que já está aberto.

**Passos para reproduzir:**
1. Abrir um projeto e carregar em **Video editor** (`/dashboard/<id>/videos`).
2. Na barra lateral, no menu **…** do projeto, escolher **Delete** e depois **Permanently Delete**.
3. Esperado: o projeto é apagado e a página volta para `/dashboard`.
4. Obtido: o toast "Não foi possível obter a versão do projeto — Abre o projeto primeiro (ou aguarda carregar) e tenta novamente." e a janela continua aberta. A partir da página do projeto funciona.

**Causa:**
- `components/dashboard-sidebar/project-item.tsx` lê a versão do projeto da cache com a chave `["project", uid, pid, token, ownerId, shareId]`, onde `ownerId` é o próprio utilizador.
- A página do editor carrega o projeto com `useGetProject(uid, pid, token)`, sem `ownerId`.
- A chave não coincide e a versão vem `undefined`.

Teste: `quota.spec.ts`, "deleting the project from the sidebar while in the video editor" (marcado com `test.fail`).

### 3. Pedidos das ferramentas de imagem perdem-se se a ligação ao RabbitMQ cair a meio

**Impacto: médio.** Encontrado ao rever o código na correção da religação; **não foi reproduzido nestes testes** (a suite só cobre o editor de vídeo).
- As ferramentas de imagem consomem com `auto_ack=True` (`Tools/utils/rabbit_mq.py`): o pedido é confirmado logo que chega.
- Se a ligação cair durante o processamento, a ferramenta volta a ligar-se, mas o resultado não chega a ser enviado e o pedido não volta à fila.
- Resultado provável: o processamento do projeto fica preso.

**Passos para reproduzir (esperados):**
1. Aplicar uma ferramenta lenta (por exemplo, uma das de IA) a um projeto de imagens.
2. Durante o processamento, correr `docker restart picturas-rabbitmq-1`.
3. O processamento não termina.

O worker de vídeo já confirma só no fim, e foi por isso que a exportação sobreviveu ao reinício.

### 4. Textos em português na interface em inglês

**Impacto: baixo.**
- Na barra lateral aparece "Operações diárias restantes" (`components/operations-counter.tsx`).
- O toast do bug 2 também está em português.
- No resto, a aplicação está em inglês.

### 5. O botão "…" de cada projeto na barra lateral não tem nome acessível

**Impacto: baixo, acessibilidade.**
- O `SidebarMenuAction` em `project-item.tsx` só tem o ícone, por isso um leitor de ecrã anuncia apenas "button".
- Os testes tiveram de o encontrar pela posição dentro do item do projeto.

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
- Cada teste cria a sua conta. Por causa do bug 1, correr a suite muitas vezes na mesma stack acaba por esgotar o storage.
- Outra URL: `BASE_URL=https://… npm test`.
