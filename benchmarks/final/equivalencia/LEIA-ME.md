# Comparação de saídas: worker único (base) e serviços de vídeo (final)

Evidência complementar de preservação funcional, obtida no ambiente do agente de IA
(Linux, ffmpeg e Pillow, sem Docker nem RabbitMQ) a 15 nov 2026.

`comparar_saidas.py` executa os mesmos 40 casos nas duas versões do código de
`Tools/video`: 10 pipelines × 2 vídeos de teste (MP4 com som, MOV sem som) × processamento
completo e pré-visualização. O reconhecimento de fala é simulado com as mesmas duas frases.
Para cada caso regista duração, dimensões, MD5 dos fotogramas descodificados, MD5 do ficheiro,
fotogramas extraídos, ficheiros deixados na pasta de saída e progresso.

| Ficheiro | Conteúdo |
|---|---|
| `saidas-base.json` | commit base `0523102`, `process_video` do worker único |
| `saidas-base-repeticao.json` | segunda execução da base, para medir a variação entre execuções |
| `saidas-final.json` | código refatorado: plano de etapas + executor de etapas + os três serviços |

Resultado: 39 dos 40 casos dão saídas idênticas byte a byte nas duas versões (27 vídeos
e 12 conjuntos de fotogramas ou folhas de contacto). O caso restante
(`mov-sub_trim-pv`: pré-visualização de legendas seguidas de corte, vídeo sem som) varia
de execução para execução já na base (`saidas-base.json` difere de
`saidas-base-repeticao.json` nesse caso), pelo que não distingue as versões; numa das
execuções do código final a saída coincidiu com a da base. A única diferença sistemática
é o número de eventos de progresso (mais ou menos 1 a 2 por caso); a sequência continua
crescente e termina em 100.

Para repetir: `python comparar_saidas.py old <Tools/video da base> a.mp4 b.mov <pasta>` e
`python comparar_saidas.py new <Tools/video atual> a.mp4 b.mov <pasta>`, com dois vídeos
gerados por ffmpeg (`testsrc` 320x240 25 fps 4 s com `sine`; `testsrc2` 322x200 30 fps 5 s).
