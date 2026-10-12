"""
Lógica de corte de vídeo (UC-VID-001 - Eliminar segmento intermédio).

Remove o intervalo [start, end] de um vídeo e junta as duas partes que sobram
([0, start] e [end, duração]) num novo ficheiro, mantendo o formato
(contentor), o codec de vídeo, a resolução e a taxa de fotogramas do original.

Este módulo não sabe nada de RabbitMQ: recebe caminhos e instantes e devolve
o resultado, o que permite testá-lo isoladamente.
"""

import json
import os
import subprocess
import tempfile
import time

# Desfasamento áudio/vídeo máximo tolerado na junção (REQ-VID-CUT-012)
AV_SYNC_THRESHOLD_S = 0.05

VIDEO_ENCODERS = {
    "h264": "libx264",
    "hevc": "libx265",
}

# Codec de áudio por contentor (o AVI não suporta AAC de forma fiável)
AUDIO_ENCODERS = {
    "mp4": ["-c:a", "aac", "-b:a", "192k"],
    "mov": ["-c:a", "aac", "-b:a", "192k"],
    "avi": ["-c:a", "libmp3lame", "-b:a", "192k"],
}


class CutError(Exception):
    """Erro de processamento com código para o Projects-MS."""

    def __init__(self, code, msg):
        super().__init__(msg)
        self.code = code
        self.msg = msg


class CutCancelled(Exception):
    """O utilizador cancelou a tarefa durante o processamento."""


def probe(path):
    """Devolve a informação do ffprobe (formato + streams) em dicionário."""
    try:
        out = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_format", "-show_streams",
                "-of", "json", path,
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=120,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
        raise CutError("invalid_input", f"Não foi possível ler o vídeo: {e}")

    return json.loads(out.stdout or "{}")


def _first_stream(info, kind):
    for s in info.get("streams", []):
        if s.get("codec_type") == kind:
            return s
    return None


def _duration(info):
    try:
        return float(info.get("format", {}).get("duration"))
    except (TypeError, ValueError):
        return None


def _stream_duration(stream):
    if not stream:
        return None
    try:
        return float(stream.get("duration"))
    except (TypeError, ValueError):
        return None


def container_of(path):
    ext = os.path.splitext(path)[1].lower().lstrip(".")
    if ext not in AUDIO_ENCODERS:
        raise CutError("invalid_input", f"Formato de ficheiro não suportado: .{ext}")
    return ext


def build_ffmpeg_cmd(info, input_path, output_path, start, end):
    """Constrói o comando ffmpeg que remove [start, end] e junta as partes."""
    video = _first_stream(info, "video")
    audio = _first_stream(info, "audio")

    if video is None:
        raise CutError("invalid_input", "O ficheiro não tem faixa de vídeo")

    codec = video.get("codec_name")
    encoder = VIDEO_ENCODERS.get(codec)
    if encoder is None:
        raise CutError("invalid_input", f"Codec de vídeo não suportado: {codec}")

    container = container_of(output_path)

    s = f"{start:.3f}"
    e = f"{end:.3f}"
    gap = f"{end - start:.3f}"

    # Vídeo: deita fora os fotogramas em [start, end[ e puxa os seguintes
    # para trás. Funciona em fluxo, fotograma a fotograma. (Com dois `trim` e
    # um `concat` o ffmpeg guardava em memória todos os fotogramas depois do
    # corte: 3,4 GB para 40 s em 1080p.)
    parts = [
        f"[0:v]select='lt(t\\,{s})+gte(t\\,{e})',"
        f"setpts='PTS-STARTPTS-gte(T\\,{e})*{gap}/TB'[v]",
    ]

    # Áudio: `atrim` corta à amostra (o `aselect` só corta por blocos de
    # ~20 ms). O áudio descomprimido é pequeno, por isso aqui não há problema
    # de memória.
    if audio is not None:
        parts += [
            "[0:a]asplit=2[a0in][a1in]",
            f"[a0in]atrim=end={s},asetpts=PTS-STARTPTS[a0]",
            f"[a1in]atrim=start={e},asetpts=PTS-STARTPTS[a1]",
            "[a0][a1]concat=n=2:v=0:a=1[a]",
        ]

    cmd = [
        "ffmpeg", "-hide_banner", "-nostdin", "-y", "-loglevel", "error",
        "-i", input_path,
        "-filter_complex", ";".join(parts),
        "-map", "[v]",
    ]

    if audio is not None:
        cmd += ["-map", "[a]"]

    # Vídeo: mesmo codec do original, qualidade visualmente sem perdas
    cmd += ["-c:v", encoder, "-preset", "veryfast", "-crf", "18"]

    pix_fmt = video.get("pix_fmt") or ""
    if encoder == "libx265" and pix_fmt.startswith("yuv420p10"):
        cmd += ["-pix_fmt", "yuv420p10le"]
    else:
        cmd += ["-pix_fmt", "yuv420p"]

    if encoder == "libx265":
        cmd += ["-x265-params", "log-level=error"]

    if encoder == "libx265" and container in ("mp4", "mov"):
        # Necessário para o HEVC tocar em browsers/leitores da Apple
        cmd += ["-tag:v", "hvc1"]

    # Mantém a taxa de fotogramas do original (REQ-VID-CUT-025)
    fps = video.get("avg_frame_rate") or video.get("r_frame_rate")
    if fps and fps not in ("0/0", "0"):
        cmd += ["-r", fps]

    if audio is not None:
        cmd += AUDIO_ENCODERS[container]
        if audio.get("sample_rate"):
            cmd += ["-ar", str(audio["sample_rate"])]

    if container in ("mp4", "mov"):
        cmd += ["-movflags", "+faststart"]

    cmd.append(output_path)
    return cmd


