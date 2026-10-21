"""
Testes do motor de render e da pré-visualização. Precisam do ffmpeg instalado.

    cd Tools/video_render && python3 -m unittest -v test_renderer

Os casos do antigo test_cutter.py (corte de um segmento intermédio) estão
aqui expressos como receitas de 2 clips.
"""

import json
import os
import shutil
import subprocess
import tempfile
import time
import unittest

from preview import make_preview
from renderer import (
    RenderCancelled,
    RenderError,
    av_drift,
    build_ffmpeg_cmd,
    probe,
    render,
)


def make_video(path, seconds=12, codec="libx264", audio=True, size="320x240", fps="25"):
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", f"testsrc=size={size}:rate={fps}:duration={seconds}",
    ]
    if audio:
        cmd += ["-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=44100:duration={seconds}"]
    cmd += ["-c:v", codec, "-preset", "ultrafast", "-pix_fmt", "yuv420p"]
    if audio:
        cmd += ["-c:a", "libmp3lame" if path.endswith(".avi") else "aac", "-shortest"]
    cmd.append(path)
    subprocess.run(cmd, check=True)


def stream(info, kind):
    return next((s for s in info["streams"] if s["codec_type"] == kind), None)


def video_duration(info):
    v = stream(info, "video")
    if v.get("duration"):
        return float(v["duration"])
    return float(info["format"]["duration"])


def clip(start, end, posicao, speed=1, video_id="src", link_id=None):
    return {"link_id": link_id or f"{video_id}-{posicao}", "video_id": video_id,
            "in": start, "out": end, "speed": speed, "posicao": posicao}


def recipe(video, audio, largura=320, altura=240, formato="mp4", fit="pad", qualidade="alta"):
    return {
        "output": {"formato": formato, "qualidade": qualidade, "largura": largura, "altura": altura, "fit": fit},
        "faixas": [{"tipo": "video", "clips": video}, {"tipo": "audio", "clips": audio}],
    }


def cut_recipe(src, start, end):
    """Eliminar [start, end]: o que era o corte do UC-VID-001."""
    info = probe(src)
    v = stream(info, "video")
    duration = float(info["format"]["duration"])
    clips = [clip(0, start, 0), clip(end, duration, start)]
    audio = [dict(c) for c in clips] if stream(info, "audio") else []
    return recipe(clips, audio, v["width"], v["height"], os.path.splitext(src)[1][1:])


def lavfi_value(path, filters, key, ss=0.0):
    """Primeiro valor de uma métrica do signalstats/volumedetect no instante ss."""
    out = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostdin", "-ss", str(ss), "-i", path, *filters, "-f", "null", "-"],
        capture_output=True, text=True, check=True,
    )
    line = next(l for l in out.stderr.splitlines() if key in l)
    return float(line.split(key)[1].strip(" :=").split()[0])


def y_avg(path, ss, crop=None):
    vf = (f"crop={crop}," if crop else "") + "signalstats,metadata=print:key=lavfi.signalstats.YAVG"
    return lavfi_value(path, ["-vf", vf, "-frames:v", "1"], "lavfi.signalstats.YAVG", ss)


def max_volume(path, ss, t):
    return lavfi_value(path, ["-t", str(t), "-af", "volumedetect", "-vn"], "max_volume", ss)


class RenderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="video-render-test-")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def _path(self, name):
        return os.path.join(self.tmp, name)

    def _check(self, result, dst, expected, fps=25):
        """Duração ±1 fotograma e áudio/vídeo alinhados (< 50 ms)."""
        info = probe(dst)
        self.assertAlmostEqual(video_duration(info), expected, delta=1 / fps + 1e-6)
        if stream(info, "audio") and "avi" not in info["format"]["format_name"]:
            self.assertLess(result["avDrift"], 0.05)
        return info

    # -------------------------------------------------- casos do antigo corte

    def _check_cut(self, src, dst, start, end):
        result = render(cut_recipe(src, start, end), {"src": src}, dst)

        info_in = probe(src)
        v_in = stream(info_in, "video")
        info_out = self._check(result, dst, float(info_in["format"]["duration"]) - (end - start))
        v_out = stream(info_out, "video")

        # Mantém codec, resolução e taxa de fotogramas
        self.assertEqual(v_out["codec_name"], v_in["codec_name"])
        self.assertEqual((v_out["width"], v_out["height"]), (v_in["width"], v_in["height"]))
        self.assertEqual(v_out["avg_frame_rate"], v_in["avg_frame_rate"])
        return result, info_out

    def test_mp4_h264_with_audio(self):
        src, dst = self._path("in.mp4"), self._path("out.mp4")
        make_video(src)
        result, info = self._check_cut(src, dst, 3.0, 6.5)
        self.assertIn("mp4", info["format"]["format_name"])
        self.assertIsNotNone(stream(info, "audio"))
        self.assertLess(result["avDrift"], 0.05)

    def test_mov_hevc(self):
        src, dst = self._path("in.mov"), self._path("out.mov")
        make_video(src, codec="libx265")
        self._check_cut(src, dst, 2.0, 4.0)

    def test_avi_h264(self):
        src, dst = self._path("in.avi"), self._path("out.avi")
        make_video(src)
        _, info = self._check_cut(src, dst, 4.0, 7.0)
        self.assertEqual(info["format"]["format_name"], "avi")

    def test_mp4_without_audio(self):
        src, dst = self._path("noaudio.mp4"), self._path("noaudio_out.mp4")
        make_video(src, audio=False)
        _, info = self._check_cut(src, dst, 1.5, 3.0)
        self.assertIsNone(stream(info, "audio"))

    def test_interval_out_of_bounds(self):
        src = self._path("bounds.mp4")
        make_video(src, seconds=6)
        with self.assertRaises(RenderError) as ctx:
            render(cut_recipe(src, 2.0, 99.0), {"src": src}, self._path("bounds_out.mp4"))
        self.assertEqual(ctx.exception.code, "invalid_input")

    def test_missing_input(self):
        with self.assertRaises(RenderError):
            render(recipe([clip(1, 2, 0)], []), {"src": self._path("nope.mp4")}, self._path("nope_out.mp4"))

    def test_cancel_stops_ffmpeg(self):
        src = self._path("cancel.mp4")
        make_video(src, seconds=40, size="1280x720")
        with self.assertRaises(RenderCancelled):
            render(cut_recipe(src, 5.0, 10.0), {"src": src}, self._path("cancel_out.mp4"), is_cancelled=lambda: True)

    def test_av_drift_detection(self):
        def info(v, a, fmt="mov,mp4,m4a,3gp,3g2,mj2"):
            return {
                "format": {"format_name": fmt},
                "streams": [
                    {"codec_type": "video", "duration": str(v)},
                    {"codec_type": "audio", "duration": str(a)},
                ],
            }

        self.assertAlmostEqual(av_drift(info(7.0, 7.0)), 0.0, places=6)
        # Desfasamento de 80 ms é detetado
        self.assertAlmostEqual(av_drift(info(7.0, 7.08)), 0.08, places=6)
        # AVI: sem medição fiável
        self.assertIsNone(av_drift(info(7.0, 7.2, "avi")))

    def _psnr(self, a, a_start, b, b_start, seconds=1):
        out = subprocess.run(
            [
                "ffmpeg", "-hide_banner", "-nostdin",
                "-ss", str(a_start), "-t", str(seconds), "-i", a,
                "-ss", str(b_start), "-t", str(seconds), "-i", b,
                "-lavfi", "[0:v][1:v]psnr", "-f", "null", "-",
            ],
            capture_output=True, text=True, check=True,
        )
        line = next(l for l in out.stderr.splitlines() if "PSNR" in l)
        return float(line.split("average:")[1].split()[0])

    def test_content_after_cut_is_from_after_the_segment(self):
        # O que vem a seguir ao corte tem de ser o original a partir de `end`
        src, dst = self._path("content.mp4"), self._path("content_out.mp4")
        make_video(src, seconds=12)
        render(cut_recipe(src, 3.0, 6.0), {"src": src}, dst)
        self.assertGreater(self._psnr(dst, 1, src, 1), 35)  # antes do corte
        self.assertGreater(self._psnr(dst, 3, src, 6), 35)  # depois do corte
        self.assertLess(self._psnr(dst, 3, src, 3), 30)     # o segmento saiu

    def test_memory_stays_bounded(self):
        # Regressão: com trim+concat sobre um só -i, o ffmpeg guardava em
        # memória todos os fotogramas depois do corte (vários GB em vídeos HD)
        src = self._path("mem.mp4")
        make_video(src, seconds=40, size="1280x720")
        cmd, _ = build_ffmpeg_cmd(cut_recipe(src, 3.0, 6.0), {"src": probe(src)}, {"src": src}, self._path("mem_out.mp4"))
        proc = subprocess.Popen(cmd)
        peak_kb = 0
        while proc.poll() is None:
            try:
                with open(f"/proc/{proc.pid}/status") as f:
                    for line in f:
                        if line.startswith("VmRSS"):
                            peak_kb = max(peak_kb, int(line.split()[1]))
            except FileNotFoundError:
                pass
            time.sleep(0.05)
        self.assertEqual(proc.returncode, 0)
        self.assertLess(peak_kb / 1024, 600)

    def test_timeout(self):
        src = self._path("timeout.mp4")
        make_video(src, seconds=40, size="1280x720")
        with self.assertRaises(RenderError) as ctx:
            render(cut_recipe(src, 5.0, 10.0), {"src": src}, self._path("timeout_out.mp4"), timeout_s=0)
        self.assertEqual(ctx.exception.code, "timeout")

    # ------------------------------------------------------ velocidade

    def test_speed_2x_and_half(self):
        src = self._path("speed.mp4")
        make_video(src, seconds=8)
        for speed, expected in ((2, 3.0), (0.5, 12.0)):
            dst = self._path(f"speed_{speed}.mp4")
            c = clip(1, 7, 0, speed=speed)
            result = render(recipe([c], [dict(c)]), {"src": src}, dst)
            info = self._check(result, dst, expected)
            self.assertIsNotNone(stream(info, "audio"))
            self.assertAlmostEqual(float(stream(info, "audio")["duration"]), expected, delta=0.05)
        # A 2x, o instante 1 s do resultado é o 1 + 1x2 = 3 s do original
        self.assertGreater(self._psnr(self._path("speed_2.mp4"), 1, src, 3, seconds=0.04), 35)

    # ------------------------------------------------------ concatenação

    def test_concat_mixed_sources_without_drift(self):
        a, b = self._path("cat_a.mp4"), self._path("cat_b.mp4")
        make_video(a, seconds=10)
        make_video(b, seconds=4, size="640x360", fps="30", audio=False)

        video = [clip(0, 2, 0, video_id="a"), clip(0, 3, 2, video_id="b")]
        # 6 clips de 1,01 s: sem as fronteiras na grelha de fotogramas, cada
        # clip perdia 10 ms de vídeo e o áudio ficava 60 ms à frente no fim
        pos = 5.0
        for i in range(6):
            video.append(clip(2 + i * 1.01, 3.01 + i * 1.01, pos, video_id="a"))
            pos += 1.01
        audio = [dict(c) for c in video if c["video_id"] == "a"]  # o "b" não tem áudio

        dst = self._path("cat_out.mp4")
        result = render(recipe(video, audio, 640, 360), {"a": a, "b": b}, dst)
        info = self._check(result, dst, pos)

        v = stream(info, "video")
        self.assertEqual((v["width"], v["height"]), (640, 360))
        self.assertEqual(v["avg_frame_rate"], "25/1")  # o do primeiro clip
        self.assertLess(max_volume(dst, 2.2, 2.6), -60)    # silêncio no vídeo sem áudio
        self.assertGreater(max_volume(dst, 5.2, 0.6), -30)  # o seno de "a" depois
        self.assertAlmostEqual(float(stream(info, "audio")["duration"]), pos, delta=0.05)

    # ------------------------------------------------- conversão de formato

    def test_mov_hevc_exported_to_avi_becomes_h264_mp3(self):
        # UC-003: ao mudar de formato o vídeo passa a H.264; nunca HEVC em AVI
        src, dst = self._path("conv.mov"), self._path("conv_out.avi")
        make_video(src, seconds=4, codec="libx265")
        c = clip(0, 4, 0)
        result = render(recipe([c], [dict(c)], formato="avi"), {"src": src}, dst)
        info = self._check(result, dst, 4.0)
        self.assertEqual(info["format"]["format_name"], "avi")
        self.assertEqual(stream(info, "video")["codec_name"], "h264")
        self.assertEqual(stream(info, "audio")["codec_name"], "mp3")

        # Mesmo formato (MOV -> MOV): mantém o HEVC da origem
        same = self._path("conv_same.mov")
        render(recipe([c], [dict(c)], formato="mov"), {"src": src}, same)
        self.assertEqual(stream(probe(same), "video")["codec_name"], "hevc")

    # -------------------------------------------------- reenquadramento

    def test_reframe_pad_and_crop(self):
        src = self._path("frame.mp4")
        make_video(src, seconds=3)  # 320x240 (4:3)

        pad = self._path("pad.mp4")
        c = clip(0, 3, 0)
        self._check(render(recipe([c], [dict(c)], 640, 360, fit="pad"), {"src": src}, pad), pad, 3.0)
        v = stream(probe(pad), "video")
        self.assertEqual((v["width"], v["height"]), (640, 360))
        self.assertLess(y_avg(pad, 1, crop="60:360:0:0"), 20)       # barra preta à esquerda
        self.assertGreater(y_avg(pad, 1, crop="200:300:220:30"), 30)  # imagem ao centro

        crop = self._path("crop.mp4")
        self._check(render(recipe([c], [dict(c)], 240, 240, fit="crop"), {"src": src}, crop), crop, 3.0)
        v = stream(probe(crop), "video")
        self.assertEqual((v["width"], v["height"]), (240, 240))
        self.assertGreater(y_avg(crop, 1, crop="20:240:0:0"), 30)  # sem barras

    # ---------------------------------------- buracos e áudio desligado

    def test_gaps_are_black_and_silent(self):
        src = self._path("gaps.mp4")
        make_video(src, seconds=6)
        # vídeo de 1 s a 4 s; áudio desligado, movido para 2 s a 4 s
        video = [clip(0, 3, 1, link_id="v")]
        audio = [clip(0, 2, 2, link_id="a")]
        dst = self._path("gaps_out.mp4")
        info = self._check(render(recipe(video, audio), {"src": src}, dst), dst, 4.0)
        self.assertLess(y_avg(dst, 0.2), 20)          # preto antes do primeiro clip
        self.assertGreater(y_avg(dst, 1.5), 30)
        self.assertLess(max_volume(dst, 0, 1.8), -60)  # silêncio antes do áudio
        self.assertGreater(max_volume(dst, 2.2, 1.6), -30)
        self.assertAlmostEqual(float(stream(info, "audio")["duration"]), 4.0, delta=0.05)

    def test_more_than_one_track_per_type_is_rejected(self):
        src = self._path("tracks.mp4")
        make_video(src, seconds=3)
        r = recipe([clip(0, 1, 0)], [])
        r["faixas"].append({"tipo": "video", "clips": [clip(0, 1, 0)]})
        with self.assertRaises(RenderError):
            render(r, {"src": src}, self._path("tracks_out.mp4"))

    # -------------------------------------------------- pré-visualização

    def test_make_preview(self):
        src = self._path("prev.mov")
        make_video(src, seconds=6, codec="libx265", size="1280x720")
        out = tempfile.mkdtemp(dir=self.tmp)
        meta = make_preview(src, out)

        info = probe(os.path.join(out, "proxy.mp4"))
        v = stream(info, "video")
        self.assertEqual(v["codec_name"], "h264")
        self.assertEqual((v["width"], v["height"]), (854, 480))
        self.assertAlmostEqual(video_duration(info), 6.0, delta=1 / 25 + 1e-6)
        self.assertIsNotNone(stream(info, "audio"))

        s = meta["sprite"]
        self.assertEqual(s["count"], 6)
        self.assertEqual(s["height"], 90)
        self.assertEqual(stream(probe_image(os.path.join(out, "sprite.jpg")), "video")["width"], s["width"] * s["cols"])

        with open(os.path.join(out, "waveform.json")) as f:
            wave = json.load(f)
        self.assertAlmostEqual(len(wave["peaks"]), 6 * wave["rate"], delta=2)
        self.assertGreater(max(wave["peaks"]), 5)
        self.assertFalse(os.path.exists(os.path.join(out, "waveform.raw")))

        # Sem áudio: não há forma de onda; vídeo pequeno não é ampliado
        mute = self._path("prev_mute.mp4")
        make_video(mute, seconds=2, audio=False)
        out2 = tempfile.mkdtemp(dir=self.tmp)
        self.assertFalse(make_preview(mute, out2)["hasWaveform"])
        self.assertFalse(os.path.exists(os.path.join(out2, "waveform.json")))
        v = stream(probe(os.path.join(out2, "proxy.mp4")), "video")
        self.assertEqual((v["width"], v["height"]), (320, 240))


def probe_image(path):
    from renderer import ffprobe_json
    return ffprobe_json(path)


if __name__ == "__main__":
    unittest.main()
