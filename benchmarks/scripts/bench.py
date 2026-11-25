"""Medições de desempenho do processamento de vídeo (RNF-2, métricas P1 a P4).

Cenários (todos pela API pública, com utilizadores premium criados para o efeito):
  S0   1 vídeo de 10 s com brilho, sistema em repouso            -> P4 (caso simples)
  S1   8 vídeos de 10 s com brilho no mesmo projeto              -> P2 (débito), P3 (paralelismo)
  S2R  4 vídeos de 10 s com brilho, sem mais carga               -> referência de P1
  S2   utilizador X pede legendas num vídeo longo; 5 s depois o
       utilizador Y processa os mesmos 4 vídeos de S2R           -> P1 (carga mista), P3

O tempo medido vai do pedido de processamento (POST .../process) até ao último
evento de conclusão recebido por Socket.IO, tal como o utilizador o observa.

Exemplo:
  python bench.py --label baseline --runs 5 --out ../baseline

Gerado com apoio de IA (Claude) e revisto pela equipa PL3-G1.
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import statistics
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

from picturas_client import RABBIT_API, RABBIT_AUTH, Client, QueueSampler, repo_path, sample

LIGHT = "sample_10s_720p.mp4"
HEAVY = "speech_mandela_177s_1080p.webm"
BRIGHTNESS = {"brightness": 1.2}


def wait_idle(timeout: float = 900) -> None:
    """Espera até as filas de vídeo estarem vazias, para cada execução partir do repouso."""
    deadline = time.monotonic() + timeout
    quiet = 0
    while time.monotonic() < deadline:
        try:
            r = requests.get(f"{RABBIT_API}/queues/%2F", auth=RABBIT_AUTH, timeout=5)
            busy = sum(q.get("messages", 0) for q in r.json() if q["name"].startswith("video"))
        except Exception:  # noqa: BLE001 - sem API de gestão: pausa fixa
            time.sleep(10)
            return
        quiet = quiet + 1 if busy == 0 else 0
        if quiet >= 3:  # as estatísticas do RabbitMQ têm atraso de alguns segundos
            return
        time.sleep(3)


def light_project(client: Client, repo: Path, copies: int, tag: str) -> str:
    pid = client.create_project(f"bench-{tag}")
    src = sample(repo, LIGHT)
    for k in range(copies):
        client.upload(pid, src, upload_name=f"{tag}_{k + 1}.mp4")
    client.add_tool(pid, "brightness", BRIGHTNESS)
    return pid


def run_batch(client: Client, pid: str, timeout: float) -> dict:
    expected = client.expected_events(pid)
    client.events.reset()
    t0 = time.monotonic()
    client.start_process(pid)
    res = client.wait_process(pid, expected, t0, timeout)
    res["videos"] = client.per_video_done(t0)
    res["seconds"] = round(res["seconds"], 3)
    return res


def max_parallel(videos: dict, offset: dict | None = None) -> int:
    """Máximo de vídeos em processamento ao mesmo tempo, pelos eventos de progresso
    (intervalo entre o primeiro evento e os 100 % de cada vídeo)."""
    edges = []
    for img_id, v in videos.items():
        if v.get("done_s") is None:
            continue
        shift = (offset or {}).get(img_id, 0.0)
        edges.append((v["first_progress_s"] + shift, 1))
        edges.append((v["done_s"] + shift, -1))
    current = best = 0
    for _, delta in sorted(edges, key=lambda e: (e[0], e[1])):
        current += delta
        best = max(best, current)
    return best


def scenario_light(client: Client, repo: Path, copies: int, tag: str, timeout: float) -> dict:
    pid = light_project(client, repo, copies, tag)
    sampler = QueueSampler()
    sampler.start()
    res = run_batch(client, pid, timeout)
    res["queues"] = sampler.stop()
    res["videos_per_min"] = round(copies * 60 / res["seconds"], 3) if res["status"] == "ok" else None
    res["max_parallel_progress"] = max_parallel(res["videos"])
    return res


def scenario_mixed(x: Client, y: Client, repo: Path, tag: str, heavy_seconds: float, delay: float,
                   timeout: float) -> dict:
    # utilizador X: vídeo longo com legendas (opcionalmente cortado para encurtar a medição)
    pid_x = x.create_project(f"bench-{tag}-x")
    x.upload(pid_x, sample(repo, HEAVY))
    if heavy_seconds > 0:
        img_id = str(x.media_ids(pid_x)[0]["_id"])
        x.add_tool(pid_x, "trim", {"start": 0, "end": heavy_seconds, "imgId": img_id})
    x.add_tool(pid_x, "subtitles", {})
    # utilizador Y: lote leve, igual ao de S2R
    pid_y = light_project(y, repo, 4, f"{tag}-y")

    sampler = QueueSampler()
    sampler.start()
    x.events.reset()
    y.events.reset()
    exp_x, exp_y = x.expected_events(pid_x), y.expected_events(pid_y)

    t0_x = time.monotonic()
    x.start_process(pid_x)
    time.sleep(delay)
    t0_y = time.monotonic()
    y.start_process(pid_y)

    light = y.wait_process(pid_y, exp_y, t0_y, timeout)
    light["videos"] = y.per_video_done(t0_y)
    heavy = x.wait_process(pid_x, exp_x, t0_x, timeout)
    queues = sampler.stop()
    # mesma origem de tempo para os dois utilizadores: o lote leve começou `t0_y - t0_x` depois
    heavy_videos = x.per_video_done(t0_x)
    both = {**heavy_videos, **light["videos"]}
    shift = {img_id: t0_y - t0_x for img_id in light["videos"]}
    return {
        "max_parallel_progress": max_parallel(both, shift),
        "status": "ok" if light["status"] == heavy["status"] == "ok" else "failed",
        "seconds": round(light["seconds"], 3),            # P1: tempo do lote leve sob carga mista
        "heavy_seconds": round(heavy["seconds"], 3),
        "heavy_status": heavy["status"], "light_status": light["status"],
        "light": light, "heavy": heavy, "queues": queues,
    }


def summarize(runs: list[dict], key: str = "seconds") -> dict:
    values = [r[key] for r in runs if r.get("status") == "ok" and r.get(key) is not None]
    if not values:
        return {"n_ok": 0, "n": len(runs)}
    return {"n_ok": len(values), "n": len(runs), "median": round(statistics.median(values), 3),
            "min": round(min(values), 3), "max": round(max(values), 3), "values": values}


def git(repo: Path, *args: str) -> str:
    try:
        return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True, timeout=30).stdout.strip()
    except Exception:  # noqa: BLE001
        return ""


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--label", required=True, help="baseline ou final (fica no nome do ficheiro)")
    ap.add_argument("--runs", type=int, default=5, help="repetições por cenário (mediana)")
    ap.add_argument("--scenarios", default="S0,S1,S2R,S2")
    ap.add_argument("--out", default="../baseline", help="pasta onde guardar os resultados")
    ap.add_argument("--repo", default=None, help="caminho do picturas-27")
    ap.add_argument("--heavy-seconds", type=float, default=60,
                    help="duração do excerto legendado em S2 (0 = vídeo inteiro, 177 s)")
    ap.add_argument("--delay", type=float, default=5, help="atraso entre o pedido pesado e o lote leve em S2")
    ap.add_argument("--timeout", type=float, default=3600, help="tempo limite por execução (s)")
    ap.add_argument("--note", default="", help="nota livre, por exemplo o n.º de réplicas")
    args = ap.parse_args()

    repo = repo_path(args.repo)
    scenarios = [s.strip().upper() for s in args.scenarios.split(",") if s.strip()]
    out_dir = Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    x = Client().register("premium").connect_socket()
    y = Client().register("premium").connect_socket()
    report = {
        "label": args.label, "note": args.note,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "commit": git(repo, "rev-parse", "HEAD"), "branch": git(repo, "rev-parse", "--abbrev-ref", "HEAD"),
        "host": {"platform": platform.platform(), "cpus": os.cpu_count()},
        "params": {"runs": args.runs, "heavy_seconds": args.heavy_seconds, "delay": args.delay},
        "scenarios": {},
    }
    out_file = out_dir / f"bench-{args.label}-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"

    try:
        for name in scenarios:
            runs = []
            for i in range(args.runs):
                wait_idle()
                tag = f"{name.lower()}-{i + 1}-{int(time.time())}"
                print(f"[{name}] execução {i + 1}/{args.runs} ...", flush=True)
                if name == "S0":
                    res = scenario_light(y, repo, 1, tag, args.timeout)
                elif name == "S1":
                    res = scenario_light(y, repo, 8, tag, args.timeout)
                elif name == "S2R":
                    res = scenario_light(y, repo, 4, tag, args.timeout)
                elif name == "S2":
                    res = scenario_mixed(x, y, repo, tag, args.heavy_seconds, args.delay, args.timeout)
                else:
                    raise SystemExit(f"Cenário desconhecido: {name}")
                print(f"    {res['status']}: {res['seconds']} s", flush=True)
                runs.append(res)
            entry = {"runs": runs, "seconds": summarize(runs),
                     "max_unacked": max((r["queues"]["max_unacked"] or 0 for r in runs), default=None),
                     "max_parallel_progress": max((r.get("max_parallel_progress") or 0 for r in runs), default=None)}
            if name in ("S0", "S1", "S2R"):
                entry["videos_per_min"] = summarize(runs, "videos_per_min")
            if name == "S2":
                entry["heavy_seconds"] = summarize(runs, "heavy_seconds")
            report["scenarios"][name] = entry
            out_file.write_text(json.dumps(report, indent=2), encoding="utf-8")  # guarda a cada cenário
    finally:
        for c in (x, y):
            c.close()
            c.delete_account()

    sc = report["scenarios"]
    med = lambda n, k="seconds": sc.get(n, {}).get(k, {}).get("median")  # noqa: E731
    derived = {
        "P4_simple_case_s": med("S0"),
        "P2_videos_per_min": med("S1", "videos_per_min"),
        "P3_max_parallel_progress": max((sc[n]["max_parallel_progress"] or 0 for n in sc), default=None),
        "P3_max_unacked_rabbitmq": max((sc[n]["max_unacked"] or 0 for n in sc), default=None),
        "P1_light_batch_mixed_s": med("S2"),
        "P1_light_batch_alone_s": med("S2R"),
        "P1_ratio": round(med("S2") / med("S2R"), 2) if med("S2") and med("S2R") else None,
    }
    report["derived"] = derived
    report["finished_at"] = datetime.now(timezone.utc).isoformat()
    out_file.write_text(json.dumps(report, indent=2), encoding="utf-8")

    print("\nResumo (medianas):")
    for k, v in derived.items():
        print(f"  {k:28} {v}")
    print(f"\nResultados em bruto: {out_file}")


if __name__ == "__main__":
    main()
