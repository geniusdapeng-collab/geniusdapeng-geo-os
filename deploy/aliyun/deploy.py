#!/usr/bin/env python3
"""Isolated, explicit PengManager deployment. Never execute runtime.env as shell code."""
import argparse
from contextlib import contextmanager
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import pwd
import re
import shutil
import socket
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parent))
from nginx_proxy import NginxProxy, path_argument

BASE = Path("/opt/pengmanager-system")
DATA = Path("/var/lib/pengmanager-system")
CONFIG = Path("/etc/pengmanager-system")
ENV_FILE = CONFIG / "runtime.env"
UNIT = Path("/etc/systemd/system/pengmanager-system.service")
SERVICE = "pengmanager-system.service"
USER = "pengmanager-system"
CADDYFILE = Path("/etc/caddy/Caddyfile")
CADDY_SITE = Path("/etc/caddy/pengmanager-sites/pengmanager-system.caddy")
MARKER = "# Managed by PengManager deployment v1"
MAX_SOURCE = 1024 * 1024 * 1024
MAX_BACKUP = 64 * MAX_SOURCE


class DeployError(Exception):
    pass


def report(**values):
    print(json.dumps(values, ensure_ascii=False, sort_keys=True), flush=True)


def require(condition, message):
    if not condition:
        raise DeployError(message)


def stamp():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")


def sha256(path):
    value = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


@contextmanager
def exclusive_operation(enabled):
    if not enabled:
        yield
        return
    require(platform.system() == "Linux" and os.geteuid() == 0,
            "Host mutations require root on the installed Linux machine.")
    descriptor = os.open("/run/lock/pengmanager-system.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise DeployError("Another PengManager install/update/backup/restore is active; no concurrent mutation was started.")
        yield
    finally:
        os.close(descriptor)


def private_write(path, contents):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as output:
        output.write(contents)


def managed_directory(path):
    """Reject symlinks in private runtime/tooling/cache ancestors before mkdir/chown."""
    require(path == BASE or path.is_relative_to(BASE), "Managed directory is outside the private installation root.")
    paths = [BASE]
    cursor = BASE
    for segment in path.relative_to(BASE).parts:
        cursor = cursor / segment
        paths.append(cursor)
    for item in paths:
        require(not item.is_symlink() and (not item.exists() or item.is_dir()),
                f"Managed directory must be a regular directory without symlink ancestors: {item}")


def install_runtime_env(source, domain):
    read_env(source, domain)
    require(not ENV_FILE.is_symlink(), "Installed runtime.env must not be a symlink, including a dangling link.")
    if ENV_FILE.exists():
        read_env(ENV_FILE, domain)
        require(ENV_FILE.read_bytes() == source.read_bytes(), "Existing runtime configuration differs; it will not be overwritten.")
        return
    # O_EXCL also rejects a symlink created after the guard, without following it.
    private_write(ENV_FILE, source.read_text())


def run(argv, cwd=None, capture=True, allow_failure=False):
    environment = dict(os.environ)
    # Package tools must not inherit operator npm configuration or credentials.
    for key in list(environment):
        if key.upper().startswith("NPM_CONFIG_") or any(word in key.upper() for word in
                ("TOKEN", "PASSWORD", "SECRET", "API_KEY", "ACCESS_KEY", "COOKIE", "CREDENTIAL")):
            environment.pop(key)
    environment["PATH"] = f"{BASE}/node-current/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    result = subprocess.run([str(value) for value in argv], cwd=cwd, env=environment,
                            stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                            stderr=subprocess.PIPE, text=True, check=False)
    if result.returncode:
        if allow_failure:
            return None
        # Package manager and server errors can contain secrets or private configuration.
        raise DeployError(f"Command failed ({result.returncode}): {Path(str(argv[0])).name}; arguments/output withheld.")
    return result.stdout if capture else ""


