# PictuRAS — Fase 2: comparação entre a baseline e a solução final

| | Baseline | Final |
|---|---|---|
| Código | commit `0523102` (worker único `video_tool`) | mesmo commit + refactoring (16 ficheiros alterados, sem commit) |
| Data da medição de desempenho | 15 nov 2026 | 17 nov 2026, 14h06 |
| Serviços de vídeo | `video_tool` × 1 | `video_router` × 1, `video_edit_tool` × 4, `video_subtitles_tool` × 1, `video_extract_tool` × 1 |
| Máquina | Windows 11, 16 CPU e 8,1 GB atribuídos ao Docker, ligado à corrente | a mesma, ligado à corrente, modo de energia "Melhor desempenho" |
| Método | os mesmos scripts (`benchmarks/scripts/`), 5 execuções por cenário, mediana | o mesmo |

Ficheiros usados: `baseline/bench-baseline-20261115-183005.json` e
`final/bench-final-corrente-20261117-140651.json` (desempenho); `final/regressao-resultado-*.json`,
`final/m2-final-*.json`, `final/estatico-final.json`, `final/m1-final.json` (restantes métricas).

Medições que não entram na comparação:

- `final/invalido-2026-11-17-contentor-antigo/`: correram ainda com o `video_tool` antigo.
- `final/complementar-bateria-2026-11-17/`: desempenho medido com o portátil em bateria; fica
  como evidência complementar (ver "Sensibilidade às condições de medição").

Legenda: ✅ alvo atingido · 🟡 abaixo do alvo mas dentro do mínimo aceitável · ❌ abaixo do mínimo aceitável.

## RNF-1 — Manutenibilidade (modularidade) do processamento de vídeo

| Métrica | Baseline | Final | Variação | Alvo | Mínimo | Estado |
|---|---|---|---|---|---|---|
| M1 — ficheiros existentes do worker modificados para acrescentar um efeito | 1 (`effects.py`) | 0 (só `edit/effects/invert.py`, novo) | −1 | 0 | ≤ 1 | ✅ |
| M1b — efeitos de vídeo reimplantados por essa alteração | 12 | 10 (só o serviço de edição) | −17 % | — | — | informativo |
| M2 — efeitos indisponíveis ao parar o serviço de legendas | 100 % (12/12, parar `video_tool`) | 8,3 % (1/12) | −91,7 pp | 8 % | ≤ 17 % | ✅ |
| M2 — efeitos indisponíveis ao parar o serviço de extração | 100 % | 8,3 % (1/12) | −91,7 pp | 8 % | ≤ 17 % | ✅ |
| M2 — efeitos indisponíveis ao parar o serviço de edição | 100 % | 91,7 % (11/12) | −8,3 pp | — | — | informativo |
| M3 — imagem Docker do serviço que aplica efeitos simples | 1691,6 MB | 852,9 MB | −49,6 % | ≤ 846 MB (−50 %) | ≤ 1184 MB | 🟡 |
| M4 — complexidade ciclomática máxima (`Tools/video`) | 22 | 9 | −59 % | ≤ 10 | ≤ 15 | ✅ |
| M4 — funções com complexidade acima de 10 | 6 | 0 | −6 | — | — | informativo |
| M4 — complexidade média | 4,56 (41 funções) | 2,81 (95 funções) | −38 % | — | — | informativo |

## RNF-2 — Eficiência de desempenho (capacidade e comportamento temporal)

