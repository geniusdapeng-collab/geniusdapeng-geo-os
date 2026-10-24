#!/usr/bin/env python3
"""WorkLoom visual bridge v0.2 — exposes the headless Compositor kit to WorkLoom.

v0.2 hardening (production):
  * multi-tenant: per-tenant bearer token, root directory, daily render quota, disk quota;
  * path jail per tenant + optional read-only shared roots;
  * idempotency keys (repeat a write call with the same key and get the stored result);
  * jobs persisted as JSON files (survive restarts; interrupted jobs fail closed);
  * metrics per tenant + visualread.stats / GET /metrics;
  * retention cleanup for jobs/idempotency records.

Two front ends, one engine:
  * HTTP  : GET /health, GET /actions, GET /metrics, POST /action, POST /jobs, GET /jobs/<id>
  * MCP   : stdio JSON-RPC 2.0 (initialize / tools/list / tools/call) — default tenant

Tool names are split into `visualread.*` / `visualwrite.*` namespaces because the
WorkLoom dsh fence plugin matches rules by the first dot-segment.

Every write tool returns a receipt with the artifact path, size and SHA-256.
No receipt means the caller must treat the job as unverified.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
import urllib.parse
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

ENGINE = "compositor-bridge 0.2.0"
DEFAULT_PORT = 9773
MAX_BODY = 32 * 1024 * 1024


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def write_json_atomic(path: str, payload: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temp = "%s.tmp-%s" % (path, uuid.uuid4().hex[:8])
    with open(temp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, sort_keys=True)
    os.replace(temp, path)


def read_json(path: str, default):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError):
        return default


def read_token_file(path):
    if not path:
        return None
    try:
        with open(os.path.expanduser(path), "r", encoding="utf-8") as handle:
            return handle.read().strip() or None
    except OSError:
        return None


TEMPLATE_VAR = re.compile(r"\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}")

DEFAULT_STOCK_HOSTS = [
    "images.unsplash.com", "images.pexels.com", "cdn.pixabay.com",
    "upload.wikimedia.org", "live.staticflickr.com", "images.metmuseum.org",
    "ids.si.edu", "iiif.nypl.org", "images.nypl.org",
    "picsum.photos", "fastly.picsum.photos", "cdn.stocksnap.io",
    "burst.shopifycdn.com", "kaboompics.com", "images.rawpixel.com",
    "undraw.co", "openclipart.org", "api.europeana.eu", "cdn.europeana.eu",
    "ark-acg-cn-beijing.tos-cn-beijing.volces.com", "ark-project.tos-cn-beijing.volces.com",
]
USER_AGENT = "WorkLoomVisualBridge/0.2 (visual workstation; contact: local)"


def template_lookup(variables: dict, path: str):
    current = variables
    for part in path.split("."):
        if isinstance(current, dict) and part in current:
            current = current[part]
        else:
            return None
    return current


def render_template_value(value, variables: dict):
    """Recursively substitutes {{a.b}} placeholders; missing vars fail closed."""
    if isinstance(value, str):
        def replace(match):
            path = match.group(1)
            found = template_lookup(variables, path)
            if found is None:
                raise BridgeError("template variable not provided: %s" % path, "template_var_missing")
            return str(found)
        return TEMPLATE_VAR.sub(replace, value)
    if isinstance(value, list):
        return [render_template_value(item, variables) for item in value]
    if isinstance(value, dict):
        return {key: render_template_value(item, variables) for key, item in value.items()}
    return value


def find_unresolved_template(value, prefix=""):
    if isinstance(value, str):
        return [prefix or value] if TEMPLATE_VAR.search(value) else []
    if isinstance(value, list):
        found = []
        for index, item in enumerate(value):
            found.extend(find_unresolved_template(item, "%s[%s]" % (prefix, index)))
        return found
    if isinstance(value, dict):
        found = []
        for key, item in value.items():
            found.extend(find_unresolved_template(item, "%s.%s" % (prefix, key) if prefix else key))
        return found
    return []


class BridgeError(Exception):
    def __init__(self, message: str, code: str = "bridge_error") -> None:
        super().__init__(message)
        self.code = code


class Tenant:
    def __init__(self, tenant_id: str, token: str, root: str,
                 daily_render_quota: int = 0, max_disk_mb: int = 0) -> None:
        self.id = tenant_id
        self.token = token
        self.root = os.path.realpath(os.path.abspath(os.path.expanduser(root)))
        self.daily_render_quota = int(daily_render_quota)
        self.max_disk_mb = int(max_disk_mb)
        self.assets_dir = os.path.join(self.root, "assets")
        self.out_dir = os.path.join(self.root, "out")
        self.tmp_dir = os.path.join(self.root, "tmp")
        for path in (self.root, self.assets_dir, self.out_dir, self.tmp_dir):
            os.makedirs(path, exist_ok=True)

    def dir_size_bytes(self) -> int:
        total = 0
        for base, _dirs, files in os.walk(self.root):
            for name in files:
                try:
                    total += os.path.getsize(os.path.join(base, name))
                except OSError:
                    continue
        return total


class Config:
    def __init__(self, data: dict, base_dir: str) -> None:
        self.base_dir = base_dir
        self.cli = os.path.abspath(os.path.expanduser(data.get("cli", "")))
        self.work_dir = os.path.abspath(os.path.expanduser(data.get("work_dir", os.path.join(base_dir, "var"))))
        self.audit_log = os.path.abspath(os.path.expanduser(
            data.get("audit_log", os.path.join(self.work_dir, "audit.jsonl"))))
        self.jobs_dir = os.path.abspath(os.path.expanduser(data.get("jobs_dir", os.path.join(self.work_dir, "jobs"))))
        self.state_dir = os.path.abspath(os.path.expanduser(data.get("state_dir", os.path.join(self.work_dir, "state"))))
        self.host = data.get("host", "127.0.0.1")
        self.port = int(data.get("port", DEFAULT_PORT))
        self.timeout_seconds = int(data.get("timeout_seconds", 600))
        self.job_ttl_days = int(data.get("job_ttl_days", 7))
        self.max_concurrent_jobs = int(data.get("max_concurrent_jobs", 1))
        self.screen_check = data.get("screen_check")
        if self.screen_check:
            self.screen_check = os.path.abspath(os.path.expanduser(self.screen_check))
        self.shared_roots = [os.path.realpath(os.path.abspath(os.path.expanduser(root)))
                             for root in (data.get("shared_roots") or [])]
        # Design-quality loop configuration (all optional; missing config fails closed).
        self.vision = data.get("vision") or {}
        self.image_gen = data.get("image_gen") or {}
        self.stock_allowed_hosts = [str(host) for host in
                                    (data.get("stock") or {}).get("allowed_hosts",
                                                                  DEFAULT_STOCK_HOSTS)]
        self.allow_roots = [os.path.realpath(os.path.abspath(os.path.expanduser(root)))
                            for root in (data.get("allow_roots") or [self.work_dir])]

        self.tenants = {}
        for entry in data.get("tenants", []):
            tenant_id = entry.get("id")
            if not tenant_id:
                raise BridgeError("tenant entry requires id", "bad_config")
            token = os.environ.get(str(entry.get("token_env") or "")) or entry.get("token") or read_token_file(entry.get("token_file"))
            if not token:
                raise BridgeError("tenant %s has no token" % tenant_id, "bad_config")
            root = entry.get("root") or os.path.join(self.work_dir, "tenants", tenant_id)
            self.tenants[tenant_id] = Tenant(
                tenant_id, token, root,
                daily_render_quota=entry.get("quota_daily_renders", 0),
                max_disk_mb=entry.get("max_disk_mb", 0),
            )
        if not self.tenants:
            # Backward compatibility: single-token config → one tenant rooted at work_dir.
            token = os.environ.get(str(data.get("token_env") or "")) or data.get("token") or read_token_file(data.get("token_file"))
            if token:
                self.tenants["default"] = Tenant("default", token,
                                                 data.get("tenant_root", self.work_dir),
                                                 data.get("quota_daily_renders", 0),
                                                 data.get("max_disk_mb", 0))
        self.default_tenant = next(iter(self.tenants.values()), None)

    def ensure_dirs(self) -> None:
        for path in (self.work_dir, self.jobs_dir, self.state_dir):
            os.makedirs(path, exist_ok=True)

    def authenticate(self, token: str):
        for tenant in self.tenants.values():
            if hmac.compare_digest(token, tenant.token):
                return tenant
        return None


class Audit:
    def __init__(self, path: str) -> None:
        self.path = path
        self.lock = threading.Lock()

    def write(self, record: dict) -> None:
        line = json.dumps(record, ensure_ascii=False, sort_keys=True)
        with self.lock:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            with open(self.path, "a", encoding="utf-8") as handle:
                handle.write(line + "\n")


class State:
    """Persisted per-tenant quotas, metrics and a short-lived disk cache."""

    def __init__(self, path: str) -> None:
        self.path = path
        self.lock = threading.Lock()
        self.data = read_json(path, {"quotas": {}, "metrics": {}, "disk_cache": {}})
        for key in ("quotas", "metrics", "disk_cache"):
            self.data.setdefault(key, {})

    def _save(self) -> None:
        write_json_atomic(self.path, self.data)

    def render_count(self, tenant_id: str) -> int:
        entry = self.data["quotas"].get(tenant_id) or {}
        return int(entry.get("renders", 0)) if entry.get("date") == today() else 0

    def take_render_quota(self, tenant: Tenant) -> int:
        with self.lock:
            entry = self.data["quotas"].get(tenant.id) or {}
            if entry.get("date") != today():
                entry = {"date": today(), "renders": 0}
            used = int(entry.get("renders", 0))
            if tenant.daily_render_quota > 0 and used >= tenant.daily_render_quota:
                raise BridgeError(
                    "daily render quota exceeded for tenant %s (%s/%s)" % (
                        tenant.id, used, tenant.daily_render_quota),
                    "quota_exceeded",
                )
            entry["renders"] = used + 1
            self.data["quotas"][tenant.id] = entry
            self._save()
            return entry["renders"]

    def disk_used_mb(self, tenant: Tenant) -> float:
        with self.lock:
            cached = self.data["disk_cache"].get(tenant.id) or {}
            if time.time() - float(cached.get("at", 0)) < 30:
                return float(cached.get("mb", 0))
        used = tenant.dir_size_bytes() / (1024.0 * 1024.0)
        with self.lock:
            self.data["disk_cache"][tenant.id] = {"at": time.time(), "mb": used}
            self._save()
        return used

    def check_disk(self, tenant: Tenant) -> None:
        if tenant.max_disk_mb <= 0:
            return
        used = self.disk_used_mb(tenant)
        if used >= tenant.max_disk_mb:
            raise BridgeError(
                "disk quota exceeded for tenant %s (%.1f/%.1f MB)" % (tenant.id, used, tenant.max_disk_mb),
                "disk_quota_exceeded",
            )

    def record(self, tenant_id: str, tool: str, ok: bool, elapsed_ms: int, bytes_written: int = 0) -> None:
        with self.lock:
            entry = self.data["metrics"].setdefault(tenant_id, {
                "renders": 0, "failures": 0, "bytes": 0, "total_ms": 0, "calls": 0,
            })
            entry["calls"] = int(entry.get("calls", 0)) + 1
            entry["total_ms"] = int(entry.get("total_ms", 0)) + elapsed_ms
            if ok:
                if tool.startswith("visualwrite."):
                    entry["renders"] = int(entry.get("renders", 0)) + 1
                    entry["last_render_at"] = now_iso()
                entry["bytes"] = int(entry.get("bytes", 0)) + bytes_written
            else:
                entry["failures"] = int(entry.get("failures", 0)) + 1
            self._save()

    def metrics(self, tenant_id: str) -> dict:
        entry = dict(self.data["metrics"].get(tenant_id) or {})
        calls = max(1, int(entry.get("calls", 0)))
        entry["avg_ms"] = round(int(entry.get("total_ms", 0)) / calls, 1)
        return entry


class Bridge:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.audit = Audit(config.audit_log)
        self.state = State(os.path.join(config.state_dir, "state.json"))
        self.jobs = {}
        self.jobs_lock = threading.Lock()
        self.job_slots = threading.Semaphore(max(1, config.max_concurrent_jobs))
        self._load_jobs()
        self._cleanup()

    # ---------- persistence ----------

    def _job_path(self, job_id: str) -> str:
        return os.path.join(self.config.jobs_dir, "%s.json" % job_id)

    def _idem_path(self, tenant_id: str, key: str) -> str:
        digest = sha256_text("%s:%s" % (tenant_id, key))
        return os.path.join(self.config.jobs_dir, "idem", "%s.json" % digest)

    def _load_jobs(self) -> None:
        if not os.path.isdir(self.config.jobs_dir):
            return
        for name in os.listdir(self.config.jobs_dir):
            if not name.endswith(".json"):
                continue
            path = os.path.join(self.config.jobs_dir, name)
            job = read_json(path, None)
            if not isinstance(job, dict) or not job.get("job_id"):
                continue
            if job.get("state") in ("queued", "running"):
                job["state"] = "failed"
                job["error"] = "interrupted_by_restart"
                job["finished_at"] = now_iso()
                write_json_atomic(path, job)
            self.jobs[job["job_id"]] = job

    def _save_job(self, job: dict) -> None:
        write_json_atomic(self._job_path(job["job_id"]), job)

    def _cleanup(self) -> None:
        cutoff = time.time() - self.config.job_ttl_days * 86400
        for directory in (self.config.jobs_dir, os.path.join(self.config.jobs_dir, "idem")):
            if not os.path.isdir(directory):
                continue
            for name in os.listdir(directory):
                path = os.path.join(directory, name)
                try:
                    if os.path.isfile(path) and os.path.getmtime(path) < cutoff:
                        os.remove(path)
                except OSError:
                    continue

    # ---------- engine ----------

    def resolve_api_key(self, spec: dict):
        """API key from inline value, file, or a command (e.g. macOS keychain)."""
        if spec.get("api_key_env"):
            value = os.environ.get(str(spec["api_key_env"]))
            if value:
                return value
        if spec.get("api_key"):
            return str(spec["api_key"])
        if spec.get("api_key_file"):
            value = read_token_file(spec["api_key_file"])
            if value:
                return value
        command = spec.get("api_key_command")
        if isinstance(command, list) and command:
            try:
                completed = subprocess.run(command, capture_output=True, text=True, timeout=20)
                if completed.returncode == 0 and completed.stdout.strip():
                    return completed.stdout.strip()
            except (OSError, subprocess.TimeoutExpired):
                return None
        return None

    @staticmethod
    def parse_json_loose(text: str) -> dict:
        cleaned = text.strip()
        if cleaned.startswith("```"):
            cleaned = re.sub(r"^```[a-zA-Z]*\n?", "", cleaned)
            cleaned = re.sub(r"\n?```$", "", cleaned)
        start, end = cleaned.find("{"), cleaned.rfind("}")
        if start == -1 or end == -1:
            raise BridgeError("vision model returned non-JSON content", "vision_bad_response")
        try:
            return json.loads(cleaned[start:end + 1])
        except json.JSONDecodeError:
            raise BridgeError("vision model returned invalid JSON", "vision_bad_response")

    def run_cli(self, arguments: list, timeout: int = None) -> dict:
        if not os.path.exists(self.config.cli):
            raise BridgeError("compositor-cli not found at %s" % self.config.cli, "engine_missing")
        command = [self.config.cli] + arguments
        started = time.time()
        try:
            completed = subprocess.run(
                command, capture_output=True, text=True,
                timeout=timeout or self.config.timeout_seconds, cwd=self.config.work_dir,
            )
        except subprocess.TimeoutExpired:
            raise BridgeError("engine timed out after %ss" % (timeout or self.config.timeout_seconds), "timeout")
        elapsed_ms = int((time.time() - started) * 1000)
        if completed.returncode != 0:
            raise BridgeError(
                "engine failed (%s): %s" % (completed.returncode, (completed.stderr or completed.stdout).strip()[:800]),
                "engine_failed",
            )
        text = completed.stdout.strip()
        try:
            payload = json.loads(text) if text.startswith("{") else {"output": text}
        except json.JSONDecodeError:
            payload = {"output": text}
        payload["engine_elapsed_ms"] = elapsed_ms
        return payload

    # ---------- path jail ----------

    def resolve(self, tenant: Tenant, path: str, must_exist: bool = True, write: bool = False) -> str:
        candidate = path if os.path.isabs(path) else os.path.join(tenant.root, path)
        resolved = os.path.realpath(os.path.abspath(os.path.expanduser(candidate)))
        roots = [tenant.root]
        if not write:
            roots = roots + self.config.shared_roots
        if write and tenant.id == "default":
            roots = roots + self.config.allow_roots
        if not any(resolved == root or resolved.startswith(root + os.sep) for root in roots):
            raise BridgeError("path outside the tenant root: %s" % path, "path_not_allowed")
        if must_exist and not os.path.exists(resolved):
            raise BridgeError("file not found: %s" % resolved, "not_found")
        return resolved

    # ---------- tools ----------

    def tool_health(self, params: dict) -> dict:
        version = self.run_cli(["version"])
        usage = shutil.disk_usage(self.config.work_dir)
        return {
            "bridge": ENGINE,
            "engine": version.get("output", "unknown"),
            "cli": self.config.cli,
            "work_dir": self.config.work_dir,
            "host": self.config.host,
            "port": self.config.port,
            "tenants": sorted(self.config.tenants.keys()),
            "disk_free_bytes": usage.free,
            "time": now_iso(),
        }

    def tool_stats(self, tenant: Tenant, params: dict) -> dict:
        stats = {
            "tenant": tenant.id,
            "root": tenant.root,
            "renders_today": self.state.render_count(tenant.id),
            "daily_render_quota": tenant.daily_render_quota,
            "disk_used_mb": round(self.state.disk_used_mb(tenant), 1),
            "max_disk_mb": tenant.max_disk_mb,
            "metrics": self.state.metrics(tenant.id),
            "queue_depth": sum(1 for job in self.jobs.values() if job.get("state") in ("queued", "running")),
            "time": now_iso(),
        }
        return {"result": stats, "receipt": {"synced": True, "verified_at": now_iso()}}

    def tool_assets(self, tenant: Tenant, params: dict) -> dict:
        prefix = str(params.get("prefix", "")).lstrip("/")
        if ".." in prefix.replace("\\", "/").split("/"):
            raise BridgeError("asset prefix escapes the tenant library", "path_not_allowed")
        limit = min(500, max(1, int(params.get("limit", 200))))
        directory = os.path.dirname(prefix)
        base = self.resolve(tenant, os.path.join(tenant.assets_dir, directory) if directory else tenant.assets_dir)
        items = []
        if os.path.isdir(base):
            for name in sorted(os.listdir(base)):
                if len(items) >= limit:
                    break
                if not name.lower().endswith((".png", ".jpg", ".jpeg", ".heic", ".tiff", ".comp")):
                    continue
                path = os.path.join(base, name)
                if not os.path.isfile(path):
                    continue
                items.append({
                    "name": os.path.join(directory, name) if directory else name,
                    "path": path,
                    "size_bytes": os.path.getsize(path),
                    "modified_at": datetime.fromtimestamp(os.path.getmtime(path), timezone.utc)
                    .isoformat(timespec="seconds").replace("+00:00", "Z"),
                })
        return {
            "result": {"tenant": tenant.id, "assets_dir": tenant.assets_dir, "items": items, "count": len(items)},
            "receipt": {"synced": True, "verified_at": now_iso()},
        }

    def tool_inspect(self, tenant: Tenant, params: dict) -> dict:
        comp = self.resolve(tenant, self._require(params, "project"))
        return {
            "result": self.run_cli(["inspect", comp]),
            "receipt": {"synced": True, "verified_at": now_iso(), "snapshot_uri": "file://" + comp},
        }

    def tool_compose(self, tenant: Tenant, params: dict) -> dict:
        self.state.check_disk(tenant)
        out_dir = self.resolve(tenant, params.get("out_dir") or tenant.out_dir, must_exist=False, write=True)
        os.makedirs(out_dir, exist_ok=True)
        recipe = params.get("recipe")
        template_path = params.get("template")
        if template_path:
            template = read_json(self.resolve(tenant, template_path), None)
            if not isinstance(template, dict):
                raise BridgeError("template must be a JSON object: %s" % template_path, "bad_request")
            variables = params.get("vars") or {}
            if not isinstance(variables, dict):
                raise BridgeError("vars must be an object", "bad_request")
            recipe = render_template_value(template, variables)
            unresolved = find_unresolved_template(recipe)
            if unresolved:
                raise BridgeError("unresolved template placeholders: %s" % ", ".join(unresolved[:5]),
                                  "template_var_unresolved")
            if isinstance(recipe, dict):
                recipe.pop("template_version", None)
        if isinstance(recipe, dict):
            # Templates carry template_version; recipes need recipe_version.
            recipe.setdefault("recipe_version", 1)
            recipes = os.path.join(out_dir, "recipes")
            os.makedirs(recipes, exist_ok=True)
            recipe_path = os.path.join(recipes, "recipe-%s.json" % uuid.uuid4().hex[:12])
            write_json_atomic(recipe_path, recipe)
        else:
            recipe_path = self.resolve(tenant, self._require(params, "recipe"))
        self.state.take_render_quota(tenant)
        result = self.run_cli(["compose", recipe_path, out_dir])
        outputs = result.get("outputs") or []
        bytes_written = sum(int(item.get("bytes", 0)) for item in outputs if isinstance(item, dict))
        # The receipt points at the primary rendered artifact (the .comp stays in
        # result.project). Pointing the receipt at the .comp would attach the PNG
        # hash to the wrong URI in downstream archives.
        primary = outputs[0] if outputs else None
        receipt = {
            "synced": bool(result.get("ok")),
            "verified_at": now_iso(),
            "snapshot_uri": "file://" + (primary or {}).get("output", result.get("project", "")),
            "sha256": (primary or {}).get("sha256"),
            "project_uri": "file://" + result.get("project", ""),
        }
        return {"result": result, "receipt": receipt, "_bytes": bytes_written}

    def tool_render(self, tenant: Tenant, params: dict) -> dict:
        self.state.check_disk(tenant)
        project = self.resolve(tenant, self._require(params, "project"))
        output = self.resolve(tenant, self._require(params, "output"), must_exist=False, write=True)
        os.makedirs(os.path.dirname(output), exist_ok=True)
        arguments = ["render", project, output]
        if params.get("quality") is not None:
            arguments += ["--quality", str(params["quality"])]
        self.state.take_render_quota(tenant)
        result = self.run_cli(arguments)
        receipt = {
            "synced": bool(result.get("ok")),
            "verified_at": now_iso(),
            "snapshot_uri": "file://" + output,
            "sha256": result.get("sha256"),
        }
        return {"result": result, "receipt": receipt, "_bytes": int(result.get("bytes", 0))}

    def tool_text(self, tenant: Tenant, params: dict) -> dict:
        self.state.check_disk(tenant)
        output = self.resolve(tenant, self._require(params, "output"), must_exist=False, write=True)
        os.makedirs(os.path.dirname(output), exist_ok=True)
        spec = params.get("spec")
        if not isinstance(spec, dict):
            raise BridgeError("spec must be an object", "bad_request")
        spec_dir = os.path.join(tenant.tmp_dir, "specs")
        os.makedirs(spec_dir, exist_ok=True)
        spec_path = os.path.join(spec_dir, "text-%s.json" % uuid.uuid4().hex[:12])
        write_json_atomic(spec_path, spec)
        self.state.take_render_quota(tenant)
        result = self.run_cli(["text", spec_path, output])
        digest = sha256_file(output)
        receipt = {"synced": True, "verified_at": now_iso(), "snapshot_uri": "file://" + output, "sha256": digest}
        return {
            "result": {"output": result.get("output", output), "sha256": digest},
            "receipt": receipt,
            "_bytes": os.path.getsize(output),
        }

    def tool_verify(self, tenant: Tenant, params: dict) -> dict:
        path = self.resolve(tenant, self._require(params, "path"))
        checks = []
        probe = self._probe_image(path)
        if params.get("width") is not None:
            checks.append(self._check("width", probe.get("width"), int(params["width"])))
        if params.get("height") is not None:
            checks.append(self._check("height", probe.get("height"), int(params["height"])))
        size = os.path.getsize(path)
        if params.get("min_bytes") is not None:
            checks.append(self._check("min_bytes", size, int(params["min_bytes"]), comparison=">="))
        if params.get("max_bytes") is not None:
            checks.append(self._check("max_bytes", size, int(params["max_bytes"]), comparison="<="))
        digest = sha256_file(path)
        if params.get("sha256") is not None:
            checks.append({"name": "sha256", "ok": digest == params["sha256"], "expected": params["sha256"], "actual": digest})
        ok = all(item["ok"] for item in checks) if checks else True
        return {
            "result": {"path": path, "size_bytes": size, "sha256": digest, "image": probe, "checks": checks, "ok": ok},
            "receipt": {"synced": ok, "verified_at": now_iso(), "snapshot_uri": "file://" + path, "sha256": digest},
        }

    def tool_snapshot(self, tenant: Tenant, params: dict) -> dict:
        app = None
        for candidate in ("/Applications/Compositor.app", os.path.expanduser("~/Applications/Compositor.app")):
            if os.path.isdir(candidate):
                app = candidate
                break
        if app is None:
            raise BridgeError(
                "Compositor.app is not installed on this workstation; GUI snapshots are unavailable "
                "(the headless engine does not need the app)",
                "compositor_not_installed",
            )
        check = self.config.screen_check
        if check and os.path.exists(check):
            probe = subprocess.run([check], capture_output=True, text=True, timeout=15)
            if probe.stdout.strip() != "granted":
                raise BridgeError(
                    "Screen Recording permission is required for visualread.snapshot. "
                    "Grant it once in System Settings > Privacy & Security > Screen Recording "
                    "for the bridge's Python (%s), then restart the LaunchAgent." % sys.executable,
                    "screen_recording_permission_required",
                )
        output = self.resolve(tenant, self._require(params, "output"), must_exist=False, write=True)
        os.makedirs(os.path.dirname(output), exist_ok=True)
        completed = subprocess.run(["screencapture", "-x", output], capture_output=True, text=True)
        if completed.returncode != 0:
            raise BridgeError("screencapture failed: %s" % completed.stderr.strip(), "snapshot_failed")
        digest = sha256_file(output)
        return {
            "result": {"path": output, "sha256": digest},
            "receipt": {"synced": True, "verified_at": now_iso(), "snapshot_uri": "file://" + output, "sha256": digest},
            "_bytes": os.path.getsize(output),
        }

    # ---------- design quality loop ----------

    def tool_critique(self, tenant: Tenant, params: dict) -> dict:
        """Vision-model design critique (DeepSeek Flash by default).

        `samples > 1` returns independent critiques plus the median overall
        score: single-shot model scores are noisy, the workflow rule is
        "median of >= 2 samples, human has the final say".
        """
        spec = self.config.vision or {}
        if not spec.get("base_url"):
            raise BridgeError("vision model not configured", "vision_not_configured")
        key = self.resolve_api_key(spec)
        if not key:
            raise BridgeError("vision model API key unavailable", "vision_key_missing")
        path = self.resolve(tenant, self._require(params, "path"))
        brief = str(params.get("brief") or "获客素材评审：请按商业设计标准严格评审。")
        max_edge = min(1600, max(512, int(params.get("max_edge", 1024))))
        samples = min(3, max(1, int(params.get("samples", 1))))

        temp = os.path.join(tenant.tmp_dir, "critique-%s.png" % uuid.uuid4().hex[:8])
        subprocess.run(["sips", "-Z", str(max_edge), path, "--out", temp], capture_output=True, check=True)
        image = base64.b64encode(open(temp, "rb").read()).decode()
        try:
            os.remove(temp)
        except OSError:
            pass

        base_rubric = (
            "你是资深商业设计总监，评审获客素材。严格、具体、可执行，不客套。\n"
            "输出 JSON（不要 markdown 代码块）：\n"
            '{"scores":{"composition":0-10,"typography":0-10,"color":0-10,'
            '"material_quality":0-10,"brand_fit":0-10,"overall":0-10},'
            '"top_issues":["最多5条，指出位置+原因"],"fixes":["最多5条，可直接执行的修改"],'
            '"verdict":"reject|revise|accept"}\n'
            "评分标准：8 分以上=可直接投放；6-7=需修改；<6=不合格。"
        )
        persona_rubrics = {
            "art_director": "你的身份：资深艺术指导。重点看构图、层级、字体、色彩与素材质感；对模板感和廉价素材零容忍。",
            "client": "你的身份：中小客户老板（非设计背景）。3 秒内能否看懂卖点、记住店名、产生到店/咨询冲动；看不懂或记不住直接扣分。",
            "mobile_user": "你的身份：刷信息流的普通用户。按手机缩略图（约 1/4 屏宽）评估：文字是否可读、主体是否清晰、是否愿意停留；小字过密直接扣分。",
        }
        requested = [str(item) for item in (params.get("personas") or []) if str(item) in persona_rubrics]
        jobs = [(item, persona_rubrics[item]) for item in requested] or \
               [("art_director", persona_rubrics["art_director"])] * samples
        critiques = []
        panel = {}
        for persona, persona_text in jobs:
            body = {
                "model": spec.get("model", "deepseek-flash"),
                "messages": [{
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "%s\n%s\n\n设计需求：%s" % (base_rubric, persona_text, brief)},
                        {"type": "image_url", "image_url": {"url": "data:image/png;base64," + image}},
                    ],
                }],
            }
            request = urllib.request.Request(
                spec["base_url"].rstrip("/") + "/chat/completions",
                data=json.dumps(body).encode(),
                headers={"content-type": "application/json", "authorization": "Bearer " + key},
            )
            try:
                with urllib.request.urlopen(request, timeout=180) as response:
                    payload = json.loads(response.read().decode())
                critique = self.parse_json_loose(payload["choices"][0]["message"]["content"])
                critiques.append(critique)
                panel[persona] = critique
            except urllib.error.HTTPError as error:
                detail = error.read().decode("utf-8", "replace")[:200]
                raise BridgeError("vision model HTTP %s: %s" % (error.code, detail), "vision_http_error")
            except (KeyError, IndexError, urllib.error.URLError, TimeoutError) as error:
                raise BridgeError("vision model call failed: %s" % error, "vision_call_failed")
        scores = sorted(float(item.get("scores", {}).get("overall", 0)) for item in critiques)
        return {
            "result": {
                "model": spec.get("model", "deepseek-flash"),
                "samples": len(jobs),
                "median_overall": scores[len(scores) // 2],
                "min_overall": scores[0],
                "panel": panel,
                "critiques": critiques,
            },
            "receipt": {"synced": True, "verified_at": now_iso(), "snapshot_uri": "file://" + path},
        }

    def tool_fetch_stock(self, tenant: Tenant, params: dict) -> dict:
        """Download a licensed stock image into the tenant asset library."""
        url = self._require(params, "url")
        parsed = urlparse(url)
        if parsed.scheme != "https":
            raise BridgeError("stock url must use https", "stock_url_invalid")
        if parsed.hostname not in self.config.stock_allowed_hosts:
            raise BridgeError("stock host not allowed: %s" % parsed.hostname, "stock_host_not_allowed")
        name = re.sub(r"[^A-Za-z0-9._-]", "-",
                      str(params.get("name") or os.path.basename(parsed.path) or "asset.jpg"))
        destination = self.resolve(tenant, os.path.join("assets", name), must_exist=False, write=True)
        try:
            headers = {"user-agent": USER_AGENT}
            if params.get("source_page"):
                headers["referer"] = str(params["source_page"])
            request = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(request, timeout=60) as response:
                data = response.read(20 * 1024 * 1024 + 1)
        except (urllib.error.URLError, TimeoutError) as error:
            raise BridgeError("stock download failed: %s" % error, "stock_download_failed")
        if len(data) > 20 * 1024 * 1024:
            raise BridgeError("stock image exceeds 20MB", "stock_too_large")
        with open(destination + ".tmp", "wb") as handle:
            handle.write(data)
        os.replace(destination + ".tmp", destination)
        digest = sha256_file(destination)
        license_info = {
            "url": url,
            "source_page": params.get("source_page"),
            "license": str(params.get("license") or "unknown"),
            "attribution": params.get("attribution"),
            "fetched_at": now_iso(),
            "sha256": digest,
        }
        write_json_atomic(destination + ".license.json", license_info)
        return {
            "result": {"path": destination, "license": license_info},
            "receipt": {"synced": True, "verified_at": now_iso(),
                        "snapshot_uri": "file://" + destination, "sha256": digest},
            "_bytes": len(data),
        }

    def tool_generate(self, tenant: Tenant, params: dict) -> dict:
        """Image generation via a configured OpenAI-compatible provider (fail-closed)."""
        spec = self.config.image_gen or {}
        if not spec.get("base_url") or not spec.get("model"):
            raise BridgeError("image generator not configured", "image_gen_not_configured")
        key = self.resolve_api_key(spec)
        if not key:
            raise BridgeError("image generator API key unavailable", "image_gen_key_missing")
        prompt = self._require(params, "prompt")
        count = min(4, max(1, int(params.get("n", 1))))
        body = {
            "model": spec["model"],
            "prompt": prompt,
            "size": str(params.get("size", spec.get("size", "1024x1024"))),
            "n": count,
        }
        if params.get("watermark") is not None:
            body["watermark"] = bool(params["watermark"])
        if params.get("seed") is not None:
            body["seed"] = int(params["seed"])
        request = urllib.request.Request(
            spec["base_url"].rstrip("/") + "/images/generations",
            data=json.dumps(body).encode(),
            headers={"content-type": "application/json", "authorization": "Bearer " + key},
        )
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                payload = json.loads(response.read().decode())
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")[:200]
            raise BridgeError("image generator HTTP %s: %s" % (error.code, detail), "image_gen_http_error")
        except (urllib.error.URLError, TimeoutError) as error:
            raise BridgeError("image generator call failed: %s" % error, "image_gen_call_failed")
        outputs = []
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        for index, item in enumerate(payload.get("data") or []):
            name = "generated-%s-%02d.png" % (stamp, index + 1)
            destination = self.resolve(tenant, os.path.join("assets", name), must_exist=False, write=True)
            if item.get("b64_json"):
                with open(destination + ".tmp", "wb") as handle:
                    handle.write(base64.b64decode(item["b64_json"]))
                os.replace(destination + ".tmp", destination)
            elif item.get("url"):
                host = urlparse(item["url"]).hostname
                if host not in self.config.stock_allowed_hosts and not spec.get("allow_any_host"):
                    raise BridgeError("generated image host not allowed: %s" % host, "image_gen_host_not_allowed")
                with urllib.request.urlopen(item["url"], timeout=120) as response:
                    data = response.read(30 * 1024 * 1024 + 1)
                with open(destination + ".tmp", "wb") as handle:
                    handle.write(data)
                os.replace(destination + ".tmp", destination)
            else:
                continue
            outputs.append({"path": destination, "sha256": sha256_file(destination),
                            "bytes": os.path.getsize(destination)})
        if not outputs:
            raise BridgeError("image generator returned no images", "image_gen_empty")
        return {
            "result": {"model": spec["model"], "prompt": prompt, "outputs": outputs},
            "receipt": {"synced": True, "verified_at": now_iso(),
                        "snapshot_uri": "file://" + outputs[0]["path"], "sha256": outputs[0]["sha256"]},
            "_bytes": sum(item["bytes"] for item in outputs),
        }

    # ---------- stock search ----------

    def _http_json(self, url: str, timeout: int = 20) -> dict:
        request = urllib.request.Request(url, headers={"user-agent": USER_AGENT, "accept": "application/json"})
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode())

    @staticmethod
    def _strip_html(value: str) -> str:
        return re.sub(r"<[^>]+>", "", value or "").strip()

    def _search_picsum(self, query: str, limit: int) -> list:
        payload = self._http_json("https://picsum.photos/v2/list?page=1&limit=%d" % limit)
        return [{
            "title": "Picsum #%s" % item.get("id"),
            "url": "https://picsum.photos/id/%s/1600/1200" % item.get("id"),
            "thumbnail": item.get("download_url"),
            "source_page": item.get("url"),
            "license": "Unsplash License",
            "attribution": item.get("author"),
            "provider": "picsum",
            "note": "占位/背景用途，不支持关键词匹配",
        } for item in payload][:limit]

    def _search_wikimedia(self, query: str, limit: int) -> list:
        url = ("https://commons.wikimedia.org/w/api.php?action=query&generator=search"
               "&gsrsearch=%s&gsrnamespace=6&gsrlimit=%d&prop=imageinfo"
               "&iiprop=url%%7Cextmetadata%%7Csize&iiurlwidth=800&format=json"
               % (urllib.parse.quote(query), limit))
        payload = self._http_json(url, timeout=25)
        pages = (payload.get("query") or {}).get("pages") or {}
        results = []
        for page in pages.values():
            info = (page.get("imageinfo") or [{}])[0]
            meta = info.get("extmetadata") or {}
            results.append({
                "title": page.get("title"),
                "url": info.get("url"),
                "thumbnail": info.get("thumburl"),
                "source_page": info.get("descriptionurl"),
                "license": (meta.get("LicenseShortName") or {}).get("value", "unknown"),
                "attribution": self._strip_html((meta.get("Artist") or {}).get("value", "")),
                "width": info.get("width"), "height": info.get("height"),
                "provider": "wikimedia",
            })
        return results[:limit]

    def _search_openverse(self, query: str, limit: int, licenses: list) -> list:
        url = ("https://api.openverse.org/v1/images/?q=%s&page_size=%d&license=%s"
               % (urllib.parse.quote(query), limit, ",".join(licenses)))
        payload = self._http_json(url, timeout=20)
        return [{
            "title": item.get("title"),
            "url": item.get("url"),
            "thumbnail": item.get("thumbnail"),
            "source_page": item.get("foreign_landing_url"),
            "license": item.get("license"),
            "attribution": item.get("creator"),
            "width": item.get("width"), "height": item.get("height"),
            "provider": "openverse",
        } for item in (payload.get("results") or [])][:limit]

    def _search_met(self, query: str, limit: int) -> list:
        found = self._http_json("https://collectionapi.metmuseum.org/public/collection/v1/search?q=%s"
                                % urllib.parse.quote(query), timeout=20)
        results = []
        for object_id in (found.get("objectIDs") or [])[:limit]:
            try:
                item = self._http_json("https://collectionapi.metmuseum.org/public/collection/v1/objects/%s"
                                       % object_id, timeout=20)
            except Exception:
                continue
            if not item.get("isPublicDomain") or not item.get("primaryImage"):
                continue
            results.append({
                "title": item.get("title"),
                "url": item.get("primaryImage"),
                "thumbnail": item.get("primaryImageSmall"),
                "source_page": item.get("objectURL"),
                "license": "CC0",
                "attribution": item.get("artistDisplayName") or "The Met",
                "provider": "met",
            })
        return results[:limit]

    def tool_search_stock(self, tenant: Tenant, params: dict) -> dict:
        """Search keyless open/free image sources; per-provider failures degrade gracefully."""
        query = self._require(params, "query")
        limit = min(20, max(1, int(params.get("limit", 8))))
        licenses = [str(item) for item in (params.get("licenses") or ["cc0", "pdm", "by", "by-sa"])]
        providers = [str(item) for item in (params.get("providers")
                                            or ["picsum", "wikimedia", "openverse", "met"])]
        results, errors = [], []
        handlers = {
            "picsum": lambda: self._search_picsum(query, limit),
            "wikimedia": lambda: self._search_wikimedia(query, limit),
            "openverse": lambda: self._search_openverse(query, limit, licenses),
            "met": lambda: self._search_met(query, limit),
        }
        for provider in providers:
            handler = handlers.get(provider)
            if handler is None:
                errors.append({"provider": provider, "error": "unknown_provider"})
                continue
            try:
                results.extend(handler())
            except Exception as error:  # provider failures must not break the search
                errors.append({"provider": provider, "error": str(error)[:160]})
        return {
            "result": {
                "query": query,
                "count": len(results),
                "results": results,
                "errors": errors,
                "policy": "CC0/PD 无署名义务；CC-BY/CC-BY-SA 必须署名并保留 source_page；下载请用 visualwrite.fetch_stock。",
            },
            "receipt": {"synced": len(results) > 0, "verified_at": now_iso()},
        }

    # ---------- dispatch ----------

    TOOLS = (
        ("visualread.health", "Bridge and engine health", {}),
        ("visualread.stats", "Per-tenant quota, metrics and queue depth", {}),
        ("visualread.assets", "List tenant base-image assets", {"prefix": "string?", "limit": "int?"}),
        ("visualread.inspect", "Read a .comp project's structure", {"project": "path"}),
        ("visualread.verify", "Verify an output image (size/hash/bytes)", {"path": "path"}),
        ("visualread.snapshot", "Screenshot the GUI workstation (needs Compositor.app)", {"output": "path"}),
        ("visualread.critique", "Vision-model design critique (median of N samples)", {"path": "path"}),
        ("visualread.search_stock", "Search keyless open/free image libraries", {"query": "str"}),
        ("visualwrite.compose", "Recipe -> .comp -> exports (PNG/JPEG)", {"out_dir": "path?"}),
        ("visualwrite.render", "Render a .comp to PNG or JPEG", {"project": "path", "output": "path"}),
        ("visualwrite.text", "Pre-render text into a transparent PNG", {"output": "path"}),
        ("visualwrite.fetch_stock", "Download a licensed stock image into assets/", {"url": "url", "name": "str"}),
        ("visualwrite.generate", "Generate imagery via the configured image model", {"prompt": "str"}),
    )

    def call(self, tenant: Tenant, name: str, params: dict) -> dict:
        started = time.time()
        handlers = {
            "visualread.health": self.tool_health,
            "visualread.stats": self.tool_stats,
            "visualread.assets": self.tool_assets,
            "visualread.inspect": self.tool_inspect,
            "visualread.verify": self.tool_verify,
            "visualread.snapshot": self.tool_snapshot,
            "visualread.critique": self.tool_critique,
            "visualread.search_stock": self.tool_search_stock,
            "visualwrite.compose": self.tool_compose,
            "visualwrite.render": self.tool_render,
            "visualwrite.text": self.tool_text,
            "visualwrite.fetch_stock": self.tool_fetch_stock,
            "visualwrite.generate": self.tool_generate,
        }
        handler = handlers.get(name)
        idempotency_key = params.get("idempotency_key") if isinstance(params, dict) else None
        record = {
            "time": now_iso(), "tenant": tenant.id, "tool": name,
            "params_sha256": sha256_text(json.dumps(params, sort_keys=True)),
            "idempotency_key": idempotency_key,
        }
        if handler is None:
            record.update({"ok": False, "error": "unknown_tool"})
            self.audit.write(record)
            raise BridgeError("unknown tool %s" % name, "unknown_tool")

        effective_params = dict(params or {})
        effective_params.pop("idempotency_key", None)
        declared_tenant = effective_params.get("tenant_id")
        if declared_tenant is not None and declared_tenant != tenant.id:
            record.update({"ok": False, "error": "tenant_mismatch"})
            self.audit.write(record)
            raise BridgeError(
                "token for tenant %s cannot act for tenant %s" % (tenant.id, declared_tenant),
                "tenant_mismatch",
            )
        # Read probes must measure current bytes, quotas and process state. A
        # cached successful verify is not authority for a changed output file.
        cacheable = bool(idempotency_key) and not name.startswith("visualread.")
        if cacheable:
            stored = self._idempotent_lookup(tenant, str(idempotency_key), effective_params)
            if stored is not None:
                record.update({"ok": True, "idempotent_replay": True})
                self.audit.write(record)
                replay = dict(stored)
                replay["result"] = dict(stored.get("result") or {}, idempotent_replay=True)
                return replay

        try:
            if name == "visualread.health":
                outcome = {"result": handler(effective_params), "receipt": {"synced": True, "verified_at": now_iso()}}
            else:
                outcome = handler(tenant, effective_params)
        except BridgeError as error:
            elapsed = int((time.time() - started) * 1000)
            self.state.record(tenant.id, name, False, elapsed)
            record.update({"ok": False, "error": error.code, "message": str(error), "elapsed_ms": elapsed})
            self.audit.write(record)
            raise
        elapsed = int((time.time() - started) * 1000)
        self.state.record(tenant.id, name, True, elapsed, int(outcome.get("_bytes", 0)))
        result = {key: value for key, value in outcome.items() if not key.startswith("_")}
        record.update({"ok": True, "elapsed_ms": elapsed, "receipt": result.get("receipt", {}),
                       "renders_today": self.state.render_count(tenant.id)})
        self.audit.write(record)
        if cacheable:
            self._idempotent_store(tenant, str(idempotency_key), effective_params, result)
        return result

    def _idempotent_lookup(self, tenant: Tenant, key: str, params: dict):
        entry = read_json(self._idem_path(tenant.id, key), None)
        if not isinstance(entry, dict):
            return None
        # Entries written by another bridge version are ignored: a receipt-schema
        # change must re-render instead of replaying an old-format receipt.
        if entry.get("engine") != ENGINE:
            return None
        if entry.get("request_sha256") != sha256_text(json.dumps(params, sort_keys=True)):
            raise BridgeError("idempotency key reused with different parameters", "idempotency_conflict")
        receipt = (entry.get("result") or {}).get("receipt") or {}
        if receipt.get("sha256") and receipt.get("snapshot_uri", "").startswith("file://"):
            candidate = urllib.parse.unquote(urlparse(receipt["snapshot_uri"]).path)
            try:
                artifact = self.resolve(tenant, candidate)
                matches = sha256_file(artifact) == receipt["sha256"]
            except (OSError, BridgeError):
                matches = False
            if not matches:
                raise BridgeError("cached artifact changed; inspect it and issue a new explicit request",
                                  "idempotency_revalidation_required")
        return entry.get("result")

    def _idempotent_store(self, tenant: Tenant, key: str, params: dict, result: dict) -> None:
        write_json_atomic(self._idem_path(tenant.id, key), {
            "tenant": tenant.id,
            "key": key,
            "engine": ENGINE,
            "request_sha256": sha256_text(json.dumps(params, sort_keys=True)),
            "result": result,
            "created_at": now_iso(),
        })

    # ---------- jobs ----------

    def submit_job(self, tenant: Tenant, name: str, params: dict) -> str:
        job_id = "J-%s" % uuid.uuid4().hex[:12]
        job = {
            "job_id": job_id, "tenant": tenant.id, "tool": name, "state": "queued",
            "submitted_at": now_iso(),
        }
        with self.jobs_lock:
            self.jobs[job_id] = job
            self._save_job(job)
        thread = threading.Thread(target=self._run_job, args=(job_id, tenant, name, params), daemon=True)
        thread.start()
        return job_id

    def _run_job(self, job_id: str, tenant: Tenant, name: str, params: dict) -> None:
        self.job_slots.acquire()
        try:
            with self.jobs_lock:
                job = self.jobs[job_id]
                job["state"] = "running"
                job["started_at"] = now_iso()
                self._save_job(job)
            try:
                result = self.call(tenant, name, params)
                update = {"state": "succeeded", "finished_at": now_iso(), "result": result}
            except BridgeError as error:
                update = {"state": "failed", "finished_at": now_iso(),
                          "error": error.code, "message": str(error)}
            with self.jobs_lock:
                self.jobs[job_id].update(update)
                self._save_job(self.jobs[job_id])
        finally:
            self.job_slots.release()

    def job(self, job_id: str) -> dict:
        with self.jobs_lock:
            job = self.jobs.get(job_id)
        if job is None:
            raise BridgeError("unknown job %s" % job_id, "not_found")
        return job

    # ---------- helpers ----------

    @staticmethod
    def _require(params: dict, key: str) -> str:
        value = params.get(key)
        if not isinstance(value, str) or not value:
            raise BridgeError("missing required parameter: %s" % key, "bad_request")
        return value

    @staticmethod
    def _check(name: str, actual, expected, comparison: str = "==") -> dict:
        ok = actual == expected
        if comparison == ">=":
            ok = actual is not None and actual >= expected
        if comparison == "<=":
            ok = actual is not None and actual <= expected
        return {"name": name, "ok": bool(ok), "expected": expected, "actual": actual}

    def _probe_image(self, path: str) -> dict:
        completed = subprocess.run(["sips", "-g", "pixelWidth", "-g", "pixelHeight", "-g", "format", path],
                                   capture_output=True, text=True)
        if completed.returncode != 0:
            raise BridgeError("not a readable image: %s" % completed.stderr.strip(), "bad_image")
        probe = {}
        for line in completed.stdout.splitlines():
            if ":" in line:
                key, value = line.split(":", 1)
                probe[key.strip()] = value.strip()
        result = {"format": probe.get("format")}
        if probe.get("pixelWidth", "").isdigit():
            result["width"] = int(probe["pixelWidth"])
        if probe.get("pixelHeight", "").isdigit():
            result["height"] = int(probe["pixelHeight"])
        return result


class Handler(BaseHTTPRequestHandler):
    server_version = "WorkLoomVisualBridge/0.2"
    bridge: Bridge = None

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (now_iso(), fmt % args))

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _tenant(self):
        header = self.headers.get("authorization", "")
        if not header.startswith("Bearer "):
            return None
        return self.bridge.config.authenticate(header[7:].strip())

    def do_GET(self):  # noqa: N802
        path = urlparse(self.path).path
        if path == "/health":
            try:
                self._json(200, {"ok": True, "result": self.bridge.tool_health({})})
            except BridgeError as error:
                self._json(500, {"ok": False, "error": error.code, "message": str(error)})
            return
        tenant = self._tenant()
        if tenant is None:
            self._json(401, {"ok": False, "error": "unauthorized"})
            return
        if path == "/actions":
            self._json(200, {"ok": True, "tenant": tenant.id, "tools": [
                {"name": name, "description": description, "params": params}
                for name, description, params in Bridge.TOOLS
            ]})
            return
        if path == "/metrics":
            self._json(200, {"ok": True, "result": self.bridge.tool_stats(tenant, {})["result"]})
            return
        if path.startswith("/jobs/"):
            try:
                job = self.bridge.job(path.rsplit("/", 1)[-1])
                if job.get("tenant") != tenant.id:
                    raise BridgeError("unknown job", "not_found")
                self._json(200, {"ok": True, "job": job})
            except BridgeError as error:
                self._json(404, {"ok": False, "error": error.code, "message": str(error)})
            return
        self._json(404, {"ok": False, "error": "not_found"})

    def do_POST(self):  # noqa: N802
        tenant = self._tenant()
        if tenant is None:
            self._json(401, {"ok": False, "error": "unauthorized"})
            return
        length = int(self.headers.get("content-length", "0") or "0")
        if length <= 0 or length > MAX_BODY:
            self._json(400, {"ok": False, "error": "bad_body"})
            return
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._json(400, {"ok": False, "error": "bad_json"})
            return
        if not isinstance(payload, dict) or not isinstance(payload.get("params") or {}, dict):
            self._json(400, {"ok": False, "error": "bad_request"})
            return
        tool = payload.get("tool")
        params = payload.get("params") or {}
        path = urlparse(self.path).path
        try:
            if path == "/jobs":
                job_id = self.bridge.submit_job(tenant, tool, params)
                self._json(202, {"ok": True, "job_id": job_id, "tenant": tenant.id})
                return
            if path in ("/action", "/"):
                result = self.bridge.call(tenant, tool, params)
                self._json(200, {"ok": True, "tenant": tenant.id,
                                 "result": result.get("result", {}), "receipt": result.get("receipt", {})})
                return
            self._json(404, {"ok": False, "error": "not_found"})
        except BridgeError as error:
            self._json(400, {"ok": False, "error": error.code, "message": str(error)})


def serve(config: Config) -> int:
    config.ensure_dirs()
    if not config.tenants:
        sys.stderr.write("refusing to start: no tenant token configured\n")
        return 2
    Handler.bridge = Bridge(config)
    server = ThreadingHTTPServer((config.host, config.port), Handler)
    sys.stderr.write("%s %s listening on http://%s:%s (tenants: %s)\n" % (
        now_iso(), ENGINE, config.host, config.port, ",".join(sorted(config.tenants))))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


def mcp(config: Config) -> int:
    config.ensure_dirs()
    if not config.default_tenant:
        sys.stderr.write("refusing to start: no tenant token configured\n")
        return 2
    bridge = Bridge(config)
    tenant = config.default_tenant
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            continue
        method = request.get("method")
        request_id = request.get("id")
        if method == "notifications/initialized":
            continue
        if method == "initialize":
            result = {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}},
                      "serverInfo": {"name": "workloom-visual-bridge", "version": "0.2.0"}}
        elif method == "tools/list":
            result = {"tools": [
                {"name": name, "description": description,
                 "inputSchema": {"type": "object", "properties": {key: {"type": "string"} for key in params}}}
                for name, description, params in Bridge.TOOLS
            ]}
        elif method == "tools/call":
            params = request.get("params") or {}
            try:
                outcome = bridge.call(tenant, params.get("name", ""), params.get("arguments") or {})
                result = {"content": [{"type": "text", "text": json.dumps(outcome, ensure_ascii=False)}],
                          "isError": False}
            except BridgeError as error:
                result = {"content": [{"type": "text", "text": json.dumps(
                    {"error": error.code, "message": str(error)}, ensure_ascii=False)}], "isError": True}
        else:
            result = None
        if request_id is not None:
            response = {"jsonrpc": "2.0", "id": request_id, "result": result}
            sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
            sys.stdout.flush()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=ENGINE)
    parser.add_argument("mode", nargs="?", default="serve", choices=["serve", "mcp", "call"])
    parser.add_argument("--config", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json"))
    parser.add_argument("--tool")
    parser.add_argument("--tenant", default=None)
    parser.add_argument("--params", default="{}")
    args = parser.parse_args()
    config_path = os.path.abspath(os.path.expanduser(args.config))
    if not os.path.exists(config_path):
        sys.stderr.write("config not found: %s\n" % config_path)
        return 2
    with open(config_path, "r", encoding="utf-8") as handle:
        config = Config(json.load(handle), os.path.dirname(config_path))
    if args.mode == "serve":
        return serve(config)
    if args.mode == "mcp":
        return mcp(config)
    config.ensure_dirs()
    if not config.default_tenant:
        sys.stderr.write("no tenant configured\n")
        return 2
    tenant = config.tenants.get(args.tenant) if args.tenant else config.default_tenant
    if tenant is None:
        sys.stderr.write("unknown tenant %s\n" % args.tenant)
        return 2
    bridge = Bridge(config)
    try:
        outcome = bridge.call(tenant, args.tool, json.loads(args.params))
    except BridgeError as error:
        print(json.dumps({"ok": False, "error": error.code, "message": str(error)}, ensure_ascii=False))
        return 1
    print(json.dumps(outcome, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
