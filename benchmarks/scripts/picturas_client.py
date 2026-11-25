"""Cliente mínimo da API do PictuRAS para medições e testes de regressão (Fase 2).

Fala apenas com as entradas públicas da aplicação (nginx em https://localhost:8080):
API Gateway em /api-gateway/ e Socket.IO em /socket.io. Não depende de nenhum
detalhe interno dos workers, para que os mesmos scripts corram sem alterações
antes e depois do refactoring.

Gerado com apoio de IA (Claude) e revisto pela equipa PL3-G1.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import struct
import subprocess
import threading
import time
import uuid
import zlib
from pathlib import Path

import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)  # certificado autoassinado

BASE_URL = os.getenv("PICTURAS_URL", "https://localhost:8080")
RABBIT_API = os.getenv("PICTURAS_RABBIT_API", "http://localhost:15672/api")
RABBIT_AUTH = (os.getenv("PICTURAS_RABBIT_USER", "user"), os.getenv("PICTURAS_RABBIT_PASS", "password"))

SCRIPTS_DIR = Path(__file__).resolve().parent
DEFAULT_REPO = (SCRIPTS_DIR / ".." / "..").resolve()  # benchmarks/scripts -> raiz do repositório

VIDEO_ONLY_TOOLS = {"trim", "speed", "subtitles", "extract_frames"}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".webm"}
MIME = {".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
        ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}


class ApiError(Exception):
    def __init__(self, status: int, body):
        super().__init__(f"HTTP {status}: {body}")
        self.status = status
        self.body = body


def repo_path(arg: str | None) -> Path:
    repo = Path(arg).resolve() if arg else DEFAULT_REPO
    if not (repo / "docker-compose.yaml").exists():
        raise SystemExit(f"Repositório não encontrado em {repo} (usar --repo)")
    return repo


def sample(repo: Path, name: str) -> Path:
    p = repo / "samples" / "video" / name
    if not p.exists():
        raise SystemExit(f"Vídeo de teste em falta: {p}")
    return p


def make_png(width: int = 320, height: int = 240) -> bytes:
    """PNG RGB determinístico (gradiente), sem dependências externas."""
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    rows = bytearray()
    for y in range(height):
        rows.append(0)
        for x in range(width):
            rows += bytes(((x * 255) // (width - 1), (y * 255) // (height - 1), ((x + y) * 255) // (width + height - 2)))
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(bytes(rows), 9)) + chunk(b"IEND", b"")


class Events:
    """Eventos Socket.IO de um utilizador, com o instante de chegada (time.monotonic)."""

    def __init__(self):
        self.lock = threading.Lock()
        self.updates: list[float] = []       # process-update
        self.errors: list[tuple[float, dict]] = []  # process-error
        self.progress: dict[str, list[tuple[float, int]]] = {}  # imgId -> [(t, percent)]
        self.previews: list[tuple[float, dict]] = []
        self.preview_errors: list[tuple[float, dict]] = []

    def reset(self):
        with self.lock:
            self.updates.clear(); self.errors.clear(); self.progress.clear()
            self.previews.clear(); self.preview_errors.clear()


class Client:
    def __init__(self, base_url: str = BASE_URL):
        self.base = base_url.rstrip("/")
        self.api = self.base + "/api-gateway"
        self.http = requests.Session()
        self.http.verify = False
        self.uid = None
        self.token = None
        self.events = Events()
        self._sio = None

    # ---------- HTTP ----------
    def _req(self, method: str, path: str, ok=(200, 201, 204), **kw):
        headers = kw.pop("headers", {})
        if self.token:
            headers.setdefault("Authorization", f"Bearer {self.token}")
        r = self.http.request(method, self.api + path, headers=headers, timeout=kw.pop("timeout", 600), **kw)
        if r.status_code not in ok:
            try:
                body = r.json()
            except ValueError:
                body = r.text[:300]
            raise ApiError(r.status_code, body)
        return r

    # ---------- utilizadores ----------
    def register(self, user_type: str = "premium") -> "Client":
        """Cria uma conta nova. As medições usam premium para não esbarrar no limite diário."""
        tag = uuid.uuid4().hex[:12]
        body = {"name": f"bench-{tag}", "email": f"bench-{tag}@picturas.test",
                "password": f"Bench#{tag}", "type": user_type}
        data = self._req("POST", "/users/", json=body).json()
        self.uid, self.token = str(data["user"]["_id"]), data["jwt"]
        if data["user"].get("type") != user_type:
            self._req("PUT", f"/users/{self.uid}", json={"type": user_type})
        return self

    def delete_account(self):
        try:
            self._req("DELETE", f"/users/{self.uid}")
        except Exception:  # noqa: BLE001 - limpeza, não é crítico
            pass

    # ---------- projetos ----------
    def create_project(self, name: str) -> str:
        return str(self._req("POST", f"/projects/{self.uid}", json={"name": name}).json()["_id"])

    def project(self, pid: str) -> dict:
        return self._req("GET", f"/projects/{self.uid}/{pid}").json()

    def _version(self, pid: str) -> str:
        return str(self.project(pid)["version"])

    def upload(self, pid: str, file: Path | None, upload_name: str | None = None, data: bytes | None = None) -> float:
        """Carrega um ficheiro (imagem ou vídeo). Devolve o tempo do pedido em segundos."""
        name = upload_name or file.name
        ext = Path(name).suffix.lower()
        kind = "video" if ext in VIDEO_EXTENSIONS else "img"
        field = "video" if kind == "video" else "image"
        payload = data if data is not None else file.read_bytes()
        t0 = time.monotonic()
        self._req("POST", f"/projects/{self.uid}/{pid}/{kind}",
                  files={field: (name, payload, MIME.get(ext, "application/octet-stream"))},
                  headers={"X-Project-Version": self._version(pid)}, timeout=1800)
        return time.monotonic() - t0

    def add_tool(self, pid: str, procedure: str, params: dict):
        self._req("POST", f"/projects/{self.uid}/{pid}/tool",
                  json={"procedure": procedure, "params": params},
                  headers={"X-Project-Version": self._version(pid)})

    def media_ids(self, pid: str) -> list[dict]:
        return self.project(pid)["imgs"]

    def start_process(self, pid: str):
        return self._req("POST", f"/projects/{self.uid}/{pid}/process", json={},
                         headers={"X-Project-Version": self._version(pid)}).json()

    def start_preview(self, pid: str, img_id: str):
        return self._req("POST", f"/projects/{self.uid}/{pid}/preview/{img_id}", json={})

    def cancel(self, pid: str):
        try:
            self._req("DELETE", f"/projects/{self.uid}/{pid}/process",
                      headers={"X-Project-Version": self._version(pid)})
        except Exception:  # noqa: BLE001
            pass

    def results(self, pid: str) -> dict:
        return self._req("GET", f"/projects/{self.uid}/{pid}/process/url").json()

    def download(self, url: str) -> bytes:
        r = self.http.get(url, timeout=600)
        r.raise_for_status()
        return r.content

    def expected_events(self, pid: str) -> int:
        """N.º de eventos process-update até ao fim: 1 por vídeo, 1 por (imagem, ferramenta de imagem)."""
        p = self.project(pid)
        videos = sum(1 for i in p["imgs"] if i.get("media_type") == "video")
        images = len(p["imgs"]) - videos
        img_tools = sum(1 for t in p["tools"] if t["procedure"] not in VIDEO_ONLY_TOOLS)
        return videos + images * img_tools

    # ---------- Socket.IO ----------
    def connect_socket(self):
        import socketio  # importado aqui para os scripts estáticos não dependerem dele

        sio = socketio.Client(ssl_verify=False, reconnection=True)
        ev = self.events

        @sio.on("process-update")
        def _update(_msg=None):
            with ev.lock:
                ev.updates.append(time.monotonic())

        @sio.on("process-error")
        def _error(payload=None):
            with ev.lock:
                ev.errors.append((time.monotonic(), payload or {}))

        @sio.on("video-progress")
        def _progress(payload=None):
            payload = payload or {}
            if payload.get("preview"):
                return
            with ev.lock:
                ev.progress.setdefault(str(payload.get("imgId")), []).append(
                    (time.monotonic(), int(payload.get("percent") or 0)))

        @sio.on("preview-ready")
        def _preview(msg=None):
            try:
                data = json.loads(msg) if isinstance(msg, str) else (msg or {})
            except ValueError:
                data = {"imageUrl": msg}
            with ev.lock:
                ev.previews.append((time.monotonic(), data))

        @sio.on("preview-error")
        def _preview_error(payload=None):
            with ev.lock:
                ev.preview_errors.append((time.monotonic(), payload or {}))

        sio.connect(self.base, transports=["websocket"], auth={"token": self.token}, wait_timeout=20)
        self._sio = sio
        time.sleep(0.5)  # dar tempo ao servidor para associar o socket à sala do utilizador
        return self

    def close(self):
        if self._sio is not None:
            try:
                self._sio.disconnect()
            except Exception:  # noqa: BLE001
                pass

    # ---------- esperar pelo fim ----------
    def wait_process(self, pid: str, expected: int, t_start: float, timeout: float) -> dict:
        """Espera pelo fim de um processamento.

        Fim = `expected` eventos process-update (instante do último), ou um
        process-error, ou, como rede de segurança, resultados visíveis por
        consulta (o orquestrador só os publica quando a execução fica concluída).
        """
        ev = self.events
        deadline = t_start + timeout
        next_poll = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            with ev.lock:
                n, errs = len(ev.updates), list(ev.errors)
                last = ev.updates[expected - 1] if n >= expected else None
            if errs:
                return {"status": "error", "seconds": errs[0][0] - t_start, "error": errs[0][1], "events": n}
            if last is not None:
                return {"status": "ok", "seconds": last - t_start, "events": n, "detected_by": "socket"}
            if time.monotonic() >= next_poll:
                next_poll = time.monotonic() + 1.0
                try:
                    res = self.results(pid)
                    if res.get("imgs") or res.get("texts"):
                        return {"status": "ok", "seconds": time.monotonic() - t_start, "events": n,
                                "detected_by": "poll"}
                except Exception:  # noqa: BLE001
                    pass
            time.sleep(0.05)
        with ev.lock:
            n = len(ev.updates)
        return {"status": "timeout", "seconds": timeout, "events": n}

    def per_video_done(self, t_start: float) -> dict:
        """Instante (s desde t_start) em que cada vídeo chegou a 100 % no worker, e em que começou."""
        out = {}
        with self.events.lock:
            for img_id, points in self.events.progress.items():
                done = [t for t, pct in points if pct >= 100]
                out[img_id] = {"first_progress_s": round(points[0][0] - t_start, 3),
                               "done_s": round(done[0] - t_start, 3) if done else None}
        return out


# ---------- RabbitMQ: paralelismo efetivo ----------
class QueueSampler(threading.Thread):
    """Amostra, a cada `period` s, as mensagens prontas e por confirmar das filas de vídeo.

    Usa todas as filas cujo nome começa por `prefix`, para funcionar com a fila
    única da base (video_queue) e com as filas separadas depois do refactoring.
    """

    def __init__(self, prefix: str = "video", period: float = 1.0):
        super().__init__(daemon=True)
        self.prefix, self.period = prefix, period
        self.samples: list[dict] = []
        self._stop_evt = threading.Event()
        self.error = None

    def run(self):
        t0 = time.monotonic()
        while not self._stop_evt.is_set():
            try:
                r = requests.get(f"{RABBIT_API}/queues/%2F", auth=RABBIT_AUTH, timeout=5)
                r.raise_for_status()
                queues = {q["name"]: {"ready": q.get("messages_ready", 0),
                                      "unacked": q.get("messages_unacknowledged", 0),
                                      "consumers": q.get("consumers", 0)}
                          for q in r.json() if q["name"].startswith(self.prefix)}
                self.samples.append({"t": round(time.monotonic() - t0, 2), "queues": queues})
            except Exception as e:  # noqa: BLE001
                self.error = str(e)
            self._stop_evt.wait(self.period)

    def stop(self) -> dict:
        self._stop_evt.set()
        self.join(timeout=10)
        unacked = [sum(q["unacked"] for q in s["queues"].values()) for s in self.samples]
        ready = [sum(q["ready"] for q in s["queues"].values()) for s in self.samples]
        consumers = [sum(q["consumers"] for q in s["queues"].values()) for s in self.samples]
        return {"max_unacked": max(unacked, default=None), "max_ready": max(ready, default=None),
                "max_consumers": max(consumers, default=None), "samples": self.samples,
                "error": self.error,
                "note": "A API de gestão do RabbitMQ atualiza as estatísticas a cada ~5 s."}


# ---------- análise de resultados ----------
def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def ffprobe(data: bytes, repo: Path) -> dict | None:
    """Características de um vídeo. Usa o ffprobe da máquina ou, se não existir,
    o do contentor `projects` (que não é alterado pelo refactoring)."""
    args = ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-count_frames"]
    try:
        if shutil.which("ffprobe"):
            tmp = SCRIPTS_DIR / f".probe-{uuid.uuid4().hex}.bin"
            tmp.write_bytes(data)
            try:
                out = subprocess.run(["ffprobe", *args, str(tmp)], capture_output=True, timeout=300)
            finally:
                tmp.unlink(missing_ok=True)
        else:
            out = subprocess.run(["docker", "compose", "exec", "-T", "projects", "ffprobe", *args, "-i", "pipe:0"],
                                 input=data, capture_output=True, timeout=300, cwd=repo)
        info = json.loads(out.stdout or b"{}")
    except Exception:  # noqa: BLE001
        return None
    streams = info.get("streams", [])
    v = next((s for s in streams if s.get("codec_type") == "video"), None)
    a = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if v is None:
        return None
    return {
        "duration": round(float(info.get("format", {}).get("duration") or v.get("duration") or 0), 2),
        "width": v.get("width"), "height": v.get("height"),
        "video_codec": v.get("codec_name"), "audio_codec": a.get("codec_name") if a else None,
        "frames": int(v.get("nb_read_frames") or v.get("nb_frames") or 0),
    }


def png_size(data: bytes):
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        w, h = struct.unpack(">II", data[16:24])
        return [w, h]
    return None
