FROM python:3.11-slim

# ffmpeg/ffprobe para o corte e a validação dos vídeos
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY ./video_cut/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY ./video_cut .

CMD ["python", "-u", "video_cut.py"]
