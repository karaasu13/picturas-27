"""Métricas estáticas e ambiente de medição (RNF-1: M3 e M4; ambiente para o relatório).

Recolhe, sem alterar nada:
  - ambiente: sistema, CPU, versões do Docker, commit e estado do repositório;
  - serviços de vídeo do Compose e respetivas réplicas em execução;
  - M3: tamanho das imagens Docker dos workers de vídeo;
  - M4: complexidade ciclomática (radon) e linhas de código de Tools/video;
  - n.º de efeitos por serviço de vídeo, a partir das pastas de Tools/video.

  python static_metrics.py --label baseline --out ../baseline

Gerado com apoio de IA (Claude) e revisto pela equipa PL3-G1.
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from picturas_client import repo_path


def run(cmd: list[str], cwd: Path | None = None) -> str:
    try:
        return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=120).stdout.strip()
    except Exception as e:  # noqa: BLE001
        return f"(indisponível: {e})"


def json_lines(text: str) -> list[dict]:
    """`docker ... --format json` devolve uma lista ou um objeto por linha, conforme a versão."""
    text = text.strip()
    if not text or text.startswith("("):
        return []
    try:
        data = json.loads(text)
        return data if isinstance(data, list) else [data]
    except ValueError:
        out = []
        for line in text.splitlines():
            try:
                out.append(json.loads(line))
            except ValueError:
                pass
        return out


def python_files(root: Path) -> list[Path]:
    skip = {"tests", ".venv", "__pycache__", "node_modules"}
    return sorted(p for p in root.rglob("*.py") if not skip & set(p.relative_to(root).parts))


def complexity(root: Path) -> dict:
    try:
        from radon.complexity import cc_visit
    except ImportError:
        return {"error": "radon não instalado (pip install -r requirements.txt)"}
    blocks = []
    for f in python_files(root):
        try:
            for b in cc_visit(f.read_text(encoding="utf-8")):
                blocks.append({"file": str(f.relative_to(root)).replace(os.sep, "/"), "name": b.name,
                               "complexity": b.complexity})
        except SyntaxError as e:
            blocks.append({"file": str(f), "name": f"(erro de sintaxe: {e})", "complexity": 0})
    blocks.sort(key=lambda b: -b["complexity"])
    values = [b["complexity"] for b in blocks]
    return {"max": max(values, default=0), "mean": round(sum(values) / len(values), 2) if values else 0,
            "functions": len(values), "over_10": sum(v > 10 for v in values), "top": blocks[:10]}


def loc(root: Path) -> dict:
    files = {}
    for f in python_files(root):
        lines = [ln for ln in f.read_text(encoding="utf-8").splitlines() if ln.strip() and not ln.strip().startswith("#")]
        files[str(f.relative_to(root)).replace(os.sep, "/")] = len(lines)
    return {"total": sum(files.values()), "files": files}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--label", required=True)
    ap.add_argument("--out", default="../baseline")
    ap.add_argument("--repo", default=None)
    args = ap.parse_args()
    repo = repo_path(args.repo)
    out_dir = Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    video_root = repo / "Tools" / "video"

    services = json_lines(run(["docker", "compose", "ps", "--format", "json"], repo))
    video_services = {}
    for s in services:
        name = s.get("Service", "")
        if "video" in name:
            video_services[name] = video_services.get(name, 0) + (1 if s.get("State") == "running" else 0)
    images = {}
    for img in json_lines(run(["docker", "compose", "images", "--format", "json"], repo)):
        name = img.get("ContainerName") or img.get("Container") or ""
        if "video" in name:
            size = img.get("Size")
            images[img.get("Repository", name)] = round(size / 1e6, 1) if isinstance(size, (int, float)) else size

    report = {
        "label": args.label,
        "measured_at": datetime.now(timezone.utc).isoformat(),
        "environment": {
            "platform": platform.platform(), "machine": platform.machine(), "processor": platform.processor(),
            "cpus": os.cpu_count(), "python": sys.version.split()[0],
            "docker": run(["docker", "version", "--format", "{{.Server.Version}}"]),
            "docker_cpus_mem": run(["docker", "info", "--format", "{{.NCPU}} CPU / {{.MemTotal}} bytes"]),
            "compose": run(["docker", "compose", "version", "--short"]),
        },
        "repository": {
            "commit": run(["git", "rev-parse", "HEAD"], repo),
            "branch": run(["git", "rev-parse", "--abbrev-ref", "HEAD"], repo),
            "changed_files_ignoring_eol": len([ln for ln in run(
                ["git", "diff", "--ignore-cr-at-eol", "--name-only"], repo).splitlines() if ln.strip()]),
        },
        "video_services_running_replicas": video_services,
        "M3_video_image_sizes_mb": images,
        "M4_complexity_tools_video": complexity(video_root),
        "loc_tools_video": loc(video_root),
        "dockerfiles_tools_video": sorted(str(p.relative_to(repo)).replace(os.sep, "/")
                                          for p in video_root.rglob("Dockerfile")),
    }
    target = out_dir / f"estatico-{args.label}.json"
    target.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    cx = report["M4_complexity_tools_video"]
    print(f"Commit: {report['repository']['commit']}")
    print(f"Serviços de vídeo (réplicas a correr): {video_services or 'nenhum encontrado'}")
    print(f"M3 imagens de vídeo (MB): {images or 'não obtido'}")
    print(f"M4 complexidade máx.: {cx.get('max', cx.get('error'))}  funções > 10: {cx.get('over_10')}")
    print(f"Linhas de código em Tools/video: {report['loc_tools_video']['total']}")
    print(f"Resultado: {target}")


if __name__ == "__main__":
    main()