def service_active():
    return subprocess.run(["systemctl", "is-active", "--quiet", SERVICE],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0


def hostname(value):
    value = value.lower()
    require(len(value) <= 253 and "." in value and all(
        re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", part) for part in value.split(".")),
        "Domain must be one ASCII DNS hostname, without scheme, port or path.")
    return value


def read_env(path, domain=None, strict_permissions=True):
    require(path.is_file() and not path.is_symlink(), "Runtime configuration must be a regular file.")
    if strict_permissions:
        require(stat.S_IMODE(path.stat().st_mode) == 0o600,
                "Runtime configuration must have mode 0600; contents withheld.")
    values = {}
    for line in path.read_text().splitlines():
        if not line or line.startswith("#"):
            continue
        require(re.fullmatch(r"[A-Z][A-Z0-9_]*=[^\s\x00]*", line) is not None,
                "Runtime configuration contains an unsupported line; contents withheld.")
        key, value = line.split("=", 1)
        require(key not in values, "Runtime configuration contains duplicate keys.")
        values[key] = value
    origin = values.get("PUBLIC_ORIGIN", "")
    public_host = hostname(origin.removeprefix("https://"))
    if domain:
        require(public_host == domain, "Configuration domain does not match requested domain.")
    expected = {"NODE_ENV": "production", "HOST": "127.0.0.1", "PORT": "4318",
                "PUBLIC_WEBSITE": "1", "ENABLE_MEDIA_RENDER": "false",
                "ALLOWED_HOSTS": public_host, "PUBLIC_ORIGIN": f"https://{public_host}",
                "DATA_FILE": str(DATA / "state.json"),
                "GEO_ENGINE_DB": str(DATA / "geo-engine/personal-geo.sqlite")}
    permitted = set(expected) | {"ADMIN_PASSWORD_HASH", "ADMIN_AGENT_TOKEN_HASH", "ADMIN_SESSION_TTL_SECONDS",
                                 "ADMIN_LOGIN_ATTEMPTS", "ADMIN_LOGIN_WINDOW_SECONDS", "GITHUB_TOKEN", "DEEPSEEK_API_KEY"}
    require(set(values) <= permitted, "Runtime configuration has unknown keys; only the documented deployment settings are accepted.")
    for key, value in expected.items():
        require(values.get(key) == value, f"Runtime configuration has an unsafe {key} value; contents withheld.")
    require(re.fullmatch(r"scrypt-sha256\$65536\$8\$2\$[a-f0-9]{32}\$[a-f0-9]{128}",
                         values.get("ADMIN_PASSWORD_HASH", "")) is not None,
            "ADMIN_PASSWORD_HASH is missing or invalid; generate it through configure.mjs stdin.")
    require(not values.get("GITHUB_TOKEN") and not values.get("DEEPSEEK_API_KEY"),
            "Default low-cost deployment does not accept live publishing/model credentials.")
    agent = values.get("ADMIN_AGENT_TOKEN_HASH", "")
    require(not agent or re.fullmatch(r"sha256\$[a-f0-9]{64}", agent), "Agent token hash format is invalid.")
    return values, public_host


def proxy_settings(args, domain):
    """Proxy mode is installed metadata, not a shell environment variable."""
    path = CONFIG / "proxy.json"
    require(not path.is_symlink(), "Installed proxy settings must not be a symlink.")
    requested = getattr(args, "proxy", None)
    if path.exists():
        require(path.is_file() and stat.S_IMODE(path.stat().st_mode) == 0o600,
                "Installed proxy settings must be a regular 0600 file.")
        settings = json.loads(path.read_text())
        require(isinstance(settings, dict) and settings.get("schema") == "pengmanager-proxy/v1" and settings.get("proxy") in ("caddy", "nginx"),
                "Installed proxy settings schema is unsupported.")
        require(settings.get("domain") == domain and requested in (None, settings["proxy"]),
                "Domain/proxy changes require a separately reviewed migration; existing routing is preserved.")
        require(not getattr(args, "tls_cert", None) and not getattr(args, "tls_key", None),
                "Installed certificate paths are preserved; certificate path changes require a separate explicit migration.")
    else:
        mode = requested or "caddy"
        require(getattr(args, "command", None) != "update" or mode == "caddy",
                "Legacy updates retain Caddy; switching to nginx requires a reviewed migration.")
        settings = {"schema": "pengmanager-proxy/v1", "proxy": mode, "domain": domain}
        if mode == "nginx":
            certificate, key = getattr(args, "tls_cert", None), getattr(args, "tls_key", None)
            require(bool(certificate) == bool(key), "Provide both --tls-cert and --tls-key, or neither.")
            name = f"pengmanager-system-{domain}"
            lineage = Path("/etc/letsencrypt/live") / name
            settings.update(certificate=str(path_argument(certificate, require)) if certificate else str(lineage / "fullchain.pem"),
                            privateKey=str(path_argument(key, require)) if key else str(lineage / "privkey.pem"),
                            certName=name, managedCertificate=not bool(certificate))
    expected = {"schema", "proxy", "domain"}
    if settings["proxy"] == "nginx":
        expected |= {"certificate", "privateKey", "certName", "managedCertificate"}
        path_argument(settings.get("certificate", ""), require)
        path_argument(settings.get("privateKey", ""), require)
        require(settings.get("certName") == f"pengmanager-system-{domain}" and
                type(settings.get("managedCertificate")) is bool, "Installed nginx certificate settings are invalid.")
    else:
        require(not any(getattr(args, field, None) for field in
                        ("tls_cert", "tls_key", "acme_account", "accept_acme_terms", "acme_email", "acme_no_email")),
                "TLS/ACME arguments apply only to --proxy nginx.")
    require(set(settings) == expected, "Installed proxy settings contain unknown or missing fields.")
    return settings


def save_proxy_settings(settings):
    path = CONFIG / "proxy.json"
    require(not path.is_symlink(), "Installed proxy settings must not be a symlink.")
    if path.exists():
        require(json.loads(path.read_text()) == settings and stat.S_IMODE(path.stat().st_mode) == 0o600,
                "Installed proxy settings changed during deployment; existing settings preserved.")
    else:
        private_write(path, json.dumps(settings, sort_keys=True) + "\n")


def safe_member(member, prefix, seen):
    path = PurePosixPath(member.name)
    require(not path.is_absolute() and ".." not in path.parts and
            path.parts and path.parts[0] == prefix and "\\" not in member.name,
            "Archive path escapes its allowed root.")
    normalized = str(path)
    require(normalized not in seen, "Archive contains a duplicate path.")
    seen.add(normalized)
    require(member.isdir() or member.isfile(), "Archive contains a link, device or other unsupported member.")
    return normalized


def verify_source(archive, expected):
    require(re.fullmatch(r"[a-f0-9]{64}", expected or "") is not None, "An explicit SHA-256 is required.")
    require(archive.is_file() and not archive.is_symlink(), "Deployment archive must be a regular file.")
    require(sha256(archive) == expected, "Archive checksum mismatch; no installation performed.")
    with tarfile.open(archive, "r:gz") as bundle:
        members = bundle.getmembers()
        seen = set()
        files = {}
        size = 0
        for member in members:
            name = safe_member(member, "app", seen)
            size += member.size
            require(size <= MAX_SOURCE, "Source archive exceeds 1 GiB uncompressed.")
            if member.isfile():
                files[name.removeprefix("app/")] = member
        require("deployment-manifest.json" in files, "Deployment manifest is missing.")
        require(files["deployment-manifest.json"].size <= 2 * 1024 * 1024, "Deployment manifest is too large.")
        manifest = json.load(bundle.extractfile(files["deployment-manifest.json"]))
        require(manifest.get("schema") == "pengmanager-deployment/v1" and
                re.fullmatch(r"[a-f0-9]{40}", manifest.get("gitSha", "")), "Deployment manifest identity is invalid.")
        records = manifest.get("files", [])
        require(isinstance(records, list) and records, "Deployment manifest has no source files.")
        content = hashlib.sha256(json.dumps(records, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
        require(content == manifest.get("contentSha256"), "Deployment manifest content digest is invalid.")
        expected_paths = set()
        for record in records:
            path = record.get("path", "")
            require(re.fullmatch(r"[\w.\-/]+", path) and ".." not in PurePosixPath(path).parts,
                    "Deployment manifest path is invalid.")
            require(path not in expected_paths, "Deployment manifest contains duplicate paths.")
            expected_paths.add(path)
            require(path in files and files[path].size == record.get("size") and
                    record.get("mode") in (0o644, 0o755), "Deployment file metadata does not match its manifest.")
            actual = hashlib.sha256(bundle.extractfile(files[path]).read()).hexdigest()
            require(actual == record.get("sha256"), f"Deployment file checksum mismatch: {path}")
        require(set(files) == expected_paths | {"deployment-manifest.json"}, "Archive has unlisted files.")
        require(re.fullmatch(r"pnpm@\d+\.\d+\.\d+", manifest.get("packageManager", "")), "pnpm is not pinned.")
        for required in ("package.json", "pnpm-lock.yaml", "src/server.mjs", "src/security/admin-auth.mjs",
                         "deploy/aliyun/runtime.json", "deploy/aliyun/deploy.py", "deploy/aliyun/nginx_proxy.py",
                         "deploy/aliyun/configure.mjs"):
            require(required in expected_paths, f"Deployment file is missing: {required}")
        package = json.load(bundle.extractfile(files["package.json"]))
        require(package.get("packageManager") == manifest["packageManager"], "Package manager pin does not match manifest.")
        return manifest


def extract_regular(archive, destination, prefix):
    with tarfile.open(archive, "r:gz") as bundle:
        seen = set()
        for member in bundle.getmembers():
            name = safe_member(member, prefix, seen)
            parts = PurePosixPath(name).parts[1:]
            target = destination.joinpath(*parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True, mode=0o755 if prefix == "app" else 0o700)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open("xb") as output:
                    shutil.copyfileobj(bundle.extractfile(member), output)
                target.chmod((0o755 if member.mode & 0o111 else 0o644) if prefix == "app" else 0o600)


def preflight(domain=None, require_root=False, proxy_mode="caddy"):
    issues = []
    warnings = []
    if platform.system() != "Linux":
        issues.append("Real installation requires Ubuntu/Debian Linux with systemd; this machine is not Linux.")
    else:
        release = Path("/etc/os-release").read_text()
        if not re.search(r'^ID=(?:"?)(ubuntu|debian)(?:"?)$', release, re.M):
            issues.append("Only Ubuntu/Debian is automated; do not run this installer on Alibaba Cloud Linux/RHEL.")
        if not Path("/run/systemd/system").is_dir():
            issues.append("systemd is not the active init system.")
        memory = int(re.search(r"MemTotal:\s+(\d+)", Path("/proc/meminfo").read_text()).group(1)) * 1024
        if memory < 1500 * 1024 * 1024:
            issues.append("At least 1.5 GiB total RAM is required; choose the 2 GiB instance.")
        prerequisites = ("systemctl", "curl", "tar", "xz", "ss", "runuser", "apt-get")
        prerequisites += ("gpg",) if proxy_mode == "caddy" else ("nginx", "openssl")
        for command in prerequisites:
            if not shutil.which(command):
                issues.append(f"Missing prerequisite: {command}")
        if shutil.which("ss"):
            result = subprocess.run(["ss", "-H", "-ltnp"], capture_output=True, text=True, check=False)
            if result.returncode:
                issues.append("Unable to inspect listening TCP ports.")
            else:
                active_pid = subprocess.run(["systemctl", "show", "-p", "MainPID", "--value", SERVICE],
                                            capture_output=True, text=True, check=False).stdout.strip()
                for line in result.stdout.splitlines():
                    fields = line.split()
                    local = fields[3] if len(fields) > 3 else ""
                    if local.endswith(":4318") and not (
                            active_pid not in ("", "0") and f"pid={active_pid}," in line and local == "127.0.0.1:4318"):
                        issues.append("Port 4318 is occupied outside the managed loopback service; existing process will not be stopped.")
                    if (local.endswith(":80") or local.endswith(":443")) and f'"{proxy_mode}"' not in line:
                        issues.append("Port 80/443 is owned by another service; existing web services will not be stopped.")
    if require_root and os.geteuid() != 0:
        issues.append("Installation/updates require root; no privilege changes were attempted.")
    disk_target = BASE if BASE.exists() else Path("/opt") if Path("/opt").exists() else Path.cwd()
    if shutil.disk_usage(disk_target).free < 2 * 1024 * 1024 * 1024:
        issues.append("At least 2 GiB free disk space is required for a release and dependencies.")
    for path in (BASE, BASE / "releases", BASE / "runtimes", BASE / "tooling", BASE / "pnpm-store",
                 BASE / "npm-cache", CONFIG, DATA):
        if path.is_symlink():
            issues.append(f"Managed path must not be a symlink: {path}")
        elif path.exists() and not path.is_dir():
            issues.append(f"Managed path must be a directory: {path}")
    if ENV_FILE.is_symlink():
        issues.append("Installed runtime.env must not be a symlink, including a dangling link.")
    elif ENV_FILE.exists() and (not ENV_FILE.is_file() or stat.S_IMODE(ENV_FILE.stat().st_mode) != 0o600):
        issues.append("Installed runtime.env must be a regular 0600 file.")
    if UNIT.is_symlink() or (UNIT.exists() and not UNIT.read_text().startswith(MARKER)):
        issues.append("An unmanaged pengmanager-system unit already exists; it will not be overwritten.")
    proxy_file = CONFIG / "proxy.json"
    if proxy_file.is_symlink() or (proxy_file.exists() and
            (not proxy_file.is_file() or stat.S_IMODE(proxy_file.stat().st_mode) != 0o600)):
        issues.append("Installed proxy settings must be a regular 0600 file.")
    if proxy_mode == "caddy" and shutil.which("caddy") and platform.system() == "Linux":
        result = subprocess.run(["systemctl", "show", "-p", "ExecStart", "--value", "caddy.service"],
                                capture_output=True, text=True, check=False)
        if result.returncode or "--config /etc/caddy/Caddyfile" not in result.stdout:
            issues.append("Existing Caddy must use caddy.service and /etc/caddy/Caddyfile; custom/API setups need a reviewed import.")
    if proxy_mode == "nginx" and platform.system() == "Linux":
        if not domain:
            issues.append("nginx preflight requires --domain to inspect existing server_name overlap.")
        else:
            try:
                settings = {"domain": domain, "certificate": "/nonexistent/fullchain.pem", "privateKey": "/nonexistent/privkey.pem"}
                NginxProxy(settings, run, require).inspect()
                invocation = run(["systemctl", "show", "-p", "ExecStart", "--value", "nginx.service"])
                require(re.search(r"(?:^|[\s{;])path=/usr/sbin/nginx(?:\s|;|$)", invocation) and
                        not re.search(r"(?:^|\s)-[cp]", invocation),
                        "Existing nginx.service must use the standard /usr/sbin/nginx default configuration; custom -c/-p setups need review.")
                result = subprocess.run(["systemctl", "is-active", "--quiet", "nginx.service"],
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                require(result.returncode == 0, "Existing nginx.service must already be active; it will not be started or replaced.")
            except (DeployError, OSError, ValueError) as error:
                issues.append(str(error) if isinstance(error, DeployError) else "Unable to inspect existing nginx safely; details withheld.")
    if domain:
        try:
            addresses = {item[4][0] for item in socket.getaddrinfo(domain, 443, type=socket.SOCK_STREAM)}
            if any(address.startswith("127.") or address == "::1" for address in addresses):
                issues.append("Public domain resolves to loopback.")
        except socket.gaierror:
            warnings.append("Domain does not resolve yet; HTTPS cannot finish until DNS points to this server.")
    return {"ok": not issues, "issues": sorted(set(issues)), "warnings": warnings,
            "platform": platform.system(), "proxy": proxy_mode, "mutated": False}


def ensure_user():
    try:
        account = pwd.getpwnam(USER)
        require(account.pw_dir == str(DATA) and account.pw_shell.endswith(("/nologin", "/false")),
                "An unrelated account uses the service username; refusing to modify it.")
    except KeyError:
        run(["useradd", "--system", "--user-group", "--home-dir", DATA,
             "--shell", "/usr/sbin/nologin", "--no-create-home", USER])
        account = pwd.getpwnam(USER)
    DATA.mkdir(parents=True, exist_ok=True, mode=0o700)
    DATA.chmod(0o700)
    os.chown(DATA, account.pw_uid, account.pw_gid)
    return account


def download(url, destination):
    run(["curl", "--fail", "--silent", "--show-error", "--location", "--proto", "=https",
         "--tlsv1.2", "--retry", "2", "--connect-timeout", "15", "--max-time", "300",
         "--output", destination, url])


def ensure_runtime(source, account):
    pin = json.loads((source / "deploy/aliyun/runtime.json").read_text())
    require(re.fullmatch(r"24\.\d+\.\d+", pin.get("nodeVersion", "")), "Node runtime pin must be an exact v24 release.")
    architecture = {"x86_64": "x64", "aarch64": "arm64"}.get(platform.machine())
    require(architecture, "Only Linux x64 and arm64 runtime downloads are automated.")
    target_name = f"linux-{architecture}"
    version = pin["nodeVersion"]
    root = BASE / "runtimes"
    managed_directory(root)
    root.mkdir(parents=True, exist_ok=True)
    runtime = root / f"node-v{version}-{target_name}"
    managed_directory(runtime)
    if not runtime.exists():
        stage = Path(tempfile.mkdtemp(prefix=".node-", dir=root))
        try:
            archive_name = f"node-v{version}-{target_name}.tar.xz"
            archive = stage / archive_name
            sums = stage / "SHASUMS256.txt"
            download(f"https://nodejs.org/dist/v{version}/{archive_name}", archive)
            download(f"https://nodejs.org/dist/v{version}/SHASUMS256.txt", sums)
            expected = pin["checksums"][target_name]
            require(re.fullmatch(r"[a-f0-9]{64}", expected) and
                    re.search(rf"^{expected}\s+{re.escape(archive_name)}$", sums.read_text(), re.M),
                    "Official Node checksum list disagrees with the reviewed pin.")
            require(sha256(archive) == expected, "Node tarball checksum mismatch; runtime was not installed.")
            run(["tar", "--no-same-owner", "-xJf", archive, "-C", stage])
            extracted = stage / runtime.name
            require((extracted / "bin/node").is_file(), "Node archive layout is invalid.")
            extracted.rename(runtime)
        finally:
            shutil.rmtree(stage, ignore_errors=True)
    require(not runtime.is_symlink() and run([runtime / "bin/node", "--version"]).strip() == f"v{version}",
            "Existing private Node runtime does not match its pin.")
    atomic_link(runtime, BASE / "node-current")
    manager = json.loads((source / "package.json").read_text())["packageManager"]
    require(re.fullmatch(r"pnpm@\d+\.\d+\.\d+", manager), "pnpm pin is invalid.")
    pnpm_version = manager.split("@")[1]
    tooling = BASE / "tooling" / f"pnpm-{pnpm_version}"
    managed_directory(tooling)
    managed_directory(BASE / "npm-cache")
    pnpm = tooling / "lib/node_modules/pnpm/bin/pnpm.cjs"
    if not pnpm.is_file():
        tooling.mkdir(parents=True, exist_ok=True)
        # npm rejects loading the same path as both user and global config.
        # A fresh 0700 directory and exclusive 0600 empty file isolate both
        # configuration layers without reading an operator's npmrc.
        with tempfile.TemporaryDirectory(prefix=".npm-config-", dir=tooling) as directory:
            global_config = Path(directory) / "global.npmrc"
            private_write(global_config, "")
            run([runtime / "bin/node", runtime / "lib/node_modules/npm/bin/npm-cli.js", "install", "--global",
                 "--prefix", tooling, "--cache", BASE / "npm-cache", "--userconfig", "/dev/null", "--globalconfig", global_config,
                 "--ignore-scripts", "--no-audit", "--no-fund", manager], capture=False)
    require(run([runtime / "bin/node", pnpm, "--version"]).strip() == pnpm_version, "Private pnpm pin verification failed.")
    return runtime / "bin/node", pnpm


def atomic_link(target, link):
    require(not link.exists() or link.is_symlink(), f"Managed link would overwrite a real path: {link}")
    temporary = link.with_name(f".{link.name}-{stamp()}")
    temporary.symlink_to(target)
    temporary.replace(link)


def remove_failed_install_link(link, release):
    require(link.is_symlink() and link.resolve() == release,
            "Failed first-install current link changed outside this deployment; it was preserved for review.")
    link.unlink()


def prepare_release(archive, manifest, account):
    releases = BASE / "releases"
    managed_directory(releases)
    releases.mkdir(parents=True, exist_ok=True)
    release = releases / manifest["gitSha"]
    if release.exists():
        require(not release.is_symlink() and
                json.loads((release / "deployment-manifest.json").read_text())["contentSha256"] == manifest["contentSha256"],
                "A different release already uses this Git SHA; rebuild after committing source changes.")
        require((release / "node_modules").is_dir() and (release / "var").is_symlink(), "Existing release is incomplete.")
        # A previous failed activation may have restored node-current to the old release's
        # runtime while retaining this fully prepared candidate for a safe retry.
        ensure_runtime(release, account)
        return release
    stage = Path(tempfile.mkdtemp(prefix=".release-", dir=releases))
    stage.chmod(0o755)
    try:
        extract_regular(archive, stage, "app")
        node, pnpm = ensure_runtime(stage, account)
        cache = BASE / "pnpm-store"
        managed_directory(cache)
        cache.mkdir(exist_ok=True, mode=0o700)
        os.chown(cache, account.pw_uid, account.pw_gid)
        for directory, directories, files in os.walk(stage):
            os.chown(directory, account.pw_uid, account.pw_gid)
            for name in files:
                os.chown(Path(directory) / name, account.pw_uid, account.pw_gid)
        # Existing runtime imports tsx/yaml/zod from devDependencies; --prod would break them.
        run(["runuser", "--user", USER, "--", node, pnpm, "install", "--frozen-lockfile", "--ignore-scripts",
             "--prod=false", "--store-dir", cache, "--config.userconfig=/dev/null"], cwd=stage, capture=False)
        run(["runuser", "--user", USER, "--", node, "--import", "tsx", "--input-type=module", "-e",
             "await import('yaml'); await import('zod'); import { DatabaseSync } from 'node:sqlite'; const db=new DatabaseSync(':memory:'); db.close();"],
            cwd=stage, capture=False)
        for record in manifest["files"]:
            require(sha256(stage / record["path"]) == record["sha256"],
                    "Source changed during dependency preparation; candidate release was not activated.")
        (stage / "var").symlink_to(DATA)
        # The long-running service can write only DATA; it cannot change source/dependencies.
        for directory, directories, files in os.walk(stage, followlinks=False):
            os.chown(directory, 0, 0)
            os.chmod(directory, stat.S_IMODE(os.stat(directory).st_mode) & ~0o022)
            for name in files:
                path = Path(directory) / name
                if not path.is_symlink():
                    os.chown(path, 0, 0)
                    path.chmod(stat.S_IMODE(path.stat().st_mode) & ~0o022)
        stage.rename(release)
        return release
    except Exception:
        # A failed staging release has never served traffic or held production data.
        shutil.rmtree(stage, ignore_errors=True)
        raise


def install_caddy():
    if shutil.which("caddy"):
        return
    key = Path("/usr/share/keyrings/caddy-stable-archive-keyring.gpg")
    sources = Path("/etc/apt/sources.list.d/caddy-stable.list")
    require(not key.exists() and not sources.exists(), "An existing Caddy repository needs review; it will not be overwritten.")
    with tempfile.TemporaryDirectory(prefix="pengmanager-caddy-") as temporary:
        temporary = Path(temporary)
        download("https://dl.cloudsmith.io/public/caddy/stable/gpg.key", temporary / "key.asc")
        download("https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt", temporary / "sources.list")
        run(["gpg", "--batch", "--dearmor", "--output", temporary / "key.gpg", temporary / "key.asc"])
        shutil.copyfile(temporary / "key.gpg", key)
        shutil.copyfile(temporary / "sources.list", sources)
        key.chmod(0o644)
        sources.chmod(0o644)
    run(["apt-get", "update"], capture=False)
    run(["apt-get", "install", "--yes", "--no-install-recommends", "caddy"], capture=False)


def configure_caddy(domain):
    require(CADDYFILE.is_file() and not CADDYFILE.is_symlink() and not CADDYFILE.parent.is_symlink(),
            "Caddyfile and its parent must be regular paths.")
    require(not CADDY_SITE.is_symlink() and not CADDY_SITE.parent.is_symlink(), "Managed Caddy site paths must not be symlinks.")
    existing_site = CADDY_SITE.read_bytes() if CADDY_SITE.exists() else None
    if existing_site is not None:
        require(existing_site.startswith(MARKER.encode()) and f"https://{domain} {{" in existing_site.decode(),
                "Existing managed Caddy site is for another domain or is unmanaged; refusing replacement.")
    else:
        adapted = json.loads(run(["caddy", "adapt", "--config", CADDYFILE, "--adapter", "caddyfile"]))
        def check_hosts(item):
            if isinstance(item, dict):
                for key, value in item.items():
                    if key == "host" and isinstance(value, list):
                        for host in value:
                            require(host != domain and not (host.startswith("*.") and domain.endswith(host[1:])),
                                    "Domain already belongs to an existing Caddy site; no routes changed.")
                    check_hosts(value)
            elif isinstance(item, list):
                for child in item:
                    check_hosts(child)
        check_hosts(adapted)
    original = CADDYFILE.read_bytes()
    CADDY_SITE.parent.mkdir(parents=True, exist_ok=True)
    site = f"{MARKER}\nhttps://{domain} {{\n\tencode zstd gzip\n\theader Strict-Transport-Security max-age=31536000\n\treverse_proxy 127.0.0.1:4318\n}}\n"
    CADDY_SITE.write_text(site)
    CADDY_SITE.chmod(0o644)
    include = "import /etc/caddy/pengmanager-sites/*.caddy"
    candidate = CADDYFILE.with_name(f".Caddyfile-pengmanager-{stamp()}")
    try:
        text = original.decode()
        content = original if re.search(r"^\s*import\s+/etc/caddy/pengmanager-sites/\*\.caddy\s*$", text, re.M) else original + f"\n{include}\n".encode()
        candidate.write_bytes(content)
        candidate.chmod(stat.S_IMODE(CADDYFILE.stat().st_mode))
        run(["caddy", "validate", "--config", candidate, "--adapter", "caddyfile"], capture=False)
        backup_dir = CONFIG / "host-backups"
        backup_dir.mkdir(exist_ok=True, mode=0o700)
        saved = backup_dir / f"Caddyfile-{stamp()}"
        saved.write_bytes(original)
        saved.chmod(0o600)
        candidate.replace(CADDYFILE)
        return original, existing_site
    except Exception:
        if existing_site is None:
            CADDY_SITE.unlink(missing_ok=True)
        else:
            CADDY_SITE.write_bytes(existing_site)
        raise
    finally:
        candidate.unlink(missing_ok=True)


def restore_caddy(saved):
    original, site = saved
    CADDYFILE.write_bytes(original)
    if site is None:
        CADDY_SITE.unlink(missing_ok=True)
    else:
        CADDY_SITE.write_bytes(site)
    run(["caddy", "validate", "--config", CADDYFILE, "--adapter", "caddyfile"], capture=False)
    run(["systemctl", "reload", "caddy.service"], capture=False)


def unit_text():
    return f"""{MARKER}
[Unit]
Description=PengManager System
After=network.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User={USER}
Group={USER}
WorkingDirectory={BASE}/current
EnvironmentFile={ENV_FILE}
Environment=PATH={BASE}/node-current/bin:/usr/bin:/bin
Environment=NODE_OPTIONS=--max-old-space-size=256
ExecStart={BASE}/node-current/bin/node src/server.mjs
Restart=on-failure
RestartSec=5
TimeoutStopSec=45
KillSignal=SIGTERM
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
ReadWritePaths={DATA}
MemoryHigh=384M
MemoryMax=512M
TasksMax=128

[Install]
WantedBy=multi-user.target
"""


def check_health(domain, attempts=20):
    for attempt in range(attempts):
        try:
            request = urllib.request.Request("http://127.0.0.1:4318/healthz", headers={"Host": domain})
            with urllib.request.urlopen(request, timeout=3) as response:
                payload = json.load(response)
                require(response.status == 200 and payload.get("ok") is True and
                        payload.get("service") == "pengmanager-system", "Unexpected health response.")
            request = urllib.request.Request("http://127.0.0.1:4318/api/bootstrap", headers={"Host": domain})
            try:
                with urllib.request.urlopen(request, timeout=3):
                    raise DeployError("Private bootstrap is accessible without authentication; deployment rejected.")
            except urllib.error.HTTPError as error:
                require(error.code == 401, "Private bootstrap did not enforce authentication.")
            return
        except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError):
            if attempt == attempts - 1:
                raise DeployError("Loopback health check did not become ready; inspect the managed service journal without exposing credentials.")
            time.sleep(1)


def assert_regular_tree(root):
    for path in root.rglob("*"):
        require(not path.is_symlink() and (path.is_file() or path.is_dir()), "Data tree contains a link/device; backup requires review.")


def backup(destination, leave_stopped=False):
    require(os.geteuid() == 0 and DATA.is_dir() and not DATA.is_symlink(), "Backup requires root and an installed regular data directory.")
    read_env(ENV_FILE)
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    require(not any(parent.is_symlink() for parent in [destination, *destination.parents]) and
            not destination.is_relative_to(DATA), "Backup destination must be outside the data directory and have no symlink parents.")
    require(stat.S_IMODE(destination.stat().st_mode) & 0o077 == 0, "Backup destination must deny access to group/other users (0700).")
    active = service_active()
    if active:
        run(["systemctl", "stop", SERVICE], capture=False)
    archive = destination / f"pengmanager-backup-{stamp()}.tar.gz"
    try:
        assert_regular_tree(DATA)
        require(shutil.disk_usage(destination).free > sum(path.stat().st_size for path in DATA.rglob("*") if path.is_file()) + 64 * 1024 * 1024,
                "Backup destination does not have enough free space.")
        with tempfile.TemporaryDirectory(prefix=".backup-", dir=destination) as temporary:
            temporary = Path(temporary)
            (temporary / "config").mkdir(mode=0o700)
            shutil.copy2(ENV_FILE, temporary / "config/runtime.env")
            proxy_file = CONFIG / "proxy.json"
            if proxy_file.exists() or proxy_file.is_symlink():
                proxy_settings(argparse.Namespace(command="backup"), read_env(ENV_FILE)[1])
                shutil.copy2(proxy_file, temporary / "config/proxy.json")
            current = (BASE / "current").resolve() if (BASE / "current").is_symlink() else None
            metadata = {"schema": "pengmanager-backup/v1", "createdAt": dt.datetime.now(dt.timezone.utc).isoformat(),
                        "release": current.name if current else None, "serviceWasActive": active}
            (temporary / "metadata.json").write_text(json.dumps(metadata))
            descriptor = os.open(archive, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "wb") as output:
                with tarfile.open(fileobj=output, mode="w:gz") as bundle:
                    bundle.add(DATA, arcname="backup/data", recursive=True)
                    bundle.add(temporary / "config", arcname="backup/config", recursive=True)
                    bundle.add(temporary / "metadata.json", arcname="backup/metadata.json")
        archive.chmod(0o600)
        checksum = sha256(archive)
        checksum_file = Path(str(archive) + ".sha256")
        private_write(checksum_file, f"{checksum}  {archive.name}\n")
        return archive, checksum
    except Exception:
        archive.unlink(missing_ok=True)
        # Backup failure must resume the prior service even when its caller requested a stopped successful backup.
        if active:
            run(["systemctl", "start", SERVICE], capture=False)
        raise
    finally:
        if active and not leave_stopped and not service_active():
            run(["systemctl", "start", SERVICE], capture=False)


def verify_backup(archive, expected):
    require(re.fullmatch(r"[a-f0-9]{64}", expected or "") and sha256(archive) == expected, "Backup checksum mismatch.")
    with tarfile.open(archive, "r:gz") as bundle:
        seen = set()
        total = 0
        for member in bundle.getmembers():
            name = safe_member(member, "backup", seen)
            require(name in ("backup", "backup/data", "backup/config", "backup/metadata.json") or
                    name.startswith(("backup/data/", "backup/config/")), "Backup contains an unexpected top-level path.")
            total += member.size
            require(total <= MAX_BACKUP, "Backup exceeds 64 GiB; explicit migration review is required.")
        require("backup/data" in seen and "backup/config/runtime.env" in seen and "backup/metadata.json" in seen,
                "Backup is incomplete.")
        metadata = json.load(bundle.extractfile("backup/metadata.json"))
        require(metadata.get("schema") == "pengmanager-backup/v1", "Backup schema is unsupported.")
        return total


def restore(archive, expected, target, restore_config=False, restart=True):
    total = verify_backup(archive, expected)
    require(target.is_absolute() and len(target.parts) >= 4 and not target.is_symlink(), "Restore requires an explicit safe absolute target.")
    require(target.name.startswith("pengmanager-"), "Restore target must use the pengmanager- namespace.")
    for reserved in ("/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/boot", "/dev", "/proc", "/sys", "/run"):
        require(not target.is_relative_to(reserved), "Restore target cannot overwrite host system directories.")
    require(target != BASE and not target.is_relative_to(BASE) and not target.is_relative_to(CONFIG), "Restore target cannot overwrite code or configuration directories.")
    for parent in [target, *target.parents]:
        require(not parent.is_symlink(), "Restore target and its parents must not be symlinks.")
    require(target.parent.is_dir() and shutil.disk_usage(target.parent).free > total + 64 * 1024 * 1024,
            "Restore target parent is missing or has insufficient free space.")
    live = target == DATA
    require(not restore_config or live, "Runtime configuration can be restored only with the managed live data directory.")
    if live:
        require(os.geteuid() == 0 and platform.system() == "Linux", "Live restore requires root on the installed Linux machine.")
    active = service_active() if live else False
    temporary = Path(tempfile.mkdtemp(prefix=".pengmanager-restore-", dir=target.parent))
    previous = target.with_name(f"{target.name}.before-restore-{stamp()}")
    previous_env = ENV_FILE.read_bytes() if restore_config else None
    switched = False
    try:
        extract_regular(archive, temporary, "backup")
        values, domain = read_env(temporary / "config/runtime.env")
        if restore_config:
            require(read_env(ENV_FILE)[1] == domain,
                    "Backup configuration uses a different public domain; preserve current configuration and plan a separate domain migration.")
        if live:
            account = pwd.getpwnam(USER)
            for path in [temporary / "data", *(temporary / "data").rglob("*")]:
                os.chown(path, account.pw_uid, account.pw_gid)
                path.chmod(0o700 if path.is_dir() else 0o600)
            if active:
                run(["systemctl", "stop", SERVICE], capture=False)
        if target.exists():
            target.rename(previous)
        (temporary / "data").rename(target)
        switched = True
        if restore_config:
            shutil.copyfile(temporary / "config/runtime.env", ENV_FILE)
            ENV_FILE.chmod(0o600)
        if active and restart:
            run(["systemctl", "start", SERVICE], capture=False)
            check_health(read_env(ENV_FILE)[1])
        return previous if previous.exists() else None
    except Exception:
        if live:
            run(["systemctl", "stop", SERVICE], capture=False)
        if switched and target.exists():
            # Preserve failed restored data as well; never delete either generation.
            target.rename(target.with_name(f"{target.name}.failed-restore-{stamp()}"))
        if previous.exists():
            previous.rename(target)
        if previous_env is not None:
            ENV_FILE.write_bytes(previous_env)
            ENV_FILE.chmod(0o600)
        if active:
            run(["systemctl", "start", SERVICE], capture=False)
        raise
    finally:
        shutil.rmtree(temporary, ignore_errors=True)


def deploy(args, manifest):
    domain = hostname(args.domain) if args.domain else read_env(ENV_FILE)[1]
    configuration = Path(args.env_file).absolute() if getattr(args, "env_file", None) else ENV_FILE
    require(args.command != "install" or (getattr(args, "env_file", None) and configuration != ENV_FILE),
            "First install requires --env-file at a separate protected staging path; runtime.env is created by installation.")
    require(args.command != "update" or configuration == ENV_FILE,
            "Updates preserve the installed runtime.env; configure changes need a separate explicit operation.")
    read_env(configuration, domain)
    proxy = proxy_settings(args, domain)
    require(not manifest.get("dirty") or args.allow_dirty, "Dirty checkout package requires --allow-dirty; production should use a committed release.")
    before = preflight(domain, require_root=True, proxy_mode=proxy["proxy"])
    require(before["ok"], "; ".join(before["issues"]))
    current = BASE / "current"
    previous = current.resolve() if current.is_symlink() else None
    require(not previous or previous.parent == BASE / "releases", "Current release link points outside the managed release directory.")
    if args.command == "install":
        require(previous is None, "System already has a current release; use update.sh without replacing runtime configuration.")
        require(not ENV_FILE.is_symlink(), "Installed runtime.env must not be a symlink, including a dangling link.")
        if ENV_FILE.exists():
            read_env(ENV_FILE, domain)
        require(not ENV_FILE.exists() or ENV_FILE.read_bytes() == configuration.read_bytes(),
                "Existing runtime configuration differs; it will not be overwritten.")
    else:
        require(previous is not None and UNIT.is_file(), "No installed release exists; use install.sh first.")
    for path in (BASE, CONFIG):
        path.mkdir(parents=True, exist_ok=True, mode=0o755 if path == BASE else 0o700)
    CONFIG.chmod(0o700)
    account = ensure_user()
    node_link = BASE / "node-current"
    previous_node = node_link.resolve() if node_link.is_symlink() else None
    try:
        release = prepare_release(Path(args.package).absolute(), manifest, account)
    except Exception:
        if previous_node:
            atomic_link(previous_node, node_link)
        raise
    old_unit = UNIT.read_bytes() if UNIT.exists() else None
    caddy_saved = None
    nginx = NginxProxy(proxy, run, require, args) if proxy["proxy"] == "nginx" else None
    snapshot = None
    snapshot_hash = None
    active = service_active()
    activated = False
    try:
        if previous:
            snapshot, snapshot_hash = backup(Path(args.backup_dir).absolute(), leave_stopped=True)
        else:
            install_runtime_env(configuration, domain)
        if nginx:
            nginx.prepare()
        else:
            install_caddy()
            caddy_saved = configure_caddy(domain)
        UNIT.write_text(unit_text())
        UNIT.chmod(0o644)
        run(["systemctl", "daemon-reload"], capture=False)
        atomic_link(release, current)
        activated = True
        run(["systemctl", "enable", SERVICE], capture=False)
        run(["systemctl", "start", SERVICE], capture=False)
        check_health(domain)
        if nginx:
            nginx.reload()
        else:
            run(["systemctl", "enable", "--now", "caddy.service"], capture=False)
            run(["systemctl", "reload", "caddy.service"], capture=False)
        save_proxy_settings(proxy)
        report(ok=True, command=args.command, gitSha=manifest["gitSha"], contentSha256=manifest["contentSha256"],
               origin=f"https://{domain}", service=SERVICE, proxy=proxy["proxy"], loopbackHealth=True, privateApiRequiresLogin=True,
               backup=str(snapshot) if snapshot else None, publicHttpsVerified=False,
               next="Verify public DNS, HTTPS, login and private data from an external browser; mainland sites require approved ICP before serving.")
    except Exception as failure:
        rollback_errors = []
        def attempt(label, action):
            try:
                action()
                return True
            except Exception:
                rollback_errors.append(label)
                return False
        stopped = attempt("stop candidate", lambda: run(["systemctl", "stop", SERVICE], capture=False)) if activated else True
        data_ready = True
        if previous:
            attempt("restore code link", lambda: atomic_link(previous, current))
            if previous_node:
                attempt("restore Node link", lambda: atomic_link(previous_node, node_link))
            if snapshot and stopped:
                data_ready = attempt("restore stopped data snapshot", lambda: restore(snapshot, snapshot_hash, DATA, restart=False))
            elif snapshot:
                data_ready = False
                rollback_errors.append("data left untouched because candidate could not be stopped")
        elif activated and stopped:
            # A failed first activation is not an installed release. Keep its
            # source/data/certificate for diagnosis and retry, but do not leave
            # current falsely blocking install before proxy.json was persisted.
            attempt("remove failed first-install current link", lambda: remove_failed_install_link(current, release))
        if old_unit is not None:
            attempt("restore service unit", lambda: UNIT.write_bytes(old_unit))
        elif UNIT.exists():
            # Keep the first-install unit for diagnosis, but never leave a failed app running.
            attempt("disable failed first install", lambda: run(["systemctl", "disable", SERVICE], capture=False))
        attempt("reload unit definitions", lambda: run(["systemctl", "daemon-reload"], capture=False))
        if caddy_saved is not None:
            attempt("restore Caddy configuration", lambda: restore_caddy(caddy_saved))
        if nginx is not None:
            attempt("restore only managed nginx site/link/hook", nginx.restore)
        if previous and active and data_ready and not rollback_errors:
            attempt("restart previous service", lambda: run(["systemctl", "start", SERVICE], capture=False))
            if not rollback_errors:
                attempt("verify previous service health", lambda: check_health(domain))
        reason = str(failure) if isinstance(failure, DeployError) else type(failure).__name__
        if rollback_errors:
            raise DeployError(f"Deployment failed ({reason}); rollback needs review: {', '.join(rollback_errors)}. Preserved backup: {snapshot or 'first-install data directory'}")
        raise DeployError(f"Deployment failed ({reason}); previous managed code/data/configuration were restored where present.")


def parser():
    value = argparse.ArgumentParser(description=__doc__)
    commands = value.add_subparsers(dest="command", required=True)
    check = commands.add_parser("preflight")
    check.add_argument("--domain")
    check.add_argument("--dry-run", action="store_true")
    check.add_argument("--proxy", choices=("caddy", "nginx"))
    for name in ("install", "update"):
        command = commands.add_parser(name)
        command.add_argument("--package", required=True)
        command.add_argument("--sha256", required=True)
        command.add_argument("--domain", required=name == "install")
        command.add_argument("--env-file")
        command.add_argument("--backup-dir", default="/var/backups/pengmanager-system")
        command.add_argument("--allow-dirty", action="store_true")
        command.add_argument("--dry-run", action="store_true")
        command.add_argument("--proxy", choices=("caddy", "nginx"))
        command.add_argument("--tls-cert")
        command.add_argument("--tls-key")
        command.add_argument("--acme-account")
        command.add_argument("--accept-acme-terms", action="store_true")
        contacts = command.add_mutually_exclusive_group()
        contacts.add_argument("--acme-email")
        contacts.add_argument("--acme-no-email", action="store_true")
    command = commands.add_parser("verify")
    command.add_argument("--package", required=True)
    command.add_argument("--sha256", required=True)
    command = commands.add_parser("backup")
    command.add_argument("--destination", required=True)
    command.add_argument("--leave-stopped", action="store_true")
    command.add_argument("--dry-run", action="store_true")
    command = commands.add_parser("restore")
    command.add_argument("--archive", required=True)
    command.add_argument("--sha256", required=True)
    command.add_argument("--target", required=True)
    command.add_argument("--restore-config", action="store_true")
    command.add_argument("--dry-run", action="store_true")
    return value


def dispatch(args):
    if args.command == "preflight":
        domain = hostname(args.domain) if args.domain else (read_env(ENV_FILE)[1] if ENV_FILE.exists() else None)
        mode = proxy_settings(args, domain)["proxy"] if domain else args.proxy or "caddy"
        result = preflight(domain, proxy_mode=mode)
        report(command="preflight", **result)
        return 0 if result["ok"] else 1
    if args.command in ("install", "update", "verify"):
        manifest = verify_source(Path(args.package).absolute(), args.sha256)
        if args.command == "verify":
            report(ok=True, command="verify", gitSha=manifest["gitSha"], contentSha256=manifest["contentSha256"],
                   dirty=manifest["dirty"], files=len(manifest["files"]), mutated=False)
        elif args.dry_run:
            domain = hostname(args.domain) if args.domain else (read_env(ENV_FILE)[1] if ENV_FILE.exists() else "<existing-runtime-origin>")
            if args.env_file:
                read_env(Path(args.env_file).absolute(), domain)
            proxy = proxy_settings(args, domain)
            report(ok=True, dryRun=True, command=args.command, gitSha=manifest["gitSha"], dirty=manifest["dirty"],
                   domain=domain, release=str(BASE / "releases" / manifest["gitSha"]), data=str(DATA),
                   runtimeEnv=str(ENV_FILE), proxy=proxy["proxy"],
                   newAcmeRegistrationNeedsExplicitAcceptance=proxy["proxy"] == "nginx" and proxy["managedCertificate"],
                   preflight=preflight(domain if not domain.startswith("<") else None, proxy_mode=proxy["proxy"]), mutated=False)
        else:
            deploy(args, manifest)
    elif args.command == "backup":
        if args.dry_run:
            report(ok=True, dryRun=True, command="backup", data=str(DATA), destination=str(Path(args.destination).absolute()),
                   stopsService=True, includes=["complete data directory", "runtime.env credential hashes", "release metadata"], mutated=False)
        else:
            archive, checksum = backup(Path(args.destination).absolute(), args.leave_stopped)
            report(ok=True, command="backup", archive=str(archive), sha256=checksum, mode="0600")
    elif args.command == "restore":
        if args.dry_run:
            total = verify_backup(Path(args.archive).absolute(), args.sha256)
            report(ok=True, dryRun=True, command="restore", target=str(Path(args.target).absolute()), bytes=total,
                   previousDataPreserved=True, restoreConfig=args.restore_config, mutated=False)
        else:
            previous = restore(Path(args.archive).absolute(), args.sha256, Path(args.target).absolute(), args.restore_config)
            report(ok=True, command="restore", target=str(Path(args.target).absolute()), preserved=str(previous) if previous else None)
    return 0


def main():
    args = parser().parse_args()
    mutates_host = not getattr(args, "dry_run", False) and (args.command in ("install", "update", "backup") or
                   (args.command == "restore" and Path(args.target).absolute() == DATA))
    with exclusive_operation(mutates_host):
        return dispatch(args)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (DeployError, OSError, ValueError, KeyError, tarfile.TarError) as error:
        # Never emit a traceback or arbitrary subprocess output from a production installer.
        message = str(error) if isinstance(error, DeployError) else f"{type(error).__name__}; details withheld to protect configuration."
        report(ok=False, error=message)
        sys.exit(1)