| Métrica                                                     | Cenário                                                                 | Baseline                 | Final                    | Variação                       | Alvo     | Mínimo  | Estado           |
| ----------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------ | ------------------------ | ------------------------------ | -------- | ------- | ---------------- |
| P1a — lote leve com uma legendagem a correr                 | S2: legendas num vídeo de 60 s; 5 s depois, 4 vídeos de 10 s com brilho | 60,2 s                   | 16,3 s                   | **−72,9 %** (3,7× mais rápido) | ≤ 19,3 s | ≤ 30 s  | ✅                |
| P1b — rácio entre o lote com legendagem e o lote sozinho    | S2 / S2R                                                                | 3,13                     | 1,73                     | −44,8 %                        | ≤ 1,5    | ≤ 2,0   | 🟡               |
| P2 — débito em lote                                         | S1: 8 vídeos de 10 s                                                    | 12,4 vídeos/min (38,6 s) | 21,7 vídeos/min (22,1 s) | **+74,4 %** (1,74×)            | ≥ 37     | ≥ 18,6  | 🟡               |
| P3 — vídeos processados em simultâneo                       | S1, S2R, S2                                                             | 1                        | 4                        | ×4                             | ≥ 4      | ≥ 2     | ✅                |
| P4 — caso simples                                           | S0: 1 vídeo de 10 s com brilho, sistema em repouso                      | 4,89 s                   | 6,77 s                   | **+38,5 %**                    | ≤ 5,4 s  | ≤ 6,1 s | ❌                |
| Lote de 4 vídeos sozinho                                    | S2R                                                                     | 19,3 s                   | 9,4 s                    | −51,0 %                        | —        | —       | informativo      |
| Trabalho pesado (legendas, vídeo de 60 s)                   | S2, utilizador X                                                        | 46,2 s                   | 49,1 s                   | +6,3 %                         | —        | —       | efeito colateral |
| Todos os 12 efeitos pedidos ao mesmo tempo (controlo de M2) | 12 projetos, 1 efeito cada                                              | 89,2 s                   | 46,2 s (em bateria)      | −48 %                          | —        | —       | informativo      |

Variação entre execuções (mín.–máx.): S0 6,49–7,99 s (base 4,60–4,95); S1 21,5–23,2 s
(base 38,2–39,8); S2R 9,19–10,81 s (base 19,0–19,4); S2 14,8–17,8 s (base 57,9–62,7). As
diferenças entre a base e a solução final são muito maiores do que a variação dentro de cada uma.

## Sensibilidade às condições de medição

A medição final foi feita duas vezes com os contentores novos: em bateria (11h41) e ligado à
corrente (14h06). Só a segunda tem as mesmas condições da baseline e é a que conta.

| Cenário | Baseline (corrente) | Final em bateria | Final à corrente |
|---|---|---|---|
| S0 — caso simples | 4,89 s | 6,85 s | 6,77 s |
| S1 — débito em lote | 12,4 vídeos/min | 24,4 vídeos/min | 21,7 vídeos/min |
| S2R — lote de 4 sozinho | 19,3 s | 10,0 s | 9,4 s |
| S2 — lote de 4 com legendagem | 60,2 s | 17,6 s | 16,3 s |
| Trabalho pesado (legendas) | 46,2 s | 64,5 s | 49,1 s |

A bateria explicava quase todo o atraso do trabalho de legendas (64,5 s em bateria, 49,1 s à
corrente), mas **não explica o atraso do caso simples** (6,85 s contra 6,77 s). O débito em lote
foi um pouco mais alto em bateria do que à corrente, o que indica que P2 tem uma variação entre
sessões de cerca de 10 %, maior do que a variação dentro de cada sessão.

## Preservação funcional

| Verificação | Baseline | Final | Estado |
|---|---|---|---|
| Regressão ponta a ponta (`regression.py`, 44 casos: imagem, vídeo, legendas, extração, pré-visualização, erros) | referência gravada | **44/44 passam**, sem avisos: resultados de vídeo com os mesmos bytes que na base, mesmos códigos e mensagens de erro | ✅ |
| Testes automáticos de `Tools/video` | 74 | 112 (74 da base + 38 novos, incluindo 12 das correções de 18 nov) | ✅ (na cópia do agente) |
| Comparação de saídas fora do Docker (40 casos) | — | 39 idênticas; 1 varia já entre execuções da base | ✅ |

**Correções de 18 nov.** Depois destas medições foram feitas duas correções (validação antecipada
do pipeline e tratamento de mensagens reentregues; commit `43657b3` do ramo `fase2`). Não
alteram o processamento: a comparação de saídas com a base nos 40 casos deu resultados idênticos.
A regressão ponta a ponta foi repetida a 18 nov com as imagens reconstruídas: 44/44, com resultados
idênticos aos de 17 nov. As medições de desempenho continuam válidas. A complexidade máxima medida
passou de 9 para 8.

## Efeitos colaterais noutros atributos

