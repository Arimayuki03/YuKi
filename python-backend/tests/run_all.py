# -*- coding: utf-8 -*-
"""One-shot backend regression: smoke + phase3 + py_compile all sources.

Usage: <venv>/python python-backend/tests/run_all.py
Exits 0 only if every stage passes. Output kept ASCII (PowerShell safety).
"""
import os
import py_compile
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(HERE)  # python-backend/
PY = sys.executable

STAGES = [
    ('smoke', [PY, os.path.join(HERE, 'smoke.py')]),
    ('phase3', [PY, os.path.join(HERE, 'test_phase3.py')]),
    ('kazumi', [PY, os.path.join(HERE, 'test_kazumi.py')]),
    ('cache', [PY, os.path.join(HERE, 'test_cache_store.py')]),
    ('layered-diagnostics', [PY, os.path.join(HERE, 'test_layered_diagnostics.py')]),
    ('port-generalization', [PY, os.path.join(HERE, 'test_port_generalization.py')]),
    ('quark-pan', [PY, os.path.join(HERE, 'test_quark_pan.py')]),
    ('jar-phase', [PY, os.path.join(HERE, 'test_jar_phase.py')]),
    ('jar-e2e', [PY, os.path.join(HERE, 'test_jar_e2e.py')]),
]

SKIP_DIRS = {'.venv', '__pycache__', 'tests'}


def compile_all():
    bad = []
    n = 0
    for root, dirs, files in os.walk(BASE):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for f in files:
            if f.endswith('.py'):
                n += 1
                p = os.path.join(root, f)
                try:
                    py_compile.compile(p, doraise=True)
                except py_compile.PyCompileError as e:
                    bad.append(f'{p}: {e.msg}')
    print(f'[compile] {n} py files, {len(bad)} errors')
    for b in bad:
        print(f'  [FAIL] {b}')
    return not bad


def main():
    ok = True
    for name, cmd in STAGES:
        print(f'===== stage: {name} =====')
        r = subprocess.run(cmd, cwd=BASE)
        passed = r.returncode == 0
        ok = ok and passed
        print(f'===== {name}: {"PASS" if passed else "FAIL"} =====\n')
    print('===== stage: compile =====')
    ok = compile_all() and ok
    print()
    print(f'RUN_ALL: {"ALL PASS" if ok else "FAILED"}')
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
