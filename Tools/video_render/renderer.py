"""
Motor de render do editor de vídeo.

Recebe a receita da timeline ({output, faixas}) e os vídeos de origem
({video_id: caminho}) e produz um único ficheiro com um só encode: cada clip
é cortado (trim/atrim), acelerado ou abrandado (setpts + atempo),
reenquadrado para a resolução de saída (scale + pad ou crop) e as faixas são
juntas (concat). Os buracos ficam a preto (vídeo) ou em silêncio (áudio).
Os originais nunca são alterados.

Este módulo não sabe nada de RabbitMQ: recebe caminhos e a receita e devolve
o resultado, o que permite testá-lo isoladamente.
"""

import json
import os
import subprocess
import tempfile
import time

# Desfasamento áudio/vídeo máximo tolerado no resultado
AV_SYNC_THRESHOLD_S = 0.05

# Tempo mínimo de processamento; vídeos longos têm direito a 2x a duração
MIN_TIMEOUT_S = int(os.getenv("VIDEO_TASK_TIMEOUT", 900))

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

# CRF por encoder e qualidade (alta = o valor do antigo corte, visualmente sem perdas)
CRF = {
    "libx264": {"alta": 18, "media": 23, "baixa": 28},
    "libx265": {"alta": 22, "media": 28, "baixa": 32},
}

MIN_SPEED = 0.25
MAX_SPEED = 4.0
AUDIO_RATE = 48000


class RenderError(Exception):
    """Erro de processamento com código para o Projects-MS."""

    def __init__(self, code, msg):
        super().__init__(msg)
        self.code = code
        self.msg = msg


class RenderCancelled(Exception):
    """O utilizador cancelou a tarefa durante o processamento."""


def ffprobe_json(path):
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
        raise RenderError("invalid_input", f"Não foi possível ler o vídeo: {e}")

    return json.loads(out.stdout or "{}")


def probe(path):
    """ffprobe de um vídeo; recusa imagens (png/jpeg aparecem como *_pipe ou image2)."""
    info = ffprobe_json(path)
    format_name = info.get("format", {}).get("format_name", "")
    if format_name.endswith("_pipe") or format_name in ("image2", "gif"):
        raise RenderError("invalid_input", "O ficheiro não contém um vídeo suportado")
    return info


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


def _fps(stream):
    """Taxa de fotogramas como texto racional ("30000/1001") e como número."""
    for rate in (stream.get("avg_frame_rate"), stream.get("r_frame_rate")):
        try:
            num, den = (int(x) for x in rate.split("/"))
        except (AttributeError, ValueError):
            continue
        if num > 0 and den > 0:
            return rate, num / den
    raise RenderError("invalid_input", "Não foi possível determinar a taxa de fotogramas")


def container_of(path):
    ext = os.path.splitext(path)[1].lower().lstrip(".")
    if ext not in AUDIO_ENCODERS:
        raise RenderError("invalid_input", f"Formato de ficheiro não suportado: .{ext}")
    return ext


def timeout_for(duration):
    return max(MIN_TIMEOUT_S, 2 * duration)


def atempo_chain(speed):
    """O atempo aceita 0.5-2.0 por instância (em versões antigas do ffmpeg),
    por isso fatores fora desse intervalo são decompostos numa cadeia.
    (Lógica do video_speed.py da feature/velocidade.)"""
    filters = []
    while speed > 2.0:
        filters.append("atempo=2.0")
        speed /= 2.0
    while speed < 0.5:
        filters.append("atempo=0.5")
        speed /= 0.5
    filters.append(f"atempo={speed:.6f}")
    return ",".join(filters)


def _clip_len(clip):
    return (clip["out"] - clip["in"]) / clip["speed"]


def recipe_duration(recipe):
    """Duração final em segundos (fim do último clip de vídeo)."""
    ends = [
        c["posicao"] + _clip_len(c)
        for f in recipe.get("faixas", [])
        if f.get("tipo") == "video"
        for c in f.get("clips", [])
    ]
    return max(ends, default=0.0)


