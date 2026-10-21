"""
Ficheiros de pré-visualização de um vídeo, gerados no upload:

  proxy.mp4      H.264 480p com GOP curto: toca em qualquer browser (o
                 original pode ser AVI ou H.265) e salta depressa para
                 qualquer instante. Os tempos são os mesmos do original.
  sprite.jpg     grelha de miniaturas para a faixa de vídeo da timeline
  waveform.json  picos do áudio para a faixa de áudio ({rate, peaks 0-100})

Tudo sai de uma só passagem do ffmpeg (o vídeo é descodificado uma vez).
O render final usa sempre o original, nunca o proxy.
"""

import array
import json
import math
import os
import sys
import time

from renderer import (
    RenderError,
    _duration,
    _first_stream,
    _fps,
    ffprobe_json,
    probe,
    run_ffmpeg,
    timeout_for,
)

PROXY_SHORT_SIDE = 480
PROXY_GOP_S = 0.5
SPRITE_TILE_H = 90
SPRITE_COLS = 10
SPRITE_MAX = 100
WAVE_RATE = 8000  # amostras/s do PCM usado para os picos
PEAKS_PER_S = 10
MAX_PEAKS = 4000


def _peaks(raw_path, duration):
    """Picos (0-100) do PCM s16le mono, no máximo MAX_PEAKS valores."""
    rate = min(PEAKS_PER_S, MAX_PEAKS / max(duration, 0.001))
    bucket = max(1, round(WAVE_RATE / rate))
    peaks = []
    with open(raw_path, "rb") as f:
        while True:
            chunk = f.read(bucket * 2 * 256)
            if not chunk:
                break
            samples = array.array("h")
            samples.frombytes(chunk[: len(chunk) // 2 * 2])
            if sys.byteorder == "big":
                samples.byteswap()
            for i in range(0, len(samples), bucket):
                part = samples[i:i + bucket]
                peaks.append(round(100 * max(max(part), -min(part)) / 32768))
    return {"rate": WAVE_RATE / bucket, "peaks": peaks}


def make_preview(input_path, out_dir,
                 is_cancelled=lambda: False,
                 sleep=time.sleep,
                 timeout_s=None):
    """
    Gera proxy.mp4, sprite.jpg e (se houver áudio) waveform.json em
    `out_dir`. Devolve os metadados do sprite e se há forma de onda.
    """
    if not os.path.exists(input_path):
        raise RenderError("invalid_input", "O vídeo de origem não foi encontrado")

    info = probe(input_path)
    video = _first_stream(info, "video")
    audio = _first_stream(info, "audio")
    duration = _duration(info)
    if video is None or not duration:
        raise RenderError("invalid_input", "O ficheiro não tem faixa de vídeo legível")

    _, fps = _fps(video)
    gop = max(1, round(fps * PROXY_GOP_S))

    interval = max(1.0, duration / SPRITE_MAX)
    count = max(1, math.ceil(duration / interval))
    rows = math.ceil(count / SPRITE_COLS)

    proxy = os.path.join(out_dir, "proxy.mp4")
    sprite = os.path.join(out_dir, "sprite.jpg")
    raw = os.path.join(out_dir, "waveform.raw")
    waveform = os.path.join(out_dir, "waveform.json")

    # Lado menor com 480 px (sem ampliar), o outro proporcional e par
    short = f"trunc(min({PROXY_SHORT_SIDE},min(iw,ih))/2)*2"
    scale = f"scale='if(gte(iw,ih),-2,{short})':'if(gte(iw,ih),{short},-2)'"

    graph = (
        f"[0:v]split=2[p][s];"
        f"[p]{scale},format=yuv420p[pv];"
        f"[s]fps={1 / interval:.6f},scale=-2:{SPRITE_TILE_H},tile={SPRITE_COLS}x{rows}[sp]"
    )

    cmd = ["ffmpeg", "-hide_banner", "-nostdin", "-y", "-loglevel", "error",
           "-i", input_path, "-filter_complex", graph,
           "-map", "[pv]"]
    if audio is not None:
        cmd += ["-map", "0:a:0", "-c:a", "aac", "-b:a", "96k", "-ac", "2"]
    cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
            "-g", str(gop), "-keyint_min", str(gop), "-sc_threshold", "0",
            "-movflags", "+faststart", proxy,
            "-map", "[sp]", "-frames:v", "1", "-q:v", "4", sprite]
    if audio is not None:
        cmd += ["-map", "0:a:0", "-ac", "1", "-ar", str(WAVE_RATE), "-f", "s16le", raw]

    try:
        run_ffmpeg(cmd, is_cancelled, sleep, timeout_for(duration) if timeout_s is None else timeout_s)

        if audio is not None:
            with open(waveform, "w") as f:
                json.dump(_peaks(raw, duration), f)
    finally:
        if os.path.exists(raw):
            os.remove(raw)

    for path in (proxy, sprite):
        if not os.path.exists(path) or os.path.getsize(path) == 0:
            raise RenderError("ffmpeg_error", "O ffmpeg não produziu os ficheiros de pré-visualização")

    # Tamanho real das miniaturas (o ffmpeg já aplicou a rotação do vídeo)
    tile = _first_stream(ffprobe_json(sprite), "video")
    return {
        "sprite": {
            "interval": interval,
            "cols": SPRITE_COLS,
            "count": count,
            "width": tile["width"] // SPRITE_COLS,
            "height": tile["height"] // rows,
        },
        "hasWaveform": audio is not None,
    }
