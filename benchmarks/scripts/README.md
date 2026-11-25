# Scripts de medição e de regressão — Fase 2

Os mesmos scripts correm **antes** (commit base) e **depois** do refactoring, sem alterações:
falam só com a entrada pública da aplicação (`https://localhost:8080`) e com a API de
gestão do RabbitMQ (`http://localhost:15672`).

> **Estado:** os scripts correram contra a aplicação real na baseline de 15 nov 2026
> (resultados em `../baseline/`).

## Requisitos

- Aplicação a correr: `docker compose up -d --build` na raiz do repositório.
- Python 3.10 ou superior, e as dependências:

```powershell
cd benchmarks\scripts
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

- `docker` e `git` no PATH. O `ffprobe` é opcional: se não existir na máquina, os scripts
  usam o do contentor `projects`.
- Os scripts assumem que correm a partir de `benchmarks/scripts/` dentro do repositório
  (senão, `--repo <caminho>`). O ambiente das medições está em `../ambiente.md`.

## Ordem de execução da baseline (commit base, sem alterações)

| # | Comando | Mede | Duração aproximada |
|---|---|---|---|
| 1 | `python static_metrics.py --label baseline --out ../baseline` | ambiente, M3, M4 | segundos |
| 2 | `python bench.py --label fumo --runs 1 --scenarios S0 --out ../baseline` | teste de fumo | 1 min |
| 3 | `python regression.py record --out ../baseline` | referência de regressão (44 casos) | 20–40 min |
| 4 | `python bench.py --label baseline --runs 5 --out ../baseline` | P1 a P4 | 30–90 min |
| 5 | `python availability.py --label baseline-controlo --out ../baseline` | controlo de M2 (tudo a correr) | 3–10 min |
| 6 | `python availability.py --stop video_tool --label baseline --out ../baseline` | M2 | 10 min |
| 7 | `change_impact.py` (ver abaixo) | M1 | manual |

## Medições finais (depois do refactoring)

Reconstruir primeiro com `docker compose up -d --build --remove-orphans` na raiz do repositório.
O `--remove-orphans` é obrigatório: o contentor antigo `video_tool`, se ficar a correr,
continua a consumir a `video_queue` e falseia as medições. Confirmar com `docker compose ps`
que existem `video_router` (1), `video_edit_tool` (4), `video_subtitles_tool` (1) e
`video_extract_tool` (1).

```powershell
python bench.py --label fumo-final --runs 1 --scenarios S0 --out ../final
python regression.py check --ref ../baseline/regressao-referencia.json --out ../final
python static_metrics.py --label final --out ../final
python bench.py --label final --runs 5 --out ../final --note "4 replicas de edicao"
python availability.py --label final-controlo --out ../final
python availability.py --stop video_subtitles_tool --label final --out ../final
python availability.py --stop video_extract_tool --label final --out ../final
python availability.py --stop video_edit_tool --label final --out ../final
```

Para medir P2 com outro número de réplicas: `VIDEO_EDIT_REPLICAS=2` num ficheiro `.env` em
na raiz do repositório, `docker compose up -d`, e
`python bench.py --label final-2replicas --runs 5 --scenarios S1 --out ../final`.

O M1 das duas versões já está medido (`baseline/m1-baseline.json`, `final/m1-final.json`);
`change_impact.py` serve para o repetir a partir de commits.

## O que cada script faz

### `bench.py` — desempenho (RNF-2)

| Cenário | Carga | Métrica |
|---|---|---|
| S0 | 1 vídeo de 10 s com brilho, sistema em repouso | P4, caso simples |
| S1 | 8 vídeos de 10 s com brilho, mesmo projeto | P2 (vídeos/min), P3 |
| S2R | 4 vídeos de 10 s com brilho, sem mais carga | referência de P1 |
| S2 | utilizador X pede legendas num vídeo longo; 5 s depois, utilizador Y processa os 4 vídeos de S2R | P1 |

- O tempo vai do `POST .../process` até ao último evento de conclusão (Socket.IO).
- `P1_ratio` = mediana de S2 / mediana de S2R.
- P3 é medido de duas formas: sobreposição dos intervalos de progresso de cada vídeo
  (`P3_max_parallel_progress`) e mensagens por confirmar no RabbitMQ (`P3_max_unacked_rabbitmq`,
  com atraso de cerca de 5 s nas estatísticas).
- `--heavy-seconds 60` (por omissão) legenda só o primeiro minuto do vídeo de 177 s, para a
  medição não demorar horas; `--heavy-seconds 0` usa o vídeo inteiro. Usar o mesmo valor
  na baseline e na medição final.
- `--note "2 réplicas de edição"` regista a configuração no ficheiro de resultados.
- Na primeira legendagem o modelo Whisper é descarregado: correr uma vez o caso
  `python regression.py record --only sub-no-speech --out ../baseline` antes de medir.

### `regression.py` — preservação funcional

44 casos: 9 de imagem, 16 de vídeo (cada efeito, encadeamentos, MOV, projetos mistos),
3 de legendas, 3 de extração de fotogramas, 4 de pré-visualização e 9 de erro.
`python regression.py list` mostra-os; `--only vid-,err-` corre só alguns.
As ferramentas de IA de imagem não são exercitadas (não são tocadas e demoram muito).

Depois de gravar a referência, confirmar que nenhum caso ficou em `timeout` ou
`script-error` (o script avisa): esses casos não servem de referência.

### `availability.py` — acoplamento de implantação (M2)

Pára o serviço indicado, submete um vídeo por cada um dos 12 efeitos e conta os que não
concluem. Volta a arrancar o serviço no fim. Os trabalhos que ficaram na fila são
processados quando o serviço volta; esperar que terminem antes de outra medição.

### `static_metrics.py` — ambiente, M3 e M4

Regista máquina, versões, commit, réplicas dos serviços de vídeo, tamanho das imagens
Docker de vídeo, complexidade ciclomática (radon) e linhas de código de `Tools/video`.

### `change_impact.py` — impacto de alteração (M1)

Cenário de alteração: acrescentar ao vídeo o efeito por fotograma `invert` (inverter cores).

```powershell
cd ..\..
git checkout -b m1-invert 052310226c51fa57a17101c7bd1ad795674aac95
# ... acrescentar o efeito e fazer commit ...
cd benchmarks\scripts
python change_impact.py --base 052310226c51fa57a17101c7bd1ad795674aac95 --label baseline --out ../baseline
```

O valor de M1 é `M1_worker_existing_files_modified`. O ramo `m1-invert` não faz parte da
entrega. Depois do refactoring repete-se a partir do commit final.

## Condições para as medições serem comparáveis

- Mesma máquina, ligada à corrente, sem outras aplicações pesadas.
- Mesmos recursos atribuídos ao Docker Desktop (registados por `static_metrics.py`).
- Sistema em repouso antes de cada cenário (o `bench.py` espera que as filas esvaziem).
- Mesmos parâmetros (`--runs`, `--heavy-seconds`, `--delay`).
- Os scripts criam contas premium de teste (`bench-...@picturas.test`) e apagam-nas no fim.

## Variáveis de ambiente

| Variável | Valor por omissão |
|---|---|
| `PICTURAS_URL` | `https://localhost:8080` |
| `PICTURAS_RABBIT_API` | `http://localhost:15672/api` |
| `PICTURAS_RABBIT_USER` / `PICTURAS_RABBIT_PASS` | `user` / `password` |
