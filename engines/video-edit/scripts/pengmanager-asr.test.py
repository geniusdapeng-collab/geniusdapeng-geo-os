#!/usr/bin/env python3
"""HTTP word precision and official model compatibility; no model/provider calls."""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest


ROOT = Path(__file__).resolve().parent


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


ASR = module('pengmanager_asr_helper', ROOT / 'tools/talkcraft-asr-words.py')
MODELS = module('pengmanager_model_installer', ROOT / 'pengmanager-models.py')


class WordPrecisionTests(unittest.TestCase):
    def run_http(self, payload):
        observed = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                observed.append(self.rfile.read(int(self.headers['Content-Length'])))
                data = json.dumps(payload).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *_args):
                return

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory(prefix='pengmanager-asr-contract-') as temporary:
                audio = Path(temporary) / 'explicit-artificial-bytes.wav'
                audio.write_bytes(b'contract-only-not-a-real-audio')
                result = ASR.transcribe_engine_http(str(audio), f'http://127.0.0.1:{server.server_port}', 'fixture-model', 'zh')
                self.assertIn(b'name="word_timestamps"\r\n\r\ntrue\r\n', observed[0])
                self.assertIn(b'name="model"\r\n\r\nfixture-model\r\n', observed[0])
                return result
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_actual_nested_word_timestamps_keep_word_precision(self):
        result = self.run_http({'text': '你好', 'segments': [{'text': '你好', 'start': 0.1, 'end': 0.9, 'words': [{'word': '你', 'start': 0.1, 'end': 0.4}, {'word': '好', 'start': 0.4, 'end': 0.9}]}]})
        self.assertEqual(result['precision'], 'word')
        self.assertEqual(result['words'], [{'text': '你', 'start': 0.1, 'end': 0.4}, {'text': '好', 'start': 0.4, 'end': 0.9}])

    def test_top_level_word_timestamps_keep_word_precision(self):
        result = self.run_http({'segments': [{'text': '你好', 'start': 0.1, 'end': 0.9}], 'words': [{'word': '你好', 'start': 0.1, 'end': 0.9}]})
        self.assertEqual(result['precision'], 'word')
        self.assertEqual(result['words'][0]['text'], '你好')

    def test_old_segment_only_response_is_declared_as_segment(self):
        result = self.run_http({'segments': [{'text': '你好', 'start': 0.1, 'end': 0.9}]})
        self.assertEqual(result['precision'], 'segment')
        self.assertEqual(result['words'], [{'text': '你好', 'start': 0.1, 'end': 0.9}])

    def test_reversed_nan_and_missing_word_times_fail(self):
        for bad in [{'word': '你', 'start': 2, 'end': 1}, {'word': '你', 'start': float('nan'), 'end': 1}, {'word': '你', 'end': 1}]:
            with self.subTest(bad=bad), self.assertRaisesRegex(RuntimeError, '无效词级'):
                self.run_http({'segments': [{'text': '你', 'start': 0, 'end': 2, 'words': [bad]}]})

    def test_partial_sentence_word_coverage_fails(self):
        with self.assertRaisesRegex(RuntimeError, '部分句子'):
            self.run_http({'segments': [{'text': '你', 'start': 0, 'end': 1, 'words': [{'word': '你', 'start': 0, 'end': 1}]}, {'text': '好', 'start': 1, 'end': 2}]})


class ModelCompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='pengmanager-model-contract-')
        self.root = Path(self.temporary.name)
        self.original = self.root / 'model.safetensors'
        self.original.write_bytes(b'explicit-artificial-weights-not-an-actual-model')
        self.expected = {'bytes': self.original.stat().st_size, 'sha256': hashlib.sha256(self.original.read_bytes()).hexdigest()}
        self.model = {'files': {'model.safetensors': self.expected}, 'compatibilityAliases': {'weights.safetensors': 'model.safetensors'}}

    def tearDown(self):
        self.temporary.cleanup()

    def test_alias_is_same_owned_official_bytes_and_reentrant(self):
        MODELS.install_compatibility_aliases(self.root, self.model)
        MODELS.install_compatibility_aliases(self.root, self.model)
        alias = self.root / 'weights.safetensors'
        self.assertEqual(alias.read_bytes(), self.original.read_bytes())
        self.assertEqual(alias.stat().st_ino, self.original.stat().st_ino)
        self.assertFalse(alias.is_symlink())

    def test_existing_wrong_alias_is_not_overwritten(self):
        alias = self.root / 'weights.safetensors'
        alias.write_bytes(b'wrong-existing-bytes')
        with self.assertRaisesRegex(RuntimeError, 'different size'):
            MODELS.install_compatibility_aliases(self.root, self.model)
        self.assertEqual(alias.read_bytes(), b'wrong-existing-bytes')

    def test_alias_symlink_is_rejected(self):
        (self.root / 'weights.safetensors').symlink_to(self.original)
        with self.assertRaisesRegex(RuntimeError, 'symlink'):
            MODELS.install_compatibility_aliases(self.root, self.model)

    def test_parent_escape_and_unknown_source_are_rejected(self):
        for aliases in [{'../outside': 'model.safetensors'}, {'weights.safetensors': 'missing.safetensors'}]:
            with self.subTest(aliases=aliases), self.assertRaises(RuntimeError):
                MODELS.install_compatibility_aliases(self.root, {**self.model, 'compatibilityAliases': aliases})


if __name__ == '__main__':
    unittest.main(verbosity=2)
