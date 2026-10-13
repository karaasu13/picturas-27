"""
Testes do corte de vídeo. Precisam do ffmpeg instalado.

    cd Tools/video_cut && python -m unittest -v test_cutter
"""

import os
import shutil
import subprocess
import tempfile
import time
import unittest

from cutter import CutCancelled, CutError, av_drift, build_ffmpeg_cmd, cut_video, probe


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


def video_stream(info):
    return next(s for s in info["streams"] if s["codec_type"] == "video")


class CutVideoTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="video-cut-test-")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def _path(self, name):
        return os.path.join(self.tmp, name)

    def _check_cut(self, src, dst, start, end):
        result = cut_video(src, dst, start, end)

        info_in = probe(src)
        info_out = probe(dst)
        v_in, v_out = video_stream(info_in), video_stream(info_out)

        expected = float(info_in["format"]["duration"]) - (end - start)
        self.assertAlmostEqual(float(info_out["format"]["duration"]), expected, delta=0.15)

        # Mantém codec, resolução e taxa de fotogramas (REQ-VID-CUT-025)
        self.assertEqual(v_out["codec_name"], v_in["codec_name"])
        self.assertEqual((v_out["width"], v_out["height"]), (v_in["width"], v_in["height"]))
        self.assertEqual(v_out["avg_frame_rate"], v_in["avg_frame_rate"])
        return result, info_out

    def test_mp4_h264_with_audio(self):
        src, dst = self._path("in.mp4"), self._path("out.mp4")
        make_video(src)
        result, info = self._check_cut(src, dst, 3.0, 6.5)
        self.assertIn("mp4", info["format"]["format_name"])
        self.assertTrue(any(s["codec_type"] == "audio" for s in info["streams"]))
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
        self.assertFalse(any(s["codec_type"] == "audio" for s in info["streams"]))

    def test_interval_out_of_bounds(self):
        src = self._path("bounds.mp4")
        make_video(src, seconds=6)
        with self.assertRaises(CutError) as ctx:
            cut_video(src, self._path("bounds_out.mp4"), 2.0, 99.0)
        self.assertEqual(ctx.exception.code, "invalid_input")

    def test_missing_input(self):
        with self.assertRaises(CutError):
            cut_video(self._path("nope.mp4"), self._path("nope_out.mp4"), 1.0, 2.0)

    def test_cancel_stops_ffmpeg(self):
        src = self._path("cancel.mp4")
        make_video(src, seconds=40, size="1280x720")
        with self.assertRaises(CutCancelled):
            cut_video(src, self._path("cancel_out.mp4"), 5.0, 10.0, is_cancelled=lambda: True)

    def test_av_drift_detection(self):
        def info(v, a, fmt="mov,mp4,m4a,3gp,3g2,mj2"):
            return {
                "format": {"format_name": fmt},
                "streams": [
                    {"codec_type": "video", "duration": str(v)},
                    {"codec_type": "audio", "duration": str(a)},
                ],
            }

        # Desfasamento que já existia no original não conta
        self.assertAlmostEqual(av_drift(info(10.0, 10.1), info(7.0, 7.1)), 0.0, places=6)
        # Desfasamento novo de 80 ms é detetado
        self.assertAlmostEqual(av_drift(info(10.0, 10.0), info(7.0, 7.08)), 0.08, places=6)
        # AVI: sem medição fiável
        self.assertIsNone(av_drift(info(10.0, 10.0, "avi"), info(7.0, 7.2, "avi")))

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
        cut_video(src, dst, 3.0, 6.0)
        self.assertGreater(self._psnr(dst, 1, src, 1), 35)  # antes do corte
        self.assertGreater(self._psnr(dst, 3, src, 6), 35)  # depois do corte
        self.assertLess(self._psnr(dst, 3, src, 3), 30)     # o segmento saiu

    def test_memory_stays_bounded(self):
        # Regressão: com trim+concat no vídeo, o ffmpeg guardava em memória
        # todos os fotogramas depois do corte (vários GB em vídeos HD)
        src = self._path("mem.mp4")
        make_video(src, seconds=40, size="1280x720")
        cmd = build_ffmpeg_cmd(probe(src), src, self._path("mem_out.mp4"), 3.0, 6.0)
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
        with self.assertRaises(CutError) as ctx:
            cut_video(src, self._path("timeout_out.mp4"), 5.0, 10.0, timeout_s=0)
        self.assertEqual(ctx.exception.code, "timeout")


if __name__ == "__main__":
    unittest.main()
