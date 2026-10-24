#!/usr/bin/env python3
"""Install pinned public model files into PengManager's own station, without old services or profiles."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys


def digest(file):
    h = hashlib.sha256()
    with file.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def verify_public_file(file, expected):
    if not file.is_file() or file.stat().st_size != expected['bytes']:
        raise RuntimeError('Pinned public model file is missing or has a different size: ' + file.name)
    if 'sha256' in expected:
        actual = digest(file)
        wanted = expected['sha256']
    else:
        h = hashlib.sha1(usedforsecurity=False)
        h.update(('blob ' + str(file.stat().st_size) + '\0').encode())
        with file.open('rb') as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                h.update(block)
        actual, wanted = h.hexdigest(), expected['gitBlob']
    if actual != wanted:
        raise RuntimeError('Pinned public model file integrity mismatch: ' + file.name)


def clone_public_snapshot(cache, model, destination):
    """A cache is installation input only. No symlink may retain a dependency on it."""
    source = cache / ('models--' + model['id'].replace('/', '--')) / 'snapshots' / model['revision']
    if not source.is_dir():
        return False
    destination.mkdir(parents=True, exist_ok=True)
    # Only the exact public revision manifest is installation input. Never sweep cache extras.
    for name, expected in model['files'].items():
        relative = Path(name)
        if relative.is_absolute() or '..' in relative.parts:
            raise RuntimeError('Pinned public model path is invalid')
        origin = source / relative
        verify_public_file(origin, expected)
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.is_file() and target.stat().st_size == origin.stat().st_size and digest(target) == digest(origin):
            continue
        temporary = target.with_name(target.name + '.installing')
        shutil.copyfile(origin, temporary, follow_symlinks=True)
        if digest(temporary) != digest(origin):
            temporary.unlink(missing_ok=True)
            raise RuntimeError('Public model cache copy changed: ' + str(relative))
        os.replace(temporary, target)
    return True


def install_compatibility_aliases(target, model):
    """Bind the old native loader filename to the same verified official bytes."""
    for alias_name, original_name in model.get('compatibilityAliases', {}).items():
        alias_relative, original_relative = Path(alias_name), Path(original_name)
        if any(relative.is_absolute() or '..' in relative.parts for relative in (alias_relative, original_relative)):
            raise RuntimeError('Pinned public model compatibility path is invalid')
        if original_name not in model['files'] or alias_name in model['files']:
            raise RuntimeError('Compatibility alias must refer to one official model file')
        original, alias = target / original_relative, target / alias_relative
        if original.is_symlink() or alias.is_symlink() or not alias.resolve().is_relative_to(target.resolve()):
            raise RuntimeError('Pinned public model compatibility path cannot retain a symlink')
        verify_public_file(original, model['files'][original_name])
        if alias.exists():
            verify_public_file(alias, model['files'][original_name])
        else:
            alias.parent.mkdir(parents=True, exist_ok=True)
            os.link(original, alias)
        verify_public_file(alias, model['files'][original_name])


def install_voice_models(engine, station):
    lock = json.loads((engine / 'pengmanager-toolchain.lock.json').read_text())
    home = station / 'models'
    os.environ['HF_HOME'] = str(home)
    os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
    os.environ['HF_HUB_DISABLE_XET'] = '1'
    from huggingface_hub import snapshot_download
    results = []
    cache = os.environ.get('PENGMANAGER_PUBLIC_MODEL_CACHE')
    for model in lock['models']:
        root = home / 'hub' / ('models--' + model['id'].replace('/', '--'))
        target = root / 'snapshots' / model['revision']
        reused = clone_public_snapshot(Path(cache), model, target) if cache else False
        if not reused:
            snapshot_download(model['id'], revision=model['revision'], allow_patterns=list(model['files']), local_dir=str(target), token=False)
        for name, expected in model['files'].items():
            verify_public_file(target / name, expected)
        install_compatibility_aliases(target, model)
        if not (target / 'config.json').is_file() or not any(target.glob('*.safetensors')) and not any(target.glob('*.npz')):
            raise RuntimeError('Pinned model lacks configuration or weights: ' + model['id'])
        (root / 'refs').mkdir(exist_ok=True)
        (root / 'refs/main').write_text(model['revision'])
        files = [{ 'path': str(f.relative_to(target)), 'bytes': f.stat().st_size, 'sha256': digest(f) }
                 for f in sorted(target.rglob('*')) if f.is_file() and '.cache' not in f.parts]
        results.append({ 'id': model['id'], 'revision': model['revision'], 'path': str(target), 'files': files,
                         'compatibilityAliases': model.get('compatibilityAliases', {}) })
    # The native MLX-audio Whisper backend needs the original processor assets.
    processor = lock['asrProcessor']
    processor_files = list(processor['files'])
    asr = Path(results[1]['path'])
    if not all((asr / name).is_file() for name in processor_files):
        source = Path(snapshot_download(processor['id'], revision=processor['revision'], allow_patterns=processor_files, token=False))
        for name in processor_files:
            if (source / name).is_file():
                shutil.copyfile(source / name, asr / name)
    for name, expected in processor['files'].items():
        verify_public_file(asr / name, expected)
    for result in results:
        target = Path(result['path'])
        result['files'] = [{'path': str(f.relative_to(target)), 'bytes': f.stat().st_size, 'sha256': digest(f)}
                           for f in sorted(target.rglob('*')) if f.is_file() and '.cache' not in f.parts]
    (station / 'models-installed.json').write_text(json.dumps({'schemaVersion': 'pengmanager.models/v1', 'models': results}, indent=2) + '\n')
    print(json.dumps({'ok': True, 'models': [{'id': m['id'], 'revision': m['revision']} for m in results]}))


def install_loommate(engine, station):
    file = engine / 'scripts/install-loommate-voice.py'
    spec_module = importlib.util.spec_from_file_location('pengmanager_native_voice_installer', file)
    module = importlib.util.module_from_spec(spec_module)
    spec_module.loader.exec_module(module)
    spec = json.loads((engine / 'apps/server/src/voice/loommate-voice.json').read_text())
    python = station / 'venv/bin/python'
    for dependency in [spec['pythonDependency'], spec['runtimeDependency'], *spec.get('extraDependencies', [])]:
        module.run_dependency(python, dependency, False)
    cached = os.environ.get('PENGMANAGER_PUBLIC_LOOMMATE_CACHE')
    source = station / 'models/loommate-download' / ('kokoro-onnx-' + spec['revision'][:12])
    if cached:
        cached = Path(cached)
        for name, expected in spec['weightsSha256'].items():
            origin = cached / name
            if origin.is_file() and digest(origin) == expected:
                source.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(origin, source / name)
    model = module.prepare_model(station, python, spec, False)
    module.atomic_json(station / 'loommate-voice.json', {'schema': spec['schema'], 'model': spec['model'],
        'revision': spec['revision'], 'modelPath': str(model), 'profile': spec['profile'], 'voice': spec['voice'],
        'phonemizerVersion': spec['phonemizerVersion'], 'license': spec['license'], 'backend': spec['backend']})
    print(json.dumps({'ok': True, 'profile': spec['profile'], 'revision': spec['revision']}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['voice', 'loommate'])
    parser.add_argument('--engine-root', type=Path, required=True)
    parser.add_argument('--station', type=Path, required=True)
    args = parser.parse_args()
    engine, station = args.engine_root.resolve(), args.station.resolve()
    station.mkdir(parents=True, exist_ok=True)
    if args.mode == 'voice':
        install_voice_models(engine, station)
    else:
        install_loommate(engine, station)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, RuntimeError) as error:
        print('PengManager model installation failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
