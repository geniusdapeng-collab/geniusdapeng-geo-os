"""Portable tests: no root, cloud account, network access or systemd mutation."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("pengmanager_deployment", HERE / "deploy.py")
DEPLOY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DEPLOY)
import nginx_proxy as NGINX
ROOT = HERE.parent.parent


def environment(domain="admin.example.cn"):
    values = {
        "NODE_ENV": "production", "HOST": "127.0.0.1", "PORT": "4318",
        "ALLOWED_HOSTS": domain, "PUBLIC_ORIGIN": f"https://{domain}", "PUBLIC_WEBSITE": "1",
        "ENABLE_MEDIA_RENDER": "false", "DATA_FILE": str(DEPLOY.DATA / "state.json"),
        "GEO_ENGINE_DB": str(DEPLOY.DATA / "geo-engine/personal-geo.sqlite"),
        "ADMIN_PASSWORD_HASH": "scrypt-sha256$65536$8$2$" + "0" * 32 + "$" + "0" * 128,
        "ADMIN_AGENT_TOKEN_HASH": "", "GITHUB_TOKEN": "", "DEEPSEEK_API_KEY": "",
    }
    return "\n".join(f"{key}={value}" for key, value in values.items()) + "\n"


def add_file(bundle, name, data, mode=0o644):
    entry = tarfile.TarInfo(name)
    entry.size = len(data)
    entry.mode = mode
    bundle.addfile(entry, io.BytesIO(data))


def source_archive(destination, mutation=None):
    sources = {"package.json": b'{"packageManager":"pnpm@1.0.0"}', "pnpm-lock.yaml": b"lockfileVersion: '9.0'\n",
               "src/server.mjs": b"export {};\n", "src/security/admin-auth.mjs": b"export {};\n",
               "deploy/aliyun/runtime.json": b"{}\n", "deploy/aliyun/deploy.py": b"# fixture source\n",
               "deploy/aliyun/nginx_proxy.py": b"# fixture source\n", "deploy/aliyun/configure.mjs": b"export {};\n"}
    records = [{"path": name, "sha256": hashlib.sha256(value).hexdigest(), "size": len(value), "mode": 0o644}
               for name, value in sorted(sources.items())]
    manifest = {"schema": "pengmanager-deployment/v1", "gitSha": "a" * 40, "dirty": False,
                "contentSha256": hashlib.sha256(json.dumps(records, separators=(",", ":")).encode()).hexdigest(),
                "packageManager": "pnpm@1.0.0", "files": records}
    with tarfile.open(destination, "w:gz") as bundle:
        for name, data in sources.items():
            add_file(bundle, f"app/{name}", data)
        add_file(bundle, "app/deployment-manifest.json", json.dumps(manifest).encode())
        if mutation:
            mutation(bundle)
    return DEPLOY.sha256(destination)


def backup_archive(destination, mutation=None):
    with tarfile.open(destination, "w:gz") as bundle:
        entry = tarfile.TarInfo("backup/data")
        entry.type = tarfile.DIRTYPE
        entry.mode = 0o700
        bundle.addfile(entry)
        add_file(bundle, "backup/data/state.json", b'{"restored":true}\n', 0o600)
        add_file(bundle, "backup/config/runtime.env", environment().encode(), 0o600)
        add_file(bundle, "backup/metadata.json", b'{"schema":"pengmanager-backup/v1"}', 0o600)
        if mutation:
            mutation(bundle)
    return DEPLOY.sha256(destination)


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        (ROOT / "var").mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix="deployment-tests-", dir=ROOT / "var")
        self.path = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def test_source_manifest_and_every_file_verified(self):
        archive = self.path / "source.tar.gz"
        checksum = source_archive(archive)
        manifest = DEPLOY.verify_source(archive, checksum)
        self.assertEqual(manifest["gitSha"], "a" * 40)
        self.assertEqual(len(manifest["files"]), 8)

    def test_wrong_package_checksum_fails_before_extract(self):
        archive = self.path / "source.tar.gz"
        source_archive(archive)
        with self.assertRaisesRegex(DEPLOY.DeployError, "checksum"):
            DEPLOY.verify_source(archive, "0" * 64)
        self.assertEqual(sorted(item.name for item in self.path.iterdir()), ["source.tar.gz"])

    def test_path_traversal_rejected(self):
        archive = self.path / "source.tar.gz"
        checksum = source_archive(archive, lambda bundle: add_file(bundle, "app/../../outside", b"bad"))
        with self.assertRaisesRegex(DEPLOY.DeployError, "escapes"):
            DEPLOY.verify_source(archive, checksum)

    def test_archive_symlink_rejected(self):
        def mutation(bundle):
            entry = tarfile.TarInfo("app/link")
            entry.type = tarfile.SYMTYPE
            entry.linkname = "/etc/shadow"
            bundle.addfile(entry)
        archive = self.path / "source.tar.gz"
        checksum = source_archive(archive, mutation)
        with self.assertRaisesRegex(DEPLOY.DeployError, "link"):
            DEPLOY.verify_source(archive, checksum)

    def test_unlisted_file_rejected(self):
        archive = self.path / "source.tar.gz"
        checksum = source_archive(archive, lambda bundle: add_file(bundle, "app/unlisted", b"bad"))
        with self.assertRaisesRegex(DEPLOY.DeployError, "unlisted"):
            DEPLOY.verify_source(archive, checksum)

    def test_duplicate_member_rejected(self):
        archive = self.path / "source.tar.gz"
        checksum = source_archive(archive, lambda bundle: add_file(bundle, "app/src/server.mjs", b"modified"))
        with self.assertRaisesRegex(DEPLOY.DeployError, "duplicate"):
            DEPLOY.verify_source(archive, checksum)

    def test_environment_requires_hash_permission_origin_and_loopback(self):
        path = self.path / "runtime.env"
        path.write_text(environment())
        path.chmod(0o600)
        self.assertEqual(DEPLOY.read_env(path)[1], "admin.example.cn")
        for replacement in (environment().replace("HOST=127.0.0.1", "HOST=0.0.0.0"),
                            environment().replace("PUBLIC_ORIGIN=https://", "PUBLIC_ORIGIN=http://"),
                            environment().replace("scrypt-sha256", "plaintext"),
                            environment() + "GITHUB_TOKEN=unexpected\n"):
            path.write_text(replacement)
            with self.assertRaises(DEPLOY.DeployError):
                DEPLOY.read_env(path)
        path.write_text(environment())
        path.chmod(0o644)
        with self.assertRaisesRegex(DEPLOY.DeployError, "0600"):
            DEPLOY.read_env(path)

    def test_domain_with_shell_or_caddy_injection_is_rejected(self):
        for value in ("example.cn;touch /tmp/x", "https://example.cn", "example.cn:443", "example.cn\nrespond ok", "-bad.cn"):
            with self.assertRaises(DEPLOY.DeployError):
                DEPLOY.hostname(value)

    def test_dangling_runtime_env_symlink_never_writes_external_target(self):
        config = self.path / "config"
        config.mkdir(mode=0o700)
        source = self.path / "staging.env"
        source.write_text(environment())
        source.chmod(0o600)
        outside = self.path / "outside.env"
        installed = config / "runtime.env"
        installed.symlink_to(outside)
        with mock.patch.multiple(DEPLOY, CONFIG=config, ENV_FILE=installed):
            result = DEPLOY.preflight()
            self.assertTrue(any("runtime.env" in issue and "symlink" in issue for issue in result["issues"]))
            with self.assertRaisesRegex(DEPLOY.DeployError, "symlink"):
                DEPLOY.install_runtime_env(source, "admin.example.cn")
        self.assertFalse(outside.exists())
        self.assertTrue(installed.is_symlink())

    def test_install_runtime_env_exclusive_private_and_identical_retry(self):
        source = self.path / "staging.env"
        source.write_text(environment())
        source.chmod(0o600)
        installed = self.path / "runtime.env"
        with mock.patch.object(DEPLOY, "ENV_FILE", installed):
            DEPLOY.install_runtime_env(source, "admin.example.cn")
            self.assertEqual(installed.stat().st_mode & 0o777, 0o600)
            self.assertEqual(installed.read_bytes(), source.read_bytes())
            before = installed.stat().st_mtime_ns
            DEPLOY.install_runtime_env(source, "admin.example.cn")
            self.assertEqual(installed.stat().st_mtime_ns, before)
            source.write_text(environment().replace("ADMIN_AGENT_TOKEN_HASH=\n", "ADMIN_AGENT_TOKEN_HASH=sha256$" + "1" * 64 + "\n"))
            with self.assertRaisesRegex(DEPLOY.DeployError, "differs"):
                DEPLOY.install_runtime_env(source, "admin.example.cn")

    def test_runtime_tool_and_cache_symlinks_are_rejected(self):
        base = self.path / "opt"
        base.mkdir()
        outside = self.path / "outside-cache"
        outside.mkdir()
        for name in ("runtimes", "tooling", "pnpm-store", "npm-cache"):
            with self.subTest(directory=name), mock.patch.object(DEPLOY, "BASE", base):
                link = base / name
                link.symlink_to(outside)
                result = DEPLOY.preflight()
                self.assertTrue(any(str(link) in issue and "symlink" in issue for issue in result["issues"]))
                with self.assertRaisesRegex(DEPLOY.DeployError, "symlink"):
                    DEPLOY.managed_directory(link / "version")
                link.unlink()
        tooling = base / "tooling"
        tooling.mkdir()
        (tooling / "version").symlink_to(outside)
        with mock.patch.object(DEPLOY, "BASE", base):
            with self.assertRaisesRegex(DEPLOY.DeployError, "symlink"):
                DEPLOY.managed_directory(tooling / "version")
        self.assertEqual(list(outside.iterdir()), [])

    def test_real_npm_bootstrap_config_load_ignores_operator_npmrc(self):
        node = os.environ.get("NODE_BINARY", "node")
        actual_node = Path(subprocess.run([node, "-p", "process.execPath"],
                                         capture_output=True, text=True, check=True).stdout.strip())
        npm = os.environ.get("NPM_CLI_PATH")
        if not npm:
            bundled = actual_node.parent.parent / "lib/node_modules/npm/bin/npm-cli.js"
            npm = str(bundled) if bundled.is_file() else shutil.which("npm")
        if not npm or not Path(npm).is_file():
            self.skipTest("Real npm regression requires bundled npm or NPM_CLI_PATH; no packages are downloaded.")
        npm = Path(npm).resolve()
        base, source = self.path / "opt", self.path / "source"
        (source / "deploy/aliyun").mkdir(parents=True)
        pin = json.loads((HERE / "runtime.json").read_text())
        manager = json.loads((ROOT / "package.json").read_text())["packageManager"]
        (source / "deploy/aliyun/runtime.json").write_text(json.dumps(pin))
        (source / "package.json").write_text(json.dumps({"packageManager": manager}))
        runtime = base / "runtimes" / f"node-v{pin['nodeVersion']}-linux-x64"
        runtime.mkdir(parents=True)
        operator_config = self.path / "operator.npmrc"
        operator_config.write_text("registry=https://operator-config-must-not-load.invalid/\n")
        configs = []
        fail_install = [False]
        real_run = DEPLOY.run
        def config_only(argv, **kwargs):
            values = [str(value) for value in argv]
            if values[1:] == ["--version"]:
                return f"v{pin['nodeVersion']}\n"
            if values[-1] == "--version":
                return manager.split("@")[1] + "\n"
            self.assertEqual(values[2:4], ["install", "--global"])
            path = Path(values[values.index("--globalconfig") + 1])
            configs.append(path)
            self.assertNotEqual(str(path), "/dev/null")
            self.assertEqual(path.read_bytes(), b"")
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
            self.assertTrue(path.is_relative_to(base / "tooling"))
            # Execute the real npm loader using the installer's exact config,
            # prefix and cache flags; only the install command is replaced.
            with mock.patch.dict(os.environ, {"npm_config_userconfig": str(operator_config),
                                              "NPM_CONFIG_GLOBALCONFIG": str(operator_config)}, clear=True):
                registry = real_run([actual_node, npm, "config", "get", "registry", *values[3:-1]], cwd=self.path)
            self.assertEqual(registry.strip(), "https://registry.npmjs.org/")
            if fail_install[0]:
                raise DEPLOY.DeployError("fixture npm install failed")
            return ""
        with mock.patch.object(DEPLOY, "BASE", base), \
                mock.patch.object(DEPLOY.platform, "machine", return_value="x86_64"), \
                mock.patch.object(DEPLOY, "run", side_effect=config_only):
            DEPLOY.ensure_runtime(source, SimpleNamespace())
            fail_install[0] = True
            with self.assertRaisesRegex(DEPLOY.DeployError, "fixture npm install failed"):
                DEPLOY.ensure_runtime(source, SimpleNamespace())
        self.assertEqual(len(configs), 2)
        self.assertNotEqual(configs[0], configs[1])
        self.assertTrue(all(not path.parent.exists() for path in configs))
        self.assertEqual(operator_config.read_text(), "registry=https://operator-config-must-not-load.invalid/\n")

    def test_restore_preserves_previous_data_and_private_modes(self):
        archive = self.path / "backup.tar.gz"
        checksum = backup_archive(archive)
        target = self.path / "pengmanager-restored-data"
        target.mkdir()
        (target / "original.json").write_text('{"original":true}')
        previous = DEPLOY.restore(archive, checksum, target)
        self.assertEqual(json.loads((target / "state.json").read_text()), {"restored": True})
        self.assertEqual(json.loads((previous / "original.json").read_text()), {"original": True})
        self.assertEqual((target / "state.json").stat().st_mode & 0o777, 0o600)

    def test_restore_bad_archive_does_not_replace_target(self):
        archive = self.path / "backup.tar.gz"
        checksum = backup_archive(archive, lambda bundle: add_file(bundle, "backup/../../bad", b"bad"))
        target = self.path / "pengmanager-restored-data"
        target.mkdir()
        (target / "sentinel").write_text("keep")
        with self.assertRaises(DEPLOY.DeployError):
            DEPLOY.restore(archive, checksum, target)
        self.assertEqual((target / "sentinel").read_text(), "keep")

    def test_restore_rejects_host_system_directories_and_wrong_namespace(self):
        archive = self.path / "backup.tar.gz"
        checksum = backup_archive(archive)
        for target in (self.path / "unrelated-service", Path("/etc/nginx/pengmanager-config")):
            with self.assertRaises(DEPLOY.DeployError):
                DEPLOY.restore(archive, checksum, target)

    def test_real_backup_is_private_and_restores_prior_running_state(self):
        data = self.path / "pengmanager-data"
        data.mkdir(mode=0o700)
        (data / "state.json").write_text('{"before":true}')
        config = self.path / "runtime.env"
        destination = self.path / "backups"
        active = [True]
        calls = []
        def fake_run(argv, **kwargs):
            calls.append([str(value) for value in argv])
            if argv[1] == "stop": active[0] = False
            if argv[1] == "start": active[0] = True
            return ""
        with mock.patch.multiple(DEPLOY, DATA=data, ENV_FILE=config), mock.patch.object(DEPLOY.os, "geteuid", return_value=0), \
                mock.patch.object(DEPLOY, "service_active", side_effect=lambda: active[0]), mock.patch.object(DEPLOY, "run", side_effect=fake_run):
            config.write_text(environment())
            config.chmod(0o600)
            archive, checksum = DEPLOY.backup(destination)
            self.assertEqual(archive.stat().st_mode & 0o777, 0o600)
            self.assertEqual(Path(str(archive) + ".sha256").stat().st_mode & 0o777, 0o600)
            self.assertGreater(DEPLOY.verify_backup(archive, checksum), 0)
            self.assertEqual([call[1] for call in calls], ["stop", "start"])
            self.assertTrue(active[0])

    def test_failed_backup_resumes_service_and_preserves_data(self):
        data = self.path / "pengmanager-data"
        data.mkdir(mode=0o700)
        (data / "state.json").write_text("preserve")
        (data / "unsafe-link").symlink_to(self.path / "outside")
        config = self.path / "runtime.env"
        active = [True]
        calls = []
        def fake_run(argv, **kwargs):
            calls.append(argv[1])
            if argv[1] == "stop": active[0] = False
            if argv[1] == "start": active[0] = True
            return ""
        with mock.patch.multiple(DEPLOY, DATA=data, ENV_FILE=config), mock.patch.object(DEPLOY.os, "geteuid", return_value=0), \
                mock.patch.object(DEPLOY, "service_active", side_effect=lambda: active[0]), mock.patch.object(DEPLOY, "run", side_effect=fake_run):
            config.write_text(environment())
            config.chmod(0o600)
            with self.assertRaisesRegex(DEPLOY.DeployError, "link"):
                DEPLOY.backup(self.path / "backups", leave_stopped=True)
            self.assertTrue(active[0])
            self.assertEqual(calls, ["stop", "start"])
            self.assertEqual((data / "state.json").read_text(), "preserve")

    def test_failed_update_rolls_back_code_runtime_data_and_unit(self):
        base = self.path / "opt"
        releases = base / "releases"
        releases.mkdir(parents=True)
        old = releases / ("b" * 40)
        new = releases / ("a" * 40)
        old.mkdir()
        new.mkdir()
        (base / "current").symlink_to(old)
        old_node = base / "node-old"
        new_node = base / "node-new"
        old_node.mkdir()
        new_node.mkdir()
        (base / "node-current").symlink_to(old_node)
        data = self.path / "pengmanager-system"
        data.mkdir(mode=0o700)
        (data / "state.json").write_text('{"old":true}')
        config_dir = self.path / "etc"
        config_dir.mkdir(mode=0o700)
        config = config_dir / "runtime.env"
        unit = config_dir / "pengmanager-system.service"
        old_unit = DEPLOY.MARKER + "\nold unit\n"
        unit.write_text(old_unit)
        active = [True]
        checks = [0]
        def fake_run(argv, **kwargs):
            if argv[0] == "systemctl" and argv[1] == "stop": active[0] = False
            if argv[0] == "systemctl" and argv[1] == "start": active[0] = True
            return ""
        def candidate(*args):
            DEPLOY.atomic_link(new_node, base / "node-current")
            return new
        def fake_health(domain):
            checks[0] += 1
            if checks[0] == 1:
                (data / "state.json").write_text('{"candidate":true}')
                raise DEPLOY.DeployError("candidate readiness failed")
        account = SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())
        with mock.patch.multiple(DEPLOY, BASE=base, DATA=data, CONFIG=config_dir, ENV_FILE=config, UNIT=unit), \
                mock.patch.object(DEPLOY, "preflight", return_value={"ok": True, "issues": []}), \
                mock.patch.object(DEPLOY, "ensure_user", return_value=account), \
                mock.patch.object(DEPLOY, "prepare_release", side_effect=candidate), \
                mock.patch.object(DEPLOY, "install_caddy"), mock.patch.object(DEPLOY, "configure_caddy", return_value=(b"old", None)), \
                mock.patch.object(DEPLOY, "restore_caddy"), mock.patch.object(DEPLOY, "check_health", side_effect=fake_health), \
                mock.patch.object(DEPLOY, "service_active", side_effect=lambda: active[0]), \
                mock.patch.object(DEPLOY, "run", side_effect=fake_run), mock.patch.object(DEPLOY.os, "geteuid", return_value=0), \
                mock.patch.object(DEPLOY.platform, "system", return_value="Linux"), \
                mock.patch.object(DEPLOY.pwd, "getpwnam", return_value=account):
            config.write_text(environment())
            config.chmod(0o600)
            arguments = SimpleNamespace(command="update", domain=None, env_file=None, package=self.path / "unused.tar.gz",
                                        allow_dirty=False, backup_dir=self.path / "backups")
            with self.assertRaisesRegex(DEPLOY.DeployError, "were restored"):
                DEPLOY.deploy(arguments, {"gitSha": "a" * 40, "contentSha256": "c" * 64, "dirty": False})
            self.assertEqual((base / "current").resolve(), old)
            self.assertEqual((base / "node-current").resolve(), old_node)
            self.assertEqual(json.loads((data / "state.json").read_text()), {"old": True})
            self.assertTrue(list(self.path.glob("pengmanager-system.before-restore-*")))
            self.assertEqual(unit.read_text(), old_unit)
            self.assertTrue(active[0])
            self.assertEqual(checks[0], 2)

    def test_existing_release_retry_reselects_runtime_after_rollback(self):
        base = self.path / "opt"
        releases = base / "releases"
        releases.mkdir(parents=True)
        manifest = {"gitSha": "a" * 40, "contentSha256": "c" * 64}
        release = releases / manifest["gitSha"]
        release.mkdir()
        (release / "deployment-manifest.json").write_text(json.dumps(manifest))
        (release / "node_modules").mkdir()
        (release / "var").symlink_to(self.path / "pengmanager-data")
        old_node = base / "old-node"
        candidate_node = base / "candidate-node"
        old_node.mkdir()
        candidate_node.mkdir()
        (base / "node-current").symlink_to(old_node)
        account = SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())
        def runtime_for_release(source, user):
            self.assertEqual(source, release)
            DEPLOY.atomic_link(candidate_node, base / "node-current")
            return candidate_node / "bin/node", base / "pnpm.cjs"
        with mock.patch.object(DEPLOY, "BASE", base), mock.patch.object(DEPLOY, "ensure_runtime", side_effect=runtime_for_release):
            DEPLOY.prepare_release(self.path / "unused.tar.gz", manifest, account)
            self.assertEqual((base / "node-current").resolve(), candidate_node)
            # This is the actual rollback link operation used by a failed update.
            DEPLOY.atomic_link(old_node, base / "node-current")
            self.assertEqual((base / "node-current").resolve(), old_node)
            DEPLOY.prepare_release(self.path / "unused.tar.gz", manifest, account)
            self.assertEqual((base / "node-current").resolve(), candidate_node)

    def test_nginx_update_uses_persisted_proxy_and_rolls_back_reload_failure(self):
        for fail_reload in (False, True):
            with self.subTest(fail_reload=fail_reload):
                root = self.path / str(fail_reload)
                base, config_dir = root / "opt", root / "etc"
                releases = base / "releases"
                releases.mkdir(parents=True)
                config_dir.mkdir()
                old, new = releases / ("b" * 40), releases / ("a" * 40)
                old.mkdir()
                new.mkdir()
                (base / "current").symlink_to(old)
                unit = config_dir / "unit"
                unit.write_text(DEPLOY.MARKER + "\nold unit\n")
                config = config_dir / "runtime.env"
                config.write_text(environment())
                config.chmod(0o600)
                proxy = mock.Mock()
                if fail_reload:
                    proxy.reload.side_effect = DEPLOY.DeployError("nginx reload failed")
                account = SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())
                settings = {"proxy": "nginx"}
                arguments = SimpleNamespace(command="update", domain=None, env_file=None, package=root / "unused.tar.gz",
                                            allow_dirty=False, backup_dir=root / "backups")
                with mock.patch.multiple(DEPLOY, BASE=base, CONFIG=config_dir, ENV_FILE=config, UNIT=unit), \
                        mock.patch.object(DEPLOY, "proxy_settings", return_value=settings) as selected, \
                        mock.patch.object(DEPLOY, "save_proxy_settings") as persisted, \
                        mock.patch.object(DEPLOY, "preflight", return_value={"ok": True, "issues": []}) as checked, \
                        mock.patch.object(DEPLOY, "ensure_user", return_value=account), \
                        mock.patch.object(DEPLOY, "prepare_release", return_value=new), \
                        mock.patch.object(DEPLOY, "backup", return_value=(root / "backup.tar.gz", "c" * 64)), \
                        mock.patch.object(DEPLOY, "restore") as restored, \
                        mock.patch.object(DEPLOY, "NginxProxy", return_value=proxy), \
                        mock.patch.object(DEPLOY, "install_caddy") as caddy_install, \
                        mock.patch.object(DEPLOY, "configure_caddy") as caddy_configure, \
                        mock.patch.object(DEPLOY, "restore_caddy") as caddy_restore, \
                        mock.patch.object(DEPLOY, "check_health"), mock.patch.object(DEPLOY, "report"), \
                        mock.patch.object(DEPLOY, "service_active", return_value=True), \
                        mock.patch.object(DEPLOY, "run", return_value="") as commands:
                    if fail_reload:
                        with self.assertRaisesRegex(DEPLOY.DeployError, "were restored"):
                            DEPLOY.deploy(arguments, {"gitSha": "a" * 40, "contentSha256": "c" * 64, "dirty": False})
                        self.assertEqual((base / "current").resolve(), old)
                        proxy.restore.assert_called_once()
                        restored.assert_called_once()
                        persisted.assert_not_called()
                    else:
                        DEPLOY.deploy(arguments, {"gitSha": "a" * 40, "contentSha256": "c" * 64, "dirty": False})
                        self.assertEqual((base / "current").resolve(), new)
                        persisted.assert_called_once_with(settings)
                        proxy.restore.assert_not_called()
                    selected.assert_called_once_with(arguments, "admin.example.cn")
                    checked.assert_called_once_with("admin.example.cn", require_root=True, proxy_mode="nginx")
                    proxy.prepare.assert_called_once()
                    caddy_install.assert_not_called()
                    caddy_configure.assert_not_called()
                    caddy_restore.assert_not_called()
                    self.assertFalse(any("caddy" in str(value) for call in commands.call_args_list for value in call.args[0]))

    def test_failed_first_nginx_activation_can_retry_install_without_losing_config(self):
        base, config_dir = self.path / "opt", self.path / "etc"
        releases = base / "releases"
        release = releases / ("a" * 40)
        release.mkdir(parents=True)
        staged = self.path / "staged.env"
        staged.write_text(environment())
        staged.chmod(0o600)
        config, unit = config_dir / "runtime.env", config_dir / "unit"
        proxy = mock.Mock()
        proxy.reload.side_effect = [DEPLOY.DeployError("first nginx reload failed"), None]
        arguments = SimpleNamespace(command="install", domain="admin.example.cn", env_file=staged,
                                    package=self.path / "unused.tar.gz", allow_dirty=False,
                                    backup_dir=self.path / "backups", proxy="nginx")
        account = SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())
        with mock.patch.multiple(DEPLOY, BASE=base, CONFIG=config_dir, ENV_FILE=config, UNIT=unit), \
                mock.patch.object(DEPLOY, "preflight", return_value={"ok": True, "issues": []}), \
                mock.patch.object(DEPLOY, "ensure_user", return_value=account), \
                mock.patch.object(DEPLOY, "prepare_release", return_value=release), \
                mock.patch.object(DEPLOY, "NginxProxy", return_value=proxy), \
                mock.patch.object(DEPLOY, "check_health"), mock.patch.object(DEPLOY, "report"), \
                mock.patch.object(DEPLOY, "service_active", return_value=False), \
                mock.patch.object(DEPLOY, "run", return_value=""):
            manifest = {"gitSha": "a" * 40, "contentSha256": "c" * 64, "dirty": False}
            with self.assertRaisesRegex(DEPLOY.DeployError, "were restored"):
                DEPLOY.deploy(arguments, manifest)
            self.assertFalse((base / "current").is_symlink())
            self.assertTrue(release.is_dir())
            self.assertEqual(config.read_bytes(), staged.read_bytes())
            self.assertFalse((config_dir / "proxy.json").exists())
            proxy.restore.assert_called_once()
            DEPLOY.deploy(arguments, manifest)
            self.assertEqual((base / "current").resolve(), release)
            self.assertEqual(json.loads((config_dir / "proxy.json").read_text())["proxy"], "nginx")
            self.assertEqual(config.read_bytes(), staged.read_bytes())

    def test_first_install_rollback_preserves_an_externally_replaced_current_path(self):
        release = self.path / "candidate"
        outside = self.path / "outside-release"
        release.mkdir()
        outside.mkdir()
        link = self.path / "current"
        link.symlink_to(outside)
        with self.assertRaisesRegex(DEPLOY.DeployError, "preserved"):
            DEPLOY.remove_failed_install_link(link, release)
        self.assertEqual(link.resolve(), outside)
        link.unlink()
        link.write_text("external regular file")
        with self.assertRaisesRegex(DEPLOY.DeployError, "preserved"):
            DEPLOY.remove_failed_install_link(link, release)
        self.assertEqual(link.read_text(), "external regular file")

    def test_dry_run_is_read_only_even_on_non_linux_host(self):
        archive = self.path / "source.tar.gz"
        checksum = source_archive(archive)
        config = self.path / "runtime.env"
        config.write_text(environment())
        config.chmod(0o600)
        before = {item.name: item.stat().st_mtime_ns for item in self.path.iterdir()}
        result = subprocess.run(["python3", HERE / "deploy.py", "install", "--dry-run", "--package", archive,
                                 "--sha256", checksum, "--domain", "admin.example.cn", "--env-file", config],
                                capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertTrue(json.loads(result.stdout)["dryRun"])
        self.assertFalse(json.loads(result.stdout)["mutated"])
        self.assertEqual(before, {item.name: item.stat().st_mtime_ns for item in self.path.iterdir()})

    def test_password_stdin_is_hashed_without_stdout_or_plaintext_file(self):
        node = os.environ.get("NODE_BINARY", "node")
        config = self.path / "generated.env"
        password = secrets.token_urlsafe(24)
        result = subprocess.run([node, HERE / "configure.mjs", "--domain", "admin.example.cn", "--output", config],
                                input=password + "\n", capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(password, result.stdout + result.stderr + config.read_text())
        self.assertEqual(config.stat().st_mode & 0o777, 0o600)
        self.assertEqual(DEPLOY.read_env(config)[1], "admin.example.cn")
        again = subprocess.run([node, HERE / "configure.mjs", "--domain", "admin.example.cn", "--output", config],
                               input=secrets.token_urlsafe(24), capture_output=True, text=True, check=False)
        self.assertNotEqual(again.returncode, 0)
        self.assertEqual(config.stat().st_mode & 0o777, 0o600)


class NginxTests(unittest.TestCase):
    def setUp(self):
        (ROOT / "var").mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix="nginx-tests-", dir=ROOT / "var")
        self.path = Path(self.temporary.name)
        self.nginx = self.path / "nginx"
        available = self.nginx / "sites-available"
        enabled = self.nginx / "sites-enabled"
        available.mkdir(parents=True)
        enabled.mkdir()
        self.config = self.nginx / "nginx.conf"
        self.config.write_text(f"events {{}}\nhttp {{ include {enabled}/*; }}\n")
        self.default = enabled / "default"
        self.default.write_text("server { listen 80 default_server; server_name netgen.cc; root /var/www/html; }\n")
        self.original = self.default.read_bytes()
        self.original_config = self.config.read_bytes()
        self.site = available / "pengmanager-system.conf"
        self.link = enabled / "pengmanager-system.conf"
        self.webroot = self.path / "acme"
        self.hook = self.path / "renewal-hooks/deploy/pengmanager-system-nginx.sh"
        self.cert = self.path / "lineage/fullchain.pem"
        self.key = self.cert.parent / "privkey.pem"
        self.domain = "pengmanager.netgen.cc"
        self.calls = []
        self.fail_certbot = False
        self.fail_test_once = False
        self.fail_reload_once = False
        self.invalid_certificate = False
        self.hostname_mismatch_output = False
        self.patches = mock.patch.multiple(NGINX, CONFIG=self.config, AVAILABLE=self.site, ENABLED=self.link,
                                          WEBROOT=self.webroot, HOOK=self.hook)
        self.patches.start()
        self.which = mock.patch.object(NGINX.shutil, "which", return_value="/usr/bin/certbot")
        self.which.start()

    def tearDown(self):
        self.which.stop()
        self.patches.stop()
        self.temporary.cleanup()

    def settings(self, managed=False):
        return {"schema": "pengmanager-proxy/v1", "proxy": "nginx", "domain": self.domain,
                "certificate": str(self.cert), "privateKey": str(self.key),
                "certName": f"pengmanager-system-{self.domain}", "managedCertificate": managed}

    def args(self, **overrides):
        values = dict(accept_acme_terms=False, acme_email=None, acme_no_email=False, acme_account=None)
        values.update(overrides)
        return SimpleNamespace(**values)

    def touch_certificate(self):
        self.cert.parent.mkdir(exist_ok=True)
        self.cert.touch()
        self.key.touch()

    def dump(self):
        values = [f"# configuration file {self.config}:\n{self.config.read_text()}"]
        values.extend(f"# configuration file {path}:\n{path.read_text()}" for path in sorted(self.link.parent.iterdir()))
        return "\n".join(values)

    def fake_run(self, argv, **kwargs):
        values = [str(value) for value in argv]
        self.calls.append(values)
        if "-T" in values:
            return self.dump()
        if "-t" in values and self.site.exists() and self.fail_test_once:
            self.fail_test_once = False
            raise DEPLOY.DeployError("candidate nginx validation failed")
        if values[:2] == ["systemctl", "reload"] and self.fail_reload_once:
            self.fail_reload_once = False
            raise DEPLOY.DeployError("candidate nginx reload failed")
        if values[0] == "certbot":
            if self.fail_certbot:
                raise DEPLOY.DeployError("certificate request failed")
            self.touch_certificate()
            self.invalid_certificate = False
        if values[0] == "openssl" and self.invalid_certificate:
            return None
        if values[0] == "openssl" and "-checkhost" in values:
            result = "does NOT match" if self.hostname_mismatch_output else "does match"
            return f"Hostname {self.domain} {result} certificate\n"
        return ""

    def proxy(self, managed=False, args=None):
        return NGINX.NginxProxy(self.settings(managed), self.fake_run, DEPLOY.require, args or self.args())

    def assert_old_site_untouched(self):
        self.assertEqual(self.default.read_bytes(), self.original)
        self.assertEqual(self.config.read_bytes(), self.original_config)
        self.assertFalse(any(call[:2] in (["systemctl", "stop"], ["systemctl", "restart"]) for call in self.calls))
        self.assertFalse(any("caddy" in value for call in self.calls for value in call))

    def test_existing_nginx_exact_wildcard_regex_and_included_names_refused(self):
        for name in (self.domain, self.domain.upper(), "*.netgen.cc", ".netgen.cc", "pengmanager.*",
                     r"~^pengmanager\.netgen\.cc$", r'"~^(?<name>.+)\.netgen\.cc$"', "$hostname"):
            with self.subTest(name=name):
                self.default.write_text(f"server {{ server_name {name}; }}\n")
                with self.assertRaises(DEPLOY.DeployError):
                    self.proxy().inspect()
                self.assertFalse(self.site.exists())
        snippet = self.nginx / "server-name.conf"
        snippet.write_text(f"server_name {self.domain};\n")
        self.default.write_text(f"server {{ include {snippet}; }}\n")
        dump = self.dump() + f"\n# configuration file {snippet}:\n{snippet.read_text()}"
        with self.assertRaisesRegex(DEPLOY.DeployError, "overlaps"):
            NGINX.inspect_dump(dump, self.domain, DEPLOY.require, self.config, self.site, self.link)

    def test_nginx_include_must_be_loaded_inside_http_and_match_real_path_segments(self):
        for content in (f"events {{}} stream {{ include {self.link.parent}/*; }}",
                        f"events {{}} http {{ include {self.nginx}/*.conf; }}"):
            self.config.write_text(content)
            with self.assertRaises(DEPLOY.DeployError):
                self.proxy().inspect()
        self.assertFalse(self.site.exists())

    def test_valid_supplied_certificate_preserves_root_and_old_site(self):
        self.touch_certificate()
        proxy = self.proxy()
        proxy.prepare()
        proxy.reload()
        content = self.site.read_text()
        self.assertIn(f"server_name {self.domain};", content)
        self.assertIn("proxy_set_header Host $host;", content)
        self.assertIn("proxy_set_header X-Forwarded-Proto $scheme;", content)
        self.assertIn(f"return 308 https://{self.domain}$request_uri;", content)
        self.assertEqual(self.link.resolve(), self.site)
        self.assertFalse(self.hook.exists())
        self.assertFalse(any(call[0] == "certbot" for call in self.calls))
        self.assertTrue(any("-checkhost" in call and self.domain in call for call in self.calls))
        self.assertTrue(any("-checkend" in call and "86400" in call for call in self.calls))
        self.assert_old_site_untouched()

    def test_new_acme_registration_requires_action_time_acceptance_before_site_write(self):
        for args in (self.args(), self.args(accept_acme_terms=True), self.args(acme_no_email=True),
                     self.args(acme_email="operator@example.com")):
            with self.subTest(args=args):
                proxy = self.proxy(True, args)
                with self.assertRaisesRegex(DEPLOY.DeployError, "explicit --accept-acme-terms"):
                    proxy.prepare()
                proxy.restore()
                self.assertFalse(self.site.exists())
                self.assertFalse(self.link.is_symlink())
        self.assertFalse(any(call[0] == "certbot" for call in self.calls))
        self.assert_old_site_untouched()

    def test_existing_acme_account_uses_webroot_without_new_terms_and_scopes_hook(self):
        proxy = self.proxy(True, self.args(acme_account="a" * 32))
        proxy.prepare()
        proxy.reload()
        command = next(call for call in self.calls if call[0] == "certbot")
        self.assertIn("--webroot", command)
        self.assertIn("--account", command)
        self.assertNotIn("--agree-tos", command)
        self.assertNotIn("--nginx", command)
        self.assertNotIn("--standalone", command)
        self.assertIn(str(self.webroot), command)
        hook = self.hook.read_text()
        self.assertIn('case "${RENEWED_LINEAGE:-}"', hook)
        self.assertIn(str(self.cert.parent), hook)
        self.assertIn("systemctl reload nginx.service", hook)
        self.assertEqual(self.hook.stat().st_mode & 0o777, 0o755)
        self.assert_old_site_untouched()

    def test_explicit_acme_no_email_acceptance_is_forwarded_only_when_requested(self):
        proxy = self.proxy(True, self.args(accept_acme_terms=True, acme_no_email=True))
        command = [str(value) for value in proxy.certbot_arguments()]
        self.assertIn("--agree-tos", command)
        self.assertIn("--register-unsafely-without-email", command)
        self.assertNotIn("--email", command)

    def test_expiring_managed_certificate_is_renewed_with_its_existing_account(self):
        self.touch_certificate()
        self.invalid_certificate = True
        proxy = self.proxy(True)
        proxy.prepare()
        command = next(call for call in self.calls if call[0] == "certbot")
        self.assertIn("--keep-until-expiring", command)
        self.assertNotIn("--agree-tos", command)
        self.assertFalse(self.invalid_certificate)
        self.assertIn("listen 443 ssl", self.site.read_text())
        self.assert_old_site_untouched()

    def test_invalid_supplied_certificate_is_rejected_without_site_mutation(self):
        self.touch_certificate()
        self.invalid_certificate = True
        proxy = self.proxy(False)
        with self.assertRaisesRegex(DEPLOY.DeployError, "Supplied TLS"):
            proxy.prepare()
        proxy.restore()
        self.assertFalse(self.site.exists())
        self.assertFalse(any(call[0] == "certbot" for call in self.calls))
        self.assert_old_site_untouched()

    def test_openssl_zero_exit_with_hostname_mismatch_output_is_rejected(self):
        self.touch_certificate()
        self.hostname_mismatch_output = True
        proxy = self.proxy(False)
        self.assertFalse(proxy.certificate_valid())
        with self.assertRaisesRegex(DEPLOY.DeployError, "Supplied TLS"):
            proxy.prepare()
        proxy.restore()
        self.assertFalse(self.site.exists())
        self.assert_old_site_untouched()

    def test_real_openssl3_generated_certificate_host_match_and_mismatch(self):
        binary = os.environ.get("OPENSSL_BINARY", "/usr/bin/openssl")
        try:
            version = subprocess.run([binary, "version"], capture_output=True, text=True, check=False)
        except FileNotFoundError:
            self.skipTest("Real certificate regression requires an OpenSSL 3 binary; set OPENSSL_BINARY on Linux/CI.")
        if version.returncode or not version.stdout.startswith("OpenSSL 3."):
            self.skipTest("System binary is not OpenSSL 3; run this regression on Linux/CI or set OPENSSL_BINARY.")
        # Keys exist only in an OS temporary directory, never source/fixtures or
        # emitted output. TemporaryDirectory removes them after the assertion.
        with tempfile.TemporaryDirectory(prefix="pengmanager-openssl-check-") as directory:
            certificate, key = Path(directory) / "certificate.pem", Path(directory) / "private.key"
            settings = {**self.settings(False), "certificate": str(certificate), "privateKey": str(key)}
            proxy = NGINX.NginxProxy(settings, DEPLOY.run, DEPLOY.require)
            for host in ("different.example.com", self.domain):
                generated = subprocess.run([binary, "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                                            "-keyout", key, "-out", certificate, "-days", "2",
                                            "-subj", f"/CN={host}", "-addext", f"subjectAltName=DNS:{host}"],
                                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
                self.assertEqual(generated.returncode, 0, "OpenSSL fixture generation failed; output withheld.")
                key.chmod(0o600)
                with mock.patch.object(NGINX, "OPENSSL", binary):
                    result = proxy.certificate_valid()
                self.assertEqual(result, host == self.domain)

    def test_certbot_or_candidate_validation_failure_restores_only_own_paths(self):
        for failure in ("certbot", "validation"):
            with self.subTest(failure=failure):
                proxy = self.proxy(True, self.args(acme_account="a" * 32))
                self.fail_certbot = failure == "certbot"
                self.fail_test_once = failure == "validation"
                with self.assertRaises(DEPLOY.DeployError):
                    proxy.prepare()
                proxy.restore()
                self.assertFalse(self.site.exists())
                self.assertFalse(self.link.is_symlink())
                self.assertFalse(self.hook.exists())
                self.assert_old_site_untouched()

    def test_reload_failure_restores_prior_managed_site_link_and_hook(self):
        self.touch_certificate()
        proxy = self.proxy(True)
        self.site.write_text(proxy.site_text(True) + "# prior release\n")
        self.link.symlink_to(self.site)
        self.hook.parent.mkdir(parents=True)
        self.hook.write_text(f"#!/bin/sh\n{NGINX.MARKER}\n# prior hook\n")
        before_site, before_hook = self.site.read_bytes(), self.hook.read_bytes()
        proxy.prepare()
        self.fail_reload_once = True
        with self.assertRaisesRegex(DEPLOY.DeployError, "reload failed"):
            proxy.reload()
        proxy.restore()
        self.assertEqual(self.site.read_bytes(), before_site)
        self.assertEqual(self.hook.read_bytes(), before_hook)
        self.assertEqual(self.link.resolve(), self.site)
        self.assert_old_site_untouched()

    def test_unmanaged_or_dangling_site_links_cannot_be_overwritten(self):
        outside = self.path / "outside"
        self.site.symlink_to(outside)
        with self.assertRaisesRegex(DEPLOY.DeployError, "symlink"):
            self.proxy().inspect()
        self.site.unlink()
        self.link.symlink_to(outside)
        with self.assertRaisesRegex(DEPLOY.DeployError, "outside"):
            self.proxy().inspect()
        self.assertFalse(outside.exists())

    def test_renewal_hook_parent_symlink_is_rejected_before_site_changes(self):
        self.touch_certificate()
        outside = self.path / "outside-hooks"
        outside.mkdir()
        self.hook.parent.parent.symlink_to(outside)
        proxy = self.proxy(True)
        with self.assertRaisesRegex(DEPLOY.DeployError, "Renewal hook directories"):
            proxy.prepare()
        proxy.restore()
        self.assertFalse(self.site.exists())
        self.assertEqual(list(outside.iterdir()), [])
        self.assert_old_site_untouched()

    def test_proxy_selection_is_private_persistent_and_cannot_silently_switch(self):
        config = self.path / "private-config"
        config.mkdir(mode=0o700)
        install = SimpleNamespace(command="install", proxy="nginx", tls_cert=None, tls_key=None)
        update = SimpleNamespace(command="update", proxy=None, tls_cert=None, tls_key=None)
        with mock.patch.object(DEPLOY, "CONFIG", config):
            settings = DEPLOY.proxy_settings(install, self.domain)
            DEPLOY.save_proxy_settings(settings)
            self.assertEqual((config / "proxy.json").stat().st_mode & 0o777, 0o600)
            self.assertEqual(DEPLOY.proxy_settings(update, self.domain), settings)
            update.proxy = "caddy"
            with self.assertRaisesRegex(DEPLOY.DeployError, "migration"):
                DEPLOY.proxy_settings(update, self.domain)
            update.proxy = None
            (config / "proxy.json").write_text(json.dumps({**settings, "unexpected": "refuse"}))
            with self.assertRaisesRegex(DEPLOY.DeployError, "unknown"):
                DEPLOY.proxy_settings(update, self.domain)
            (config / "proxy.json").unlink()
            (config / "proxy.json").symlink_to(self.path / "not-created")
            with self.assertRaisesRegex(DEPLOY.DeployError, "symlink"):
                DEPLOY.proxy_settings(update, self.domain)


if __name__ == "__main__":
    unittest.main(verbosity=2)
