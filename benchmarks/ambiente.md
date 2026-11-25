# Ambiente das medições — Fase 2

Condições em que foram obtidos os resultados de `baseline/` e `final/`, para que as medições
possam ser repetidas. Os valores vêm dos ficheiros `estatico-*.json` (gerados por
`scripts/static_metrics.py`) e dos campos `params` dos ficheiros `bench-*.json`.

## Máquina

| | Valor |
|---|---|
| Sistema operativo | Windows 11 (`Windows-11-10.0.26300-SP0`), AMD64 |
| Processador | Intel64 Family 6 Model 186 (16 CPU lógicos) |
| Docker | Docker Desktop, Engine 29.9.3, Compose 5.7.0 |
| Recursos atribuídos ao Docker | 16 CPU e 8,1 GB de RAM (8 107 233 280 bytes) |
| Energia | ligado à corrente nas duas medições; na final, modo de energia "Melhor desempenho" |
| Python (scripts) | 3.14.6 |

A baseline e a medição final foram feitas na **mesma máquina**, com os mesmos recursos
atribuídos ao Docker.

## Dependências dos scripts

`scripts/requirements.txt`. Versões instaladas no ambiente das medições:

| Pacote | Versão |
|---|---|
| `requests` | 2.34.2 |
| `python-socketio[client]` | 5.18.1 (`python-engineio` 4.15.1, `websocket-client` 1.9.2) |
| `radon` | 6.0.1 |

Também é preciso ter `docker` e `git` no `PATH`. O `ffprobe` é opcional: sem ele, os scripts usam o
do contentor `projects`.

## Versões do código medidas

| Medição | Código | Serviços de vídeo |
|---|---|---|
| Baseline (15 nov 2026) | commit base `052310226c51fa57a17101c7bd1ad795674aac95` (`upstream/main`), sem alterações | `video_tool` × 1 |
| Final (17 nov 2026) | refactoring dos commits `16f87d3`, `d7cb6b3` e `9e4108b` do ramo `fase2` (medido sobre a cópia de trabalho antes do commit, por isso os JSON registam o commit base com 16 ficheiros alterados) | `video_router` × 1, `video_edit_tool` × 4, `video_subtitles_tool` × 1, `video_extract_tool` × 1 |
| Correções (18 nov 2026) | commit `43657b3` do ramo `fase2` | os mesmos |

Depois das correções de 18 nov foram repetidas a regressão (`final/regressao-resultado-20261118-174151.json`)
e as métricas do código (`final/estatico-final-correcoes.json`). As medições de desempenho de 17 nov
continuam válidas, porque as correções não alteram o processamento (ver `comparacao-baseline-final.md`).

## Parâmetros das medições de desempenho

Iguais na baseline e na medição final (`bench.py`):

| Parâmetro | Valor | Significado |
|---|---|---|
| `--runs` | 5 | execuções por cenário; o valor reportado é a mediana |
| `--heavy-seconds` | 60 | a legendagem do cenário S2 usa só o primeiro minuto do vídeo longo |
| `--delay` | 5 | segundos entre o pedido de legendas e o lote leve no cenário S2 |

Vídeos de teste: `samples/video/` do próprio repositório.

| Medição | Início | Fim | Ficheiro |
|---|---|---|---|
| Baseline | 15 nov 2026, 18h30 UTC | 18h45 UTC | `baseline/bench-baseline-20261115-183005.json` |
| Final | 17 nov 2026, 14h06 UTC | 14h18 UTC | `final/bench-final-corrente-20261117-140651.json` |

## Condições para repetir

1. Mesma máquina (ou registar a nova com `static_metrics.py`), ligada à corrente, sem outras
   aplicações pesadas abertas.
2. Mesmos recursos atribuídos ao Docker Desktop.
3. Arrancar com `docker compose up -d --build --remove-orphans` e confirmar com `docker compose ps`
   o número de réplicas indicado acima. Um `video_tool` antigo ainda a correr falseia as medições
   (foi o que invalidou as medições de `final/invalido-2026-11-17-contentor-antigo/`).
4. Fazer uma legendagem antes de medir, para o modelo Whisper já estar descarregado.
5. Usar os mesmos parâmetros (`--runs`, `--heavy-seconds`, `--delay`).

Os comandos de cada medição estão em `scripts/README.md`.

## Medições excluídas da comparação

| Pasta | Motivo |
|---|---|
| `final/invalido-2026-11-17-contentor-antigo/` | os serviços novos não tinham sido construídos e correu o `video_tool` antigo |
| `final/complementar-bateria-2026-11-17/` | desempenho medido com o portátil em bateria; fica só como evidência complementar |
| `final/equivalencia/` | comparação de saídas feita fora do Docker (Linux, ffmpeg e Pillow), não é uma medição de desempenho |