def _segments(clips, fps, total_f=None):
    """
    Divide uma faixa em segmentos (clip ou None = buraco, n.º de fotogramas).
    Os limites são arredondados à grelha de fotogramas de saída a partir das
    posições absolutas, por isso o arredondamento nunca se acumula de clip
    para clip. Com `total_f`, a faixa é cortada ou completada até esse total.
    """
    segs = []
    cursor = 0
    for clip in sorted(clips, key=lambda c: c["posicao"]):
        start = max(round(clip["posicao"] * fps), cursor)
        end = round((clip["posicao"] + _clip_len(clip)) * fps)
        if total_f is not None:
            end = min(end, total_f)
        if end <= start:
            continue  # mais curto que um fotograma, ou depois do fim
        if start > cursor:
            segs.append((None, start - cursor))
        segs.append((clip, end - start))
        cursor = end
    if total_f is not None and cursor < total_f:
        segs.append((None, total_f - cursor))
    return segs, cursor


def _check_recipe(recipe, infos):
    output = recipe.get("output") or {}
    if output.get("formato") not in AUDIO_ENCODERS:
        raise RenderError("invalid_input", "Formato de saída não suportado")
    if output.get("qualidade") not in CRF["libx264"] or output.get("fit") not in ("pad", "crop"):
        raise RenderError("invalid_input", "Definições de saída inválidas")
    for side in (output.get("largura"), output.get("altura")):
        if not isinstance(side, int) or side % 2 or not 16 <= side <= 4096:
            raise RenderError("invalid_input", "A resolução de saída tem de ser par, entre 16 e 4096")

    tracks = {"video": [], "audio": []}
    for f in recipe.get("faixas", []):
        if f.get("tipo") not in tracks:
            raise RenderError("invalid_input", "Tipo de faixa inválido")
        if tracks[f["tipo"]]:
            # shortcut: uma faixa de cada tipo; mais faixas precisam de overlay/amix
            raise RenderError("invalid_input", "O render só suporta uma faixa de vídeo e uma de áudio")
        tracks[f["tipo"]] = f.get("clips", [])

        for c in tracks[f["tipo"]]:
            info = infos.get(c.get("video_id"))
            if info is None:
                raise RenderError("invalid_input", "Um clip usa um vídeo de origem que não foi enviado")
            duration = _duration(info)
            if not (0 <= c["in"] < c["out"] <= (duration or 0) + 0.01):
                raise RenderError("invalid_input", "Um clip está fora da duração do vídeo de origem")
            if not MIN_SPEED <= c["speed"] <= MAX_SPEED:
                raise RenderError("invalid_input", "Velocidade fora dos limites (0,25x a 4x)")
            if c["posicao"] < 0:
                raise RenderError("invalid_input", "Um clip começa antes do início da timeline")
            if f["tipo"] == "audio" and _first_stream(info, "audio") is None:
                raise RenderError("invalid_input", "Um clip de áudio usa um vídeo sem áudio")
            if _first_stream(info, "video") is None:
                raise RenderError("invalid_input", "O ficheiro não tem faixa de vídeo")

    if not tracks["video"]:
        raise RenderError("invalid_input", "A timeline não tem clips de vídeo")
    return output, tracks["video"], tracks["audio"]


