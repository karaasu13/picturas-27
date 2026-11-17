FROM python:3.11-slim

# ffmpeg/ffprobe isolated in the container
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY ./video/extract_frames/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY ./video/common ./common
COPY ./video/extract_frames ./extract_frames

CMD [ "python", "-u", "-m", "extract_frames.worker" ]
