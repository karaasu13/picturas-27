import sys, json, hashlib, os, subprocess
from types import SimpleNamespace
which, root, src, speech, outdir = sys.argv[1:6]
sys.path.insert(0, root)
if which == "old":
    import subtitles as cap
    from video_processor import process_video
else:
    sys.path.insert(0, os.path.join(root, "tests"))
    from subtitles import captions as cap
    from local_pipeline import process_video
seg = [SimpleNamespace(start=0.5, end=2.0, text="Hello world"), SimpleNamespace(start=2.2, end=3.5, text="Second line")]
cap.speech_model = lambda: SimpleNamespace(transcribe=lambda *a, **k: (iter(seg), None))
T = lambda p, **kw: {"procedure": p, "params": kw}
EX = T("extract_frames", mode="count", count=4, format="png")
cases = {
 "bright": [T("brightness", brightness=1.3)],
 "chain": [T("trim", start=1, end=3.5), T("speed", factor=2), T("rotate", degrees=90), T("border", borderWidth=7, r=1, g=2, b=3)],
 "slow": [T("speed", factor=0.5), T("cut", left=10, top=10, right=211, bottom=131)],
 "sub": [T("subtitles")],
 "sub_mid": [T("trim", start=0, end=3), T("subtitles"), T("binarization", threshold=100), T("subtitles"), T("resize", width=161, height=99)],
 "sub_trim": [T("subtitles"), T("trim", start=1, end=3)],
 "ex": [EX], "ex_edit": [T("contrast", contrastFactor=1.4), EX], "ex_sub": [T("trim", start=0, end=3), T("subtitles"), EX],
 "empty": [],
}
out = {}
def digest(path):
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-f", "framemd5", "-"], capture_output=True, text=True)
    return hashlib.md5("\n".join(l for l in r.stdout.splitlines() if not l.startswith("#")).encode()).hexdigest()
for source_name, source in (("mp4", src), ("mov", speech)):
  for name, tools in cases.items():
    for preview in (False, True):
        key = f"{source_name}-{name}-{'pv' if preview else 'full'}"
        d = os.path.join(outdir, key); os.makedirs(d)
        target = os.path.join(d, "result.mp4")
        prog = []
        try:
            res = process_video(source, target, tools, prog.append, preview=preview)
        except Exception as e:
            out[key] = {"error": type(e).__name__ + ": " + str(e)}; continue
        entry = {"progress_last": prog[-1] if prog else None, "progress_monotonic": prog == sorted(prog), "n_progress": len(prog),
                 "keys": sorted(k for k in res if k not in ("frames", "output_path")), "type": res.get("output_type", "video"),
                 "dur": round(res["duration"], 3), "wh": [res["width"], res["height"]], "leftovers": sorted(x for x in os.listdir(d) if not x.startswith("result"))}
        if entry["type"] == "frames":
            entry["frames"] = [[round(f["time"], 4), hashlib.md5(open(f["file"], "rb").read()).hexdigest()] for f in res["frames"]]
        elif entry["type"] == "image":
            entry["frames"] = hashlib.md5(open(res["output_path"], "rb").read()).hexdigest(); entry["n"] = res["frames"]
        else:
            entry["frames_count"] = res["frames"]; entry["md5"] = digest(target); entry["bytes"] = hashlib.md5(open(target, "rb").read()).hexdigest()
        out[key] = entry
json.dump(out, open(os.path.join(outdir, "summary.json"), "w"), indent=1, sort_keys=True)
