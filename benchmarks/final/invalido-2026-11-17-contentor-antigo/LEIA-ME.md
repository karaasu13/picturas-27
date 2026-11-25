# Medições de 17 nov 2026: inválidas como "final"

Estas medições foram feitas com o código novo no disco, mas com os contentores antigos a correr.
Não servem para comparar com a baseline.

Evidência, nos próprios ficheiros:

- `estatico-final.json`: o único serviço de vídeo a correr era `video_tool` (1 réplica) e a
  única imagem de vídeo era `picturas-video_tool` (1691,6 MB), a mesma da baseline.
- `bench-final-*.json`: em todas as amostras do RabbitMQ só existe a fila `video_queue`, com
  1 consumidor; as filas `video_edit_queue`, `video_subtitles_queue` e `video_extract_queue`
  nunca aparecem. Paralelismo máximo 1 em todos os cenários.
- `m2-final-video_edit_tool.json` e os outros: parar os serviços novos não afetou nenhum
  efeito, porque esses serviços não estavam a correr e era o `video_tool` antigo que
  processava tudo. Os tempos de conclusão crescem de ~10 s em ~10 s, como na baseline
  (processamento em série).

Os valores obtidos (S0 4,98 s; S1 12,5 vídeos/min; S2 66,4 s; regressão 44/44) são, na
prática, uma segunda medição da base. Podem servir para mostrar a variação entre execuções
da base no mesmo ambiente.

A única métrica válida deste conjunto é a complexidade (M4) de `estatico-final.json`, porque
é calculada a partir dos ficheiros do disco e não dos contentores: máx. 9, média 2,81,
0 funções acima de 10, 95 funções.
