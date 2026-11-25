"""Acoplamento de implantação dos efeitos de vídeo (RNF-1, métrica M2).

Pára um serviço do Docker Compose, submete um vídeo curto por cada um dos 12
efeitos de vídeo (um projeto por efeito, todos ao mesmo tempo) e conta quantos
ficam por concluir dentro do tempo limite. No fim volta a arrancar o serviço.

  python availability.py --stop video_tool --label baseline --out ../baseline
  python availability.py --stop <serviço de legendas> --label final --out ../final

Sem --stop mede só a disponibilidade com tudo a correr (deve dar 0 % indisponível).

Gerado com apoio de IA (Claude) e revisto pela equipa PL3-G1.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

from picturas_client import ApiError, Client, repo_path, sample
from regression import FRAME_TOOLS, FRAMES5, IMG, V10, substitute

EFFECTS = {
    **FRAME_TOOLS,
    "trim": {"start": 1, "end": 4, "imgId": IMG},
    "speed": {"factor": 2, "imgId": IMG},
    "subtitles": {},
    "extract_frames": FRAMES5,
}


def compose(repo: Path, *args: str) -> None:
    subprocess.run(["docker", "compose", *args], cwd=repo, check=True, timeout=300)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--stop", default="", help="serviço(s) do compose a parar, separados por vírgulas")
    ap.add_argument("--label", required=True)
    ap.add_argument("--out", default="../baseline")
    ap.add_argument("--repo", default=None)
    ap.add_argument("--timeout", type=float, default=600, help="tempo de espera pelos 12 trabalhos (s)")
    args = ap.parse_args()

    repo = repo_path(args.repo)
    stopped = [s.strip() for s in args.stop.split(",") if s.strip()]
    out_dir = Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    # um utilizador por efeito: os eventos de conclusão chegam por utilizador
    jobs = {}
    src = sample(repo, V10)
    for name, params in EFFECTS.items():
        c = Client().register("premium").connect_socket()
        pid = c.create_project(f"m2-{name}")
        c.upload(pid, src)
        img_id = str(c.media_ids(pid)[0]["_id"])
        c.add_tool(pid, name, substitute(params, img_id))
        jobs[name] = {"client": c, "pid": pid}

    result = {}
    try:
        if stopped:
            compose(repo, "stop", *stopped)
            time.sleep(5)
        t0 = time.monotonic()
        for name, job in jobs.items():
            job["client"].events.reset()
            try:
                job["client"].start_process(job["pid"])
                job["started"] = True
            except ApiError as e:
                job["started"] = False
                result[name] = {"available": False, "detail": f"HTTP {e.status}"}
        pending = {n for n, j in jobs.items() if j.get("started")}
        while pending and time.monotonic() - t0 < args.timeout:
            for name in list(pending):
                ev = jobs[name]["client"].events
                with ev.lock:
                    done, err = len(ev.updates) >= 1, list(ev.errors)
                if done or err:
                    pending.discard(name)
                    result[name] = {"available": bool(done and not err),
                                    "seconds": round(time.monotonic() - t0, 1),
                                    "detail": "ok" if done and not err else f"erro {err[0][1]}"}
            time.sleep(0.2)
        for name in pending:
            result[name] = {"available": False, "detail": f"sem resposta em {args.timeout:.0f} s"}
    finally:
        for job in jobs.values():
            job["client"].cancel(job["pid"])
        if stopped:
            compose(repo, "start", *stopped)
        time.sleep(3)
        for job in jobs.values():
            job["client"].close()
            job["client"].delete_account()

    unavailable = sorted(n for n, r in result.items() if not r["available"])
    pct = round(100 * len(unavailable) / len(EFFECTS), 1)
    report = {"label": args.label, "measured_at": datetime.now(timezone.utc).isoformat(),
              "stopped_services": stopped, "effects": len(EFFECTS), "unavailable": unavailable,
              "unavailable_pct": pct, "detail": result}
    name = "-".join(stopped) or "nenhum"
    target = out_dir / f"m2-{args.label}-{name}.json"
    target.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Serviços parados: {stopped or 'nenhum'}")
    print(f"Efeitos indisponíveis: {len(unavailable)}/{len(EFFECTS)} = {pct} %  {unavailable}")
    print(f"Resultado: {target}")


if __name__ == "__main__":
    main()