def build_ffmpeg_cmd(recipe, infos, inputs, output_path):
    """
    Constrói o comando ffmpeg da receita. `infos` tem o ffprobe de cada vídeo
    de origem e `inputs` o caminho. Devolve (cmd, duração esperada em s).
    """
    output, video_clips, audio_clips = _check_recipe(recipe, infos)

    # fps de saída: o do primeiro clip de vídeo. Codec: se o formato não muda,
    # o da origem desse clip (um corte mantém o original); se muda, H.264
    # (UC-003: MP4/MOV -> H.264 + AAC, AVI -> H.264 + MP3). Nunca HEVC em AVI.
    first = min(video_clips, key=lambda c: c["posicao"])
    v0 = _first_stream(infos[first["video_id"]], "video")
    source_codec = v0.get("codec_name")
    if source_codec not in VIDEO_ENCODERS:
        raise RenderError("invalid_input", f"Codec de vídeo não suportado: {source_codec}")
    fps_str, fps = _fps(v0)

    container = container_of(output_path)
    source_format = os.path.splitext(inputs[first["video_id"]])[1].lower().lstrip(".")
    keep_codec = source_format == container and not (container == "avi" and source_codec == "hevc")
    encoder = VIDEO_ENCODERS[source_codec] if keep_codec else "libx264"
    ten_bit = encoder == "libx265" and (v0.get("pix_fmt") or "").startswith("yuv420p10")
    pix_fmt = "yuv420p10le" if ten_bit else "yuv420p"
    W, H = output["largura"], output["altura"]
    if output["fit"] == "crop":
        reframe = f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H}"
    else:
        reframe = (
            f"scale={W}:{H}:force_original_aspect_ratio=decrease:force_divisible_by=2,"
            f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=black"
        )

    # Um -ss/-t/-i por clip, e não um só -i com split: com split o ffmpeg
    # guardava em memória todos os fotogramas à espera do concat (GB em HD).
    # Clips de vídeo e áudio alinhados (mesma origem, in/out e posição)
    # partilham a entrada, porque são consumidos ao mesmo tempo.
    args, input_index = [], {}

    def input_for(clip):
        key = (clip["video_id"], clip["in"], clip["out"], clip["posicao"])
        if key not in input_index:
            input_index[key] = len(input_index)
            args.extend([
                "-ss", f"{clip['in']:.6f}", "-t", f"{clip['out'] - clip['in']:.6f}",
                "-i", inputs[clip["video_id"]],
            ])
        return input_index[key]

    parts = []

    v_segs, total_f = _segments(video_clips, fps)
    if total_f == 0:
        raise RenderError("invalid_input", "A timeline não tem clips de vídeo")

    for k, (clip, n) in enumerate(v_segs):
        if clip is None:
            parts.append(f"color=c=black:s={W}x{H}:r={fps_str},format={pix_fmt},setsar=1,trim=end_frame={n}[v{k}]")
            continue
        i = input_for(clip)
        parts.append(
            f"[{i}:v]trim=duration={clip['out'] - clip['in']:.6f},"
            f"setpts=(PTS-STARTPTS)/{clip['speed']:.6f},fps={fps_str},{reframe},"
            f"setsar=1,format={pix_fmt},tpad=stop=-1:stop_mode=clone,trim=end_frame={n}[v{k}]"
        )
    parts.append("".join(f"[v{k}]" for k in range(len(v_segs))) + f"concat=n={len(v_segs)}:v=1:a=0[v]")

    has_audio = bool(audio_clips)
    if has_audio:
        a_segs, _ = _segments(audio_clips, fps, total_f)
        cursor_f = 0
        stereo = f"aformat=sample_fmts=fltp:sample_rates={AUDIO_RATE}:channel_layouts=stereo"
        for k, (clip, n) in enumerate(a_segs):
            # amostras a partir das fronteiras absolutas de fotograma: sem deriva
            samples = round((cursor_f + n) * AUDIO_RATE / fps) - round(cursor_f * AUDIO_RATE / fps)
            cursor_f += n
            if clip is None:
                parts.append(f"anullsrc=r={AUDIO_RATE}:cl=stereo,{stereo},atrim=end_sample={samples}[a{k}]")
                continue
            i = input_for(clip)
            tempo = "" if clip["speed"] == 1 else atempo_chain(clip["speed"]) + ","
            parts.append(
                f"[{i}:a]atrim=duration={clip['out'] - clip['in']:.6f},asetpts=PTS-STARTPTS,"
                f"{tempo}aresample={AUDIO_RATE},{stereo},apad,atrim=end_sample={samples}[a{k}]"
            )
        parts.append("".join(f"[a{k}]" for k in range(len(a_segs))) + f"concat=n={len(a_segs)}:v=0:a=1[a]")

    cmd = ["ffmpeg", "-hide_banner", "-nostdin", "-y", "-loglevel", "error", *args,
           "-filter_complex", ";".join(parts), "-map", "[v]"]
    if has_audio:
        cmd += ["-map", "[a]"]

    cmd += ["-c:v", encoder, "-preset", "veryfast", "-crf", str(CRF[encoder][output["qualidade"]])]
    cmd += ["-pix_fmt", pix_fmt]

    if encoder == "libx265":
        cmd += ["-x265-params", "log-level=error"]
        if container in ("mp4", "mov"):
            # Necessário para o HEVC tocar em browsers/leitores da Apple
            cmd += ["-tag:v", "hvc1"]

    cmd += ["-r", fps_str]

    if has_audio:
        cmd += AUDIO_ENCODERS[container] + ["-ar", str(AUDIO_RATE)]

    if container in ("mp4", "mov"):
        cmd += ["-movflags", "+faststart"]

    cmd.append(output_path)
    return cmd, total_f / fps