def av_drift(info_in, info_out):
    """
    Variação do desfasamento entre áudio e vídeo introduzida pelo corte.

    Compara (duração vídeo - duração áudio) antes e depois. Se o original já
    tinha um pequeno desfasamento, esse não conta. Devolve None quando o
    contentor não indica a duração de cada faixa de forma fiável: no AVI o
    valor é uma estimativa que inclui o enchimento do MP3, por isso não serve
    para medir dezenas de milissegundos.
    """
    if "avi" in (info_out.get("format", {}).get("format_name") or "").split(","):
        return None

    a_in = _stream_duration(_first_stream(info_in, "audio"))
    v_in = _stream_duration(_first_stream(info_in, "video"))
    a_out = _stream_duration(_first_stream(info_out, "audio"))
    v_out = _stream_duration(_first_stream(info_out, "video"))

    if None in (a_in, v_in, a_out, v_out):
        return None

    return abs((v_out - a_out) - (v_in - a_in))


def cut_video(input_path, output_path, start, end,
              is_cancelled=lambda: False,
              sleep=time.sleep,
              timeout_s=900):
    """
    Executa o corte. Lança CutError em caso de falha e CutCancelled se o
    utilizador cancelar. `sleep` permite ao worker continuar a responder ao
    RabbitMQ (heartbeats) enquanto o ffmpeg corre.
    """
    if not os.path.exists(input_path):
        raise CutError("invalid_input", "O vídeo de origem não foi encontrado")

    info_in = probe(input_path)
    duration = _duration(info_in)

    if duration is None:
        raise CutError("invalid_input", "Não foi possível determinar a duração do vídeo")

    if not (0 < start < end < duration):
        raise CutError("invalid_input", "Intervalo de corte fora dos limites do vídeo")

    cmd = build_ffmpeg_cmd(info_in, input_path, output_path, start, end)

    started = time.monotonic()
    # stderr vai para um ficheiro temporário: com um PIPE que ninguém lê, o
    # ffmpeg podia bloquear se escrevesse muito
    err_file = tempfile.TemporaryFile()
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=err_file)

    try:
        while proc.poll() is None:
            if is_cancelled():
                proc.kill()
                proc.wait()
                raise CutCancelled()

            if time.monotonic() - started > timeout_s:
                proc.kill()
                proc.wait()
                raise CutError(
                    "timeout",
                    f"O processamento excedeu o tempo máximo de {timeout_s // 60} min",
                )

            sleep(0.5)
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        err_file.seek(0)
        stderr = err_file.read().decode(errors="replace").strip()
        err_file.close()

    if proc.returncode != 0:
        raise CutError("ffmpeg_error", stderr[-500:] or "O ffmpeg terminou com erro")

    if not os.path.exists(output_path) or os.path.getsize(output_path) == 0:
        raise CutError("ffmpeg_error", "O ffmpeg não produziu o ficheiro de saída")

    info_out = probe(output_path)

    drift = av_drift(info_in, info_out)
    if drift is not None and drift >= AV_SYNC_THRESHOLD_S:
        raise CutError(
            "av_sync",
            f"Desfasamento áudio/vídeo de {drift * 1000:.0f} ms na junção",
        )

    return {
        "duration": _duration(info_out),
        "expectedDuration": duration - (end - start),
        "avDrift": drift,
        "processingTime": time.monotonic() - started,
    }
