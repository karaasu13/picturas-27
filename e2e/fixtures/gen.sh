#!/bin/sh
# Gera os vídeos usados nos testes (baixa resolução, ffmpeg testsrc + sine).
# Não vão para o git: correr antes dos testes (npm run fixtures).
set -e
cd "$(dirname "$0")"

ff() { ffmpeg -hide_banner -loglevel error -y "$@"; }
h264="-c:v libx264 -preset ultrafast -pix_fmt yuv420p"

# MP4 H.264 + AAC, 8 s
ff -f lavfi -i testsrc=size=320x240:rate=25:duration=8 -f lavfi -i sine=frequency=440:duration=8 $h264 -c:a aac -shortest a.mp4
# Outra origem MP4, 6 s
ff -f lavfi -i testsrc=size=320x240:rate=25:duration=6 -f lavfi -i sine=frequency=880:duration=6 $h264 -c:a aac -shortest b.mp4
# MP4 sem áudio, 6 s
ff -f lavfi -i testsrc=size=320x240:rate=25:duration=6 $h264 mute.mp4
# MOV H.265 + AAC, 6 s (não toca na maioria dos browsers: a pré-visualização usa o proxy)
ff -f lavfi -i testsrc=size=640x360:rate=25:duration=6 -f lavfi -i sine=frequency=300:duration=6 \
  -c:v libx265 -preset ultrafast -pix_fmt yuv420p -x265-params log-level=error -tag:v hvc1 -c:a aac -shortest hevc.mov
# AVI H.264 + MP3, 5 s a 30 fps
ff -f lavfi -i testsrc=size=320x240:rate=30:duration=5 -f lavfi -i sine=frequency=660:duration=5 $h264 -c:a libmp3lame -shortest clip.avi
# 11 min (limite de 10 min do perfil Registado), minúsculo e sem áudio
ff -f lavfi -i testsrc=size=64x64:rate=5:duration=660 $h264 long.mp4
# 2 min com áudio: exportações que demoram (cancelar, apagar o projeto, reiniciar o RabbitMQ)
ff -f lavfi -i testsrc=size=160x120:rate=25:duration=120 -f lavfi -i sine=frequency=500:duration=120 $h264 -c:a aac -shortest slow.mp4

echo "fixtures prontas em $(pwd)"
