FROM python:3.11-slim

# ffmpeg/ffprobe para o render e as pré-visualizações dos vídeos
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY ./video_render/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY ./video_render .

CMD ["python", "-u", "video_render.py"]
