"""Testes de regressão ponta a ponta (preservação funcional, imagem e vídeo).

Funcionam por comparação: `record` executa todos os casos na solução de base e
guarda o que foi observado (estado, códigos de erro, características dos
resultados); `check` repete os mesmos casos depois do refactoring e compara.

  python regression.py record --out ../baseline      # no commit base
  python regression.py check  --ref ../baseline/regressao-referencia.json --out ../final

Regras de comparação:
  - estado, fase em que falhou, código HTTP e código de erro: iguais; a mensagem
    tem de ser igual nas recusas da API e só gera aviso nas falhas internas;
  - imagens resultantes de imagens: mesmo SHA-256 (as ferramentas de imagem não mudam);
  - vídeos: mesma resolução e codecs, duração com diferença <= 0,1 s e n.º de
    fotogramas com diferença <= 1 (o SHA-256 é registado, mas só informa);
  - fotogramas extraídos: mesmo número e mesmas dimensões; SHA-256 exigido só
    quando a extração é feita diretamente sobre o original.

As ferramentas de IA de imagem não são exercitadas: não são tocadas pelo
refactoring e demoram muito. `--only` filtra casos pelo prefixo do nome.

Gerado com apoio de IA (Claude) e revisto pela equipa PL3-G1.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from picturas_client import ApiError, Client, ffprobe, make_png, png_size, repo_path, sample, sha256

V10 = "sample_10s_720p.mp4"
MOV = "sample_6s.mov"
SPEECH = "speech_mandela_177s_1080p.webm"
IMG = "$IMG"  # substituído pelo identificador do primeiro vídeo do projeto

FRAME_TOOLS = {
    "brightness": {"brightness": 1.3},
    "contrast": {"contrastFactor": 1.4},
    "saturation": {"saturationFactor": 0.5},
    "binarization": {"threshold": 128},
    "rotate": {"degrees": 90},
    "resize": {"width": 160, "height": 120},
    "cut": {"left": 20, "top": 20, "right": 200, "bottom": 160},
    "border": {"borderWidth": 10, "r": 255, "g": 0, "b": 0},
}
FRAMES5 = {"mode": "count", "count": 5, "interval": 1, "format": "png"}


def cases() -> list[dict]:
    c = []
    # --- imagens: cada ferramenta básica e um encadeamento ---
    for name, params in FRAME_TOOLS.items():
        c.append({"name": f"img-{name}", "media": ["png"], "tools": [(name, params)]})
    c.append({"name": "img-chain", "media": ["png"],
              "tools": [("brightness", FRAME_TOOLS["brightness"]), ("rotate", FRAME_TOOLS["rotate"]),
                        ("border", FRAME_TOOLS["border"])]})
    # --- vídeo: cada efeito por fotograma ---
    for name, params in FRAME_TOOLS.items():
        c.append({"name": f"vid-{name}", "media": [V10], "tools": [(name, params)]})
    # --- vídeo: efeitos temporais, encadeamentos, formatos ---
    c += [
        {"name": "vid-trim", "media": [V10], "tools": [("trim", {"start": 2, "end": 6, "imgId": IMG})]},
        {"name": "vid-speed-2x", "media": [V10], "tools": [("speed", {"factor": 2, "imgId": IMG})]},
        {"name": "vid-speed-0.5x", "media": [V10], "tools": [("speed", {"factor": 0.5, "imgId": IMG})]},
        {"name": "vid-trim-speed-brightness", "media": [V10],
         "tools": [("trim", {"start": 1, "end": 7, "imgId": IMG}), ("speed", {"factor": 2, "imgId": IMG}),
                   ("brightness", FRAME_TOOLS["brightness"])]},
        {"name": "vid-mov-input", "media": [MOV], "tools": [("contrast", FRAME_TOOLS["contrast"])]},
        {"name": "vid-two-videos", "media": [V10, MOV], "tools": [("saturation", FRAME_TOOLS["saturation"])]},
        {"name": "mix-image-and-video", "media": ["png", V10], "tools": [("brightness", FRAME_TOOLS["brightness"])]},
        {"name": "mix-video-only-tool", "media": ["png", V10], "tools": [("trim", {"start": 0, "end": 3, "imgId": IMG})]},
        # --- legendas (vídeo com fala, encurtado por um corte) ---
        {"name": "sub-trim-subtitles", "media": [SPEECH],
         "tools": [("trim", {"start": 0, "end": 20, "imgId": IMG}), ("subtitles", {})]},
        {"name": "sub-middle-of-pipeline", "media": [SPEECH],
         "tools": [("trim", {"start": 0, "end": 15, "imgId": IMG}), ("subtitles", {}),
                   ("brightness", FRAME_TOOLS["brightness"])]},
        {"name": "sub-no-speech", "media": [V10], "tools": [("subtitles", {})]},
        # --- extração de fotogramas ---
        {"name": "frames-from-original", "media": [V10], "tools": [("extract_frames", FRAMES5)], "strict_frames": True},
        {"name": "frames-after-edits", "media": [V10],
         "tools": [("trim", {"start": 2, "end": 8, "imgId": IMG}), ("brightness", FRAME_TOOLS["brightness"]),
                   ("extract_frames", FRAMES5)]},
        {"name": "frames-inserted-before-terminal", "media": [V10],
         "tools": [("extract_frames", FRAMES5), ("contrast", FRAME_TOOLS["contrast"])]},
        # --- pré-visualização ---
        {"name": "preview-brightness", "media": [V10], "tools": [("brightness", FRAME_TOOLS["brightness"])], "mode": "preview"},
        {"name": "preview-trim-speed", "media": [V10],
         "tools": [("trim", {"start": 4, "end": 10, "imgId": IMG}), ("speed", {"factor": 2, "imgId": IMG})],
         "mode": "preview"},
        {"name": "preview-subtitles-then-trim", "media": [SPEECH],
         "tools": [("subtitles", {}), ("trim", {"start": 5, "end": 12, "imgId": IMG})], "mode": "preview"},
        {"name": "preview-frames", "media": [V10], "tools": [("extract_frames", FRAMES5)], "mode": "preview"},
        # --- erros ---
        {"name": "err-corrupted-upload", "media": ["corrupted.mp4"], "tools": []},
        {"name": "err-too-long-free", "media": ["too_long_90s.mp4"], "tools": [], "user": "free"},
        {"name": "err-image-on-video-endpoint", "media": ["png-as-video"], "tools": []},
        {"name": "err-no-tools", "media": [V10], "tools": []},
        {"name": "err-ai-tool-with-video", "media": [V10], "tools": [("text_ai", {})]},
        {"name": "err-trim-outside-duration", "media": [V10], "tools": [("trim", {"start": 20, "end": 30, "imgId": IMG})]},
        {"name": "err-speed-out-of-range", "media": [V10], "tools": [("speed", {"factor": 50, "imgId": IMG})]},
        {"name": "err-resize-zero", "media": [V10], "tools": [("resize", {"width": 0, "height": 0})]},
        {"name": "err-frames-bad-count", "media": [V10],
         "tools": [("extract_frames", {"mode": "count", "count": 500, "interval": 1, "format": "png"})]},
    ]
    return c


def analyze(data: bytes, repo: Path) -> dict:
    info = {"bytes": len(data), "sha256": sha256(data)}
    size = png_size(data)
    if size:
        info.update(kind="png", size=size)
    elif data[:2] == b"\xff\xd8":
        info.update(kind="jpeg")
    else:
        probe = ffprobe(data, repo)
        info.update(kind="video" if probe else "other", probe=probe)
    return info


def substitute(params: dict, img_id: str | None) -> dict:
    return {k: (img_id if v == IMG else v) for k, v in params.items()}


def api_failure(stage: str, e: ApiError) -> dict:
    body = e.body if isinstance(e.body, str) else json.dumps(e.body, sort_keys=True)
    return {"status": "rejected", "stage": stage, "http": e.status, "message": body}


def run_case(case: dict, client: Client, repo: Path, timeout: float) -> dict:
    pid = client.create_project(f"reg-{case['name']}-{int(time.time())}")
    # 1) media
    for i, media in enumerate(case["media"]):
        try:
            if media == "png":
                client.upload(pid, None, upload_name=f"img{i}.png", data=make_png())
            elif media == "png-as-video":
                # um PNG enviado para o endpoint de vídeo tem de ser recusado
                client._req("POST", f"/projects/{client.uid}/{pid}/video",
                            files={"video": ("img.png", make_png(), "image/png")},
                            headers={"X-Project-Version": client._version(pid)})
            else:
                client.upload(pid, sample(repo, media))
        except ApiError as e:
            return api_failure("upload", e)
    videos = [m for m in client.media_ids(pid) if m.get("media_type") == "video"]
    first_video = str(videos[0]["_id"]) if videos else None
    # 2) pipeline
    for procedure, params in case["tools"]:
        try:
            client.add_tool(pid, procedure, substitute(params, first_video))
        except ApiError as e:
            return api_failure("tool", e)
    pipeline = [t["procedure"] for t in sorted(client.project(pid)["tools"], key=lambda t: t.get("position", 0))]

    client.events.reset()
    t0 = time.monotonic()
    # 3a) pré-visualização do primeiro vídeo
    if case.get("mode") == "preview":
        try:
            client.start_preview(pid, first_video)
        except ApiError as e:
            return {**api_failure("preview", e), "pipeline": pipeline}
        while time.monotonic() - t0 < timeout:
            with client.events.lock:
                ready, errors = list(client.events.previews), list(client.events.preview_errors)
            if errors:
                err = errors[0][1]
                return {"status": "error", "pipeline": pipeline, "error_code": str(err.get("error_code")),
                        "message": err.get("error_msg")}
            if ready:
                payload = ready[0][1]
                data = client.download(payload["imageUrl"])
                return {"status": "ok", "pipeline": pipeline, "media_type": payload.get("mediaType", "image"),
                        "results": [analyze(data, repo)]}
            time.sleep(0.1)
        return {"status": "timeout", "pipeline": pipeline}

    # 3b) processamento completo
    try:
        expected = client.expected_events(pid)
        client.start_process(pid)
    except ApiError as e:
        return {**api_failure("process", e), "pipeline": pipeline}
    res = client.wait_process(pid, expected, t0, timeout)
    if res["status"] == "error":
        err = res.get("error") or {}
        return {"status": "error", "pipeline": pipeline, "error_code": str(err.get("error_code")),
                "message": err.get("error_msg")}
    if res["status"] != "ok":
        return {"status": res["status"], "pipeline": pipeline}

    time.sleep(1.0)  # o último resultado é publicado logo a seguir ao evento
    out = client.results(pid)
    results = []
    for item in out.get("imgs", []):
        results.append({"type": item.get("type"), **analyze(client.download(item["url"]), repo)})
    # ordem estável mesmo quando os bytes mudam: tipo, características, e só depois o SHA-256
    results.sort(key=lambda r: (str(r.get("type")), r.get("kind"),
                                json.dumps(r.get("probe") or r.get("size"), sort_keys=True), r["sha256"]))
    return {"status": "ok", "pipeline": pipeline, "seconds": round(res["seconds"], 1),
            "results": results, "texts": len(out.get("texts", []))}


def compare(name: str, ref: dict, new: dict, strict_frames: bool) -> tuple[list[str], list[str]]:
    """Devolve (falhas, avisos)."""
    fails, notes = [], []
    for key in ("status", "stage", "http", "error_code", "pipeline", "media_type", "texts"):
        if ref.get(key) != new.get(key):
            fails.append(f"{key}: esperado {ref.get(key)!r}, obtido {new.get(key)!r}")
    if ref.get("message") != new.get("message"):
        # mensagens de recusa da API são contrato; as de falha interna podem conter caminhos temporários
        msg = f"mensagem: esperado {ref.get('message')!r}, obtido {new.get('message')!r}"
        (fails if ref.get("status") == "rejected" else notes).append(msg)
    a, b = ref.get("results") or [], new.get("results") or []
    if len(a) != len(b):
        fails.append(f"n.º de resultados: esperado {len(a)}, obtido {len(b)}")
        return fails, notes
    source_is_image = name.startswith("img-")
    for i, (ra, rb) in enumerate(zip(a, b)):
        if ra.get("kind") != rb.get("kind") or ra.get("type") != rb.get("type"):
            fails.append(f"resultado {i}: tipo {ra.get('type')}/{ra.get('kind')} -> {rb.get('type')}/{rb.get('kind')}")
            continue
        if ra["kind"] == "video":
            pa, pb = ra.get("probe") or {}, rb.get("probe") or {}
            for key in ("width", "height", "video_codec", "audio_codec"):
                if pa.get(key) != pb.get(key):
                    fails.append(f"resultado {i}: {key} {pa.get(key)} -> {pb.get(key)}")
            if abs((pa.get("duration") or 0) - (pb.get("duration") or 0)) > 0.1:
                fails.append(f"resultado {i}: duração {pa.get('duration')} -> {pb.get('duration')}")
            if abs((pa.get("frames") or 0) - (pb.get("frames") or 0)) > 1:
                fails.append(f"resultado {i}: fotogramas {pa.get('frames')} -> {pb.get('frames')}")
            if ra["sha256"] != rb["sha256"]:
                notes.append(f"resultado {i}: vídeo com bytes diferentes (características iguais)")
        else:
            if ra.get("size") != rb.get("size"):
                fails.append(f"resultado {i}: dimensões {ra.get('size')} -> {rb.get('size')}")
            if ra["sha256"] != rb["sha256"]:
                msg = f"resultado {i}: conteúdo diferente (SHA-256)"
                (fails if (source_is_image or strict_frames) else notes).append(msg)
    return fails, notes


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("mode", choices=["record", "check", "list"])
    ap.add_argument("--out", default="../baseline")
    ap.add_argument("--ref", default="../baseline/regressao-referencia.json")
    ap.add_argument("--repo", default=None)
    ap.add_argument("--only", default="", help="prefixos de casos, separados por vírgulas (ex.: vid-,err-)")
    ap.add_argument("--timeout", type=float, default=1800, help="tempo limite por caso (s)")
    args = ap.parse_args()

    selected = cases()
    if args.only:
        prefixes = tuple(p.strip() for p in args.only.split(",") if p.strip())
        selected = [c for c in selected if c["name"].startswith(prefixes)]
    if args.mode == "list":
        for c in selected:
            print(f"{c['name']:36} {c.get('mode', 'process'):8} {[t[0] for t in c['tools']]}")
        return

    repo = repo_path(args.repo)
    out_dir = Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    reference = {}
    if args.mode == "check":
        reference = json.loads(Path(args.ref).read_text(encoding="utf-8"))["cases"]

    clients = {}
    observed, report, failed = {}, [], 0
    try:
        for case in selected:
            kind = case.get("user", "premium")
            if kind not in clients:
                clients[kind] = Client().register(kind).connect_socket()
            name = case["name"]
            print(f"{name:36} ", end="", flush=True)
            try:
                outcome = run_case(case, clients[kind], repo, args.timeout)
            except Exception as e:  # noqa: BLE001 - um caso partido não pára os restantes
                outcome = {"status": "script-error", "message": f"{type(e).__name__}: {e}"}
            observed[name] = outcome
            if args.mode == "record":
                print(outcome["status"], outcome.get("error_code") or outcome.get("http") or "")
                continue
            if name not in reference:
                print("SEM REFERÊNCIA")
                report.append({"case": name, "verdict": "no-reference"})
                failed += 1
                continue
            fails, notes = compare(name, reference[name], outcome, case.get("strict_frames", False))
            verdict = "FALHOU" if fails else "ok"
            failed += bool(fails)
            print(verdict, ("- " + "; ".join(fails)) if fails else "")
            report.append({"case": name, "verdict": "fail" if fails else "pass", "failures": fails, "notes": notes})
    finally:
        for c in clients.values():
            c.close()
            c.delete_account()

    stamp = datetime.now(timezone.utc).isoformat()
    if args.mode == "record":
        target = out_dir / "regressao-referencia.json"
        if args.only and target.exists():  # gravação parcial: junta aos casos já gravados
            previous = json.loads(target.read_text(encoding="utf-8"))["cases"]
            observed = {**previous, **observed}
        target.write_text(json.dumps({"recorded_at": stamp, "cases": observed}, indent=2, ensure_ascii=False),
                          encoding="utf-8")
        bad = [n for n, o in observed.items() if o["status"] in ("timeout", "script-error")]
        print(f"\nReferência gravada em {target} ({len(observed)} casos).")
        if bad:
            print("ATENÇÃO: casos sem resultado útil (rever antes de usar como referência):", ", ".join(bad))
        return

    target = out_dir / f"regressao-resultado-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
    target.write_text(json.dumps({"checked_at": stamp, "passed": len(report) - failed, "failed": failed,
                                  "report": report, "observed": observed}, indent=2, ensure_ascii=False),
                      encoding="utf-8")
    print(f"\n{len(report) - failed}/{len(report)} casos passaram. Relatório: {target}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
