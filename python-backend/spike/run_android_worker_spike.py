# -*- coding: utf-8 -*-
"""Run the reproducible A4.1 artifact/contract probe.

This command never downloads artifacts and never implements an Android Worker.
Download the three manifest URLs into an ignored directory, then point
``--artifact-dir`` at it.  ``--adapter-json`` optionally supplies an external
proof adapter command as a JSON string array.
"""
import argparse
import json
from pathlib import Path
import sys

BASE = Path(__file__).resolve().parents[1]
if str(BASE) not in sys.path:
    sys.path.insert(0, str(BASE))

from runtime.android_worker_spike import (  # noqa: E402
    ContractProbe, inspect_android_artifact, inventory_execution_options,
    load_manifest)


def main(argv=None):
    parser = argparse.ArgumentParser(description='A4.1 Android Worker feasibility probe')
    parser.add_argument('--manifest', default=str(Path(__file__).with_name(
        'android_worker_samples.json')))
    parser.add_argument('--artifact-dir', required=True)
    parser.add_argument('--adapter-json', default='',
                        help='JSON command array for an external Android proof adapter')
    parser.add_argument('--timeout-ms', type=int, default=15000)
    parser.add_argument('--output', default='')
    args = parser.parse_args(argv)

    manifest = load_manifest(args.manifest)
    root = Path(args.artifact_dir).resolve()
    artifacts = []
    contracts = []
    command = json.loads(args.adapter_json) if args.adapter_json else None
    if command is not None and (not isinstance(command, list) or not command):
        raise ValueError('--adapter-json must be a non-empty JSON string array')
    for sample in manifest['samples']:
        artifact = root / str(sample['file'])
        inspected = inspect_android_artifact(artifact, sample)
        artifacts.append(inspected)
        if command:
            enriched = dict(sample)
            enriched['artifactPath'] = str(artifact)
            contracts.append(ContractProbe().run(
                command, enriched, timeout_ms=args.timeout_ms).to_dict())
        else:
            contracts.append({
                'sampleId': sample['id'], 'completed': False,
                'state': 'not-run',
                'reason': 'no Android proof adapter was supplied',
            })
    report = {
        'schemaVersion': 1,
        'artifacts': artifacts,
        'executionOptions': inventory_execution_options(),
        'contracts': contracts,
    }
    text = json.dumps(report, ensure_ascii=False, indent=2)
    if args.output:
        Path(args.output).write_text(text + '\n', encoding='utf-8')
    # Windows console code pages cannot represent every JVM diagnostic.  The
    # report file is already UTF-8; make stdout equally deterministic.
    if hasattr(sys.stdout, 'buffer'):
        sys.stdout.buffer.write((text + '\n').encode('utf-8', 'replace'))
    else:  # pragma: no cover - embedded streams without a byte buffer
        print(text)
    return 0 if all(item['validForKind'] for item in artifacts) else 1


if __name__ == '__main__':
    raise SystemExit(main())
