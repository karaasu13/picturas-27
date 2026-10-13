FROM python:3.11-slim

# FFmpeg (inclui ffprobe) para alterar a velocidade do vídeo e do áudio
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY ./video_speed .

COPY ./utils ./utils
RUN pip install --no-cache-dir -r ./utils/requirements.txt

RUN pip install --no-cache-dir -r requirements.txt

CMD [ "python","-u", "video_speed.py"]