def av_drift(info_out):
    """
    Diferença entre a duração do vídeo e a do áudio no resultado (o render
    completa o áudio até ao fim do vídeo, por isso deve ser ~0). Devolve None
    sem áudio ou no AVI, onde a duração do MP3 inclui enchimento e não serve
    para medir dezenas de milissegundos.
    """
    if "avi" in (info_out.get("format", {}).get("format_name") or "").split(","):
        return None

    a = _stream_duration(_first_stream(info_out, "audio"))
    v = _stream_duration(_first_stream(info_out, "video"))
    if a is None or v is None:
        return None
    return abs(v - a)


def run_ffmpeg(cmd, is_cancelled, sleep, timeout_s):
    """
    Corre o ffmpeg a verificar o cancelamento. `sleep` permite ao worker
    continuar a responder ao RabbitMQ (heartbeats) enquanto o ffmpeg corre.
    """
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
                raise RenderCancelled()

            if time.monotonic() - started > timeout_s:
                proc.kill()
                proc.wait()
                raise RenderError(
                    "timeout",
                    f"O processamento excedeu o tempo máximo de {timeout_s / 60:.0f} min",
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
        raise RenderError("ffmpeg_error", stderr[-500:] or "O ffmpeg terminou com erro")

    return time.monotonic() - started


def render(recipe, inputs, output_path,
           is_cancelled=lambda: False,
           sleep=time.sleep,
           timeout_s=None):
    """
    Executa o render. Lança RenderError em caso de falha e RenderCancelled
    se o utilizador cancelar. Sem `timeout_s`, o limite é
    max(VIDEO_TASK_TIMEOUT, 2 x duração final).
    """
    for path in inputs.values():
        if not os.path.exists(path):
            raise RenderError("invalid_input", "Um vídeo de origem não foi encontrado")

    infos = {video_id: probe(path) for video_id, path in inputs.items()}
    cmd, expected = build_ffmpeg_cmd(recipe, infos, inputs, output_path)

    elapsed = run_ffmpeg(cmd, is_cancelled, sleep, timeout_for(expected) if timeout_s is None else timeout_s)

    if not os.path.exists(output_path) or os.path.getsize(output_path) == 0:
        raise RenderError("ffmpeg_error", "O ffmpeg não produziu o ficheiro de saída")

    info_out = probe(output_path)

    drift = av_drift(info_out)
    if drift is not None and drift >= AV_SYNC_THRESHOLD_S:
        raise RenderError(
            "av_sync",
            f"Desfasamento áudio/vídeo de {drift * 1000:.0f} ms no resultado",
        )

    return {
        "duration": _duration(info_out),
        "expectedDuration": expected,
        "avDrift": drift,
        "processingTime": elapsed,
    }