| Atributo | Baseline | Final | Leitura |
|---|---|---|---|
| Contentores de vídeo | 1 | 7 | Mais processos a gerir e a monitorizar |
| Espaço total das imagens de vídeo | 1691,6 MB | 3596,1 MB (router 205,9 + edição 852,9 + extração 852,8 + legendas 1684,5) | 2,1× mais disco pela soma; as camadas comuns (Python, ffmpeg) são partilhadas entre imagens, por isso o espaço real é menor |
| Linhas de código de `Tools/video` (sem testes) | 651 | 907 (antes das correções de 18 nov) | +39 %: mais módulos, funções mais pequenas |
| Latência de um vídeo isolado | 4,89 s | 6,77 s | Piorou (ver análise) |
| Fiabilidade (tolerância a falhas) | etapa única: uma reentrega só repetia o trabalho | etapas encadeadas: uma reentrega podia duplicar etapas | Detetado na revisão do grupo e corrigido a 18 nov (ficheiro `.claim` por etapa; resposta antes da limpeza) |
| Duração do trabalho pesado sob carga | 46,2 s | 49,1 s | Ligeiramente pior (+6 %): as legendas partilham a CPU com 4 edições em paralelo e têm peso de CPU reduzido |

## Análise

**O que melhorou.** Os dois objetivos centrais foram atingidos. Um pedido de legendas deixou
de bloquear os outros utilizadores: o mesmo lote leve passou de 60,2 s para 16,3 s, abaixo do
tempo que esse lote demorava sozinho na base (19,3 s), e o próprio trabalho de legendas só
ficou 6 % mais lento. O sistema passou a processar 4 vídeos em simultâneo em vez de 1 e o débito
em lote subiu 74 %. Do lado da manutenibilidade, acrescentar um efeito já não toca em nenhum
ficheiro existente, parar o serviço de legendas ou o de extração deixa os outros 11 efeitos a
funcionar, e a complexidade máxima desceu de 22 para 9. A regressão ponta a ponta passou nos
44 casos.

**O que não foi atingido e porquê.**

- **P4 (caso simples) piorou 38,5 % e fica abaixo do mínimo aceitável.** Cada vídeo isolado
  demora cerca de 6,3 s a processar no serviço de edição, contra 4,0–4,3 s no `video_tool`, e
  mais cerca de 0,15 s até começar, pelo salto extra pelo `video_router`. Hipóteses verificadas e
  afastadas: (1) a lógica de processamento — o mesmo código, fora do Docker, demora o mesmo nas
  duas versões (3,6 s num vídeo 720p de 10 s); (2) o portátil em bateria — à corrente o resultado
  é o mesmo (6,77 s contra 6,85 s); (3) o dia ou o estado da máquina — na mesma manhã, à corrente,
  o `video_tool` antigo fez o mesmo cenário em 4,98 s. O atraso está portanto na implantação do
  serviço de edição. A hipótese que falta verificar é a imagem Docker (imagem base ou versão do
  ffmpeg), com a medição do mesmo vídeo dentro das duas imagens.
- **P2 ficou em 1,74× em vez de 3×.** Com 4 vídeos em paralelo, cada um demora cerca de 10 s em
  vez de 4,2 s: as 4 réplicas disputam a CPU e a memória atribuídas ao Docker (8 GB), e a
  lentidão de cada vídeo isolado (P4) também entra aqui. O ganho é limitado pelos recursos e não
  pelo número de réplicas.
- **P1b (rácio) ficou em 1,73 em vez de 1,5**, porque o lote sozinho também ficou mais rápido
  (o denominador desceu de 19,3 para 9,4 s). Em valor absoluto (P1a) o alvo foi cumprido.
- **M3 ficou a 7 MB do alvo** (−49,6 % em vez de −50 %).

**Compromisso assumido.** Os trabalhos leves passaram a ter prioridade sobre as legendas. Na
medição à corrente o custo para quem pede legendas é pequeno (+6 %); em bateria, com menos CPU
disponível, chegou a +40 %.

**Trabalho futuro.** Identificar a causa do atraso do caso simples; escalonamento automático das
réplicas em função da profundidade das filas (elasticidade, não implementada); ajustar o número
de réplicas aos núcleos disponíveis.
