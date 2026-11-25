"""Impacto de uma alteração (RNF-1, métrica M1).

Compara um ramo onde se acrescentou um efeito de vídeo com o commit de onde
partiu e conta os ficheiros *existentes* que tiveram de ser modificados,
separando o lado do worker (Tools/) do resto (orquestrador, frontend, infraestrutura).

Procedimento (igual antes e depois do refactoring):
  1. git checkout -b m1-invert <commit de partida>
  2. acrescentar o efeito por fotograma "invert" (inverter cores) ao vídeo,
     só o necessário para funcionar ponta a ponta
  3. git commit
  4. python change_impact.py --base <commit de partida> --label baseline --out ../baseline
  5. apagar o ramo (a alteração não faz parte da entrega)

Gerado com apoio de IA (Claude) e revisto pela equipa PL3-G1.
"""
from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

from picturas_client import repo_path


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", required=True, help="commit de partida")
    ap.add_argument("--head", default="HEAD")
    ap.add_argument("--label", required=True)
    ap.add_argument("--out", default="../baseline")
    ap.add_argument("--repo", default=None)
    args = ap.parse_args()
    repo = repo_path(args.repo)

    out = subprocess.run(["git", "diff", "--ignore-cr-at-eol", "--diff-filter=AMDR",
                          "--name-status", args.base, args.head], cwd=repo, capture_output=True, text=True, check=True)
    files = []
    for line in out.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) >= 2 and parts[0][:1] in "AMDR":
            files.append({"status": parts[0][:1], "path": parts[-1]})
    is_test = lambda p: "/tests/" in p or p.startswith("tests/")  # noqa: E731
    worker = [f for f in files if f["path"].startswith("Tools/") and not is_test(f["path"])]
    other = [f for f in files if not f["path"].startswith("Tools/") and not is_test(f["path"])]
    count = lambda fs, st: sum(f["status"] == st for f in fs)  # noqa: E731
    report = {
        "label": args.label, "base": args.base, "head": args.head,
        "M1_worker_existing_files_modified": count(worker, "M") + count(worker, "R") + count(worker, "D"),
        "worker_files_added": count(worker, "A"),
        "other_existing_files_modified": count(other, "M") + count(other, "R") + count(other, "D"),
        "other_files_added": count(other, "A"),
        "files": files,
    }
    out_dir = Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / f"m1-{args.label}.json"
    target.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    for k, v in report.items():
        if k != "files":
            print(f"{k:38} {v}")
    for f in files:
        print(f"  {f['status']} {f['path']}")
    print(f"Resultado: {target}")


if __name__ == "__main__":
    main()
