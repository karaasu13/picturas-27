FROM python:3.11-slim

# ffmpeg/ffprobe isolated in the container; fonts for the burned-in captions
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core fonts-noto-core fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY ./video/subtitles/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY ./video/common ./common
COPY ./video/subtitles ./subtitles

CMD [ "python", "-u", "-m", "subtitles.worker" ]
