FROM python:3.11-slim

WORKDIR /app

COPY ./video/router/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY ./video/common ./common
COPY ./video/router ./router

CMD [ "python", "-u", "-m", "router.router" ]
