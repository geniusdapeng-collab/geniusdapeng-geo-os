"""Reuse one existing nginx installation; never rewrite its root or other vhosts."""
import fnmatch
import os
from pathlib import Path
import re
import shlex
import shutil

MARKER = "# Managed by PengManager deployment v1"
BINARY = Path("/usr/sbin/nginx")
CONFIG = Path("/etc/nginx/nginx.conf")
AVAILABLE = Path("/etc/nginx/sites-available/pengmanager-system.conf")
ENABLED = Path("/etc/nginx/sites-enabled/pengmanager-system.conf")
WEBROOT = Path("/var/lib/pengmanager-system-acme")
HOOK = Path("/etc/letsencrypt/renewal-hooks/deploy/pengmanager-system-nginx.sh")
UNIT = "nginx.service"
OPENSSL = "openssl"


def path_argument(value, require):
    path = Path(value)
    require(path.is_absolute() and re.fullmatch(r"/[A-Za-z0-9_./-]+", str(path)) and ".." not in path.parts,
            "Certificate paths must be absolute paths without nginx/shell metacharacters.")
    return path


def parse_directives(text, require):
    # shlex's default escaping would remove PCRE backslashes. nginx treats a
    # backslash before a dot as part of the regular expression, so preserve it.
    lexer = shlex.shlex(text, posix=True, punctuation_chars="{};")
    lexer.whitespace_split = True
    lexer.escape = ""
    lexer.commenters = "#"
    try:
        raw = list(lexer)
    except ValueError:
        require(False, "Existing nginx configuration could not be parsed safely; no files changed.")
    tokens = []
    for token in raw:
        if token and all(character in "{};" for character in token):
            tokens.extend(token)
        else:
            tokens.append(token)
    cursor = 0
    def block(nested=False):
        nonlocal cursor
        nodes = []
        while cursor < len(tokens):
            if tokens[cursor] == "}":
                require(nested, "Unexpected nginx closing brace; no files changed.")
                cursor += 1
                return nodes
            words = []
            while cursor < len(tokens) and tokens[cursor] not in (";", "{", "}"):
                words.append(tokens[cursor])
                cursor += 1
            require(words and cursor < len(tokens) and tokens[cursor] != "}",
                    "Unsupported nginx directive syntax; no files changed.")
            delimiter = tokens[cursor]
            cursor += 1
            nodes.append((words, block(True) if delimiter == "{" else None))
        require(not nested, "Unclosed nginx block; no files changed.")
        return nodes
    return block()


def name_matches(name, domain, require):
    if name.startswith("~"):
        # PCRE has constructs Python cannot evaluate. Refuse those configurations
        # instead of guessing that their names cannot overlap the new domain.
        require(False, "An existing nginx PCRE server_name needs manual overlap review; no files changed.")
    name = name.rstrip(".").lower()
    require("$" not in name, "A dynamic nginx server_name needs manual overlap review; no files changed.")
    return (name == domain or
            (name.startswith("*.") and domain.endswith(name[1:])) or
            (name.startswith(".") and (domain == name[1:] or domain.endswith(name))) or
            (name.endswith(".*") and domain.startswith(name[:-1])))


def inspect_dump(dump, domain, require, config=CONFIG, available=AVAILABLE, enabled=ENABLED, managed=False):
    """Walk includes in their actual context, not every file printed by -T blindly."""
    headers = list(re.finditer(r"(?m)^# configuration file ([^\n]+):\n", dump))
    require(headers, "nginx -T did not return identifiable configuration sections.")
    sections = {}
    for index, header in enumerate(headers):
        path = Path(header.group(1))
        require(path not in sections, "nginx -T contains duplicate configuration sections.")
        end = headers[index + 1].start() if index + 1 < len(headers) else len(dump)
        sections[path] = parse_directives(dump[header.end():end], require)
    require(config in sections, "nginx -T does not use the expected /etc/nginx/nginx.conf.")
    loaded_include = False
    own_loaded = False
    def matches(path, pattern):
        parts, patterns = Path(path).parts, Path(pattern).parts
        return len(parts) == len(patterns) and all(fnmatch.fnmatchcase(part, value) for part, value in zip(parts, patterns))
    def walk(nodes, context, source, stack):
        nonlocal loaded_include, own_loaded
        for words, children in nodes:
            directive = words[0]
            if directive == "include":
                require(len(words) == 2, "Unsupported nginx include directive.")
                pattern = words[1]
                if not pattern.startswith("/"):
                    pattern = str(config.parent / pattern)
                if context == ("http",) and matches(enabled, pattern):
                    loaded_include = True
                for target in sections:
                    if matches(target, pattern):
                        require(target not in stack, "Recursive nginx include needs manual review.")
                        walk(sections[target], context, target, (*stack, target))
            elif directive == "server" and context == ("http",) and children is not None:
                if source in (available, enabled):
                    require(managed, "An unmanaged PengManager nginx site is already loaded.")
                    own_loaded = True
                else:
                    walk(children, (*context, directive), source, stack)
            elif directive == "server_name" and context == ("http", "server"):
                values = words[1:]
                for index, name in enumerate(values):
                    if name in ("~", "~*"):
                        require(index + 1 < len(values), "Unsupported nginx regex server_name.")
                        name += values[index + 1]
                    elif index and values[index - 1] in ("~", "~*"):
                        continue
                    require(not name_matches(name, domain, require),
                            "Requested domain overlaps an existing nginx server_name; no existing site will be replaced.")
            elif children is not None:
                walk(children, (*context, directive), source, stack)
    walk(sections[config], (), config, (config,))
    require(loaded_include, "Existing nginx must already include sites-enabled in its http block; nginx.conf will not be edited.")
    if managed and enabled.exists():
        require(own_loaded, "Managed nginx site is not loaded by the active configuration.")


class NginxProxy:
    def __init__(self, settings, run, require, args=None):
        self.settings = settings
        self.run = run
        self.require = require
        self.args = args
        self.domain = settings["domain"]
        self.saved = None
        self.touched = False
        self.cert = path_argument(settings["certificate"], require)
        self.key = path_argument(settings["privateKey"], require)

    def command(self, flag):
        return [BINARY, flag, "-c", CONFIG]

    def validate(self):
        self.run(self.command("-t"), capture=False)

    def reload(self):
        self.validate()
        self.run(["systemctl", "reload", UNIT], capture=False)

    def inspect(self):
        for directory in (CONFIG.parent, AVAILABLE.parent, ENABLED.parent):
            self.require(directory.is_dir() and not any(path.is_symlink() for path in [directory, *directory.parents]),
                         "nginx configuration directories must already exist without symlink ancestors.")
        self.require(CONFIG.is_file() and not CONFIG.is_symlink(), "nginx root configuration must be a regular file.")
        self.require(not AVAILABLE.is_symlink() and (not AVAILABLE.exists() or AVAILABLE.is_file()),
                     "Managed nginx site must be a regular file, never a symlink.")
        managed = AVAILABLE.exists()
        if managed:
            self.require(AVAILABLE.read_text().startswith(f"{MARKER}\n# domain: {self.domain}\n"),
                         "Managed nginx site is unmanaged or belongs to another domain.")
        self.require(not ENABLED.exists() or ENABLED.is_symlink(), "Enabled nginx site must be the managed symlink.")
        if ENABLED.is_symlink():
            self.require(ENABLED.resolve() == AVAILABLE and managed, "Enabled nginx site points outside the managed site.")
        self.validate()
        inspect_dump(self.run(self.command("-T")), self.domain, self.require,
                     CONFIG, AVAILABLE, ENABLED, managed)

    def certificate_valid(self):
        if not self.cert.is_file() or not self.key.is_file():
            return False
        # OpenSSL 3's -checkhost may exit zero even on a mismatch. Compare its
        # explicit result; -noout prevents certificate material entering output.
        host = self.run([OPENSSL, "x509", "-in", self.cert, "-noout", "-checkhost", self.domain], allow_failure=True)
        expiry = self.run([OPENSSL, "x509", "-in", self.cert, "-noout", "-checkend", "86400"], capture=False, allow_failure=True)
        return host is not None and host.strip() == f"Hostname {self.domain} does match certificate" and expiry is not None

    def certbot_arguments(self):
        values = ["certbot", "certonly", "--non-interactive", "--webroot", "--webroot-path", WEBROOT,
                  "--preferred-challenges", "http", "--cert-name", self.settings["certName"],
                  "--domain", self.domain, "--keep-until-expiring", "--no-eff-email"]
        account = getattr(self.args, "acme_account", None)
        if account:
            self.require(re.fullmatch(r"[a-fA-F0-9]{32}", account), "ACME account identifier must be 32 hexadecimal characters.")
            values.extend(["--account", account])
        elif not self.cert.exists():
            # Existing lineages record their own account; non-interactive mode
            # fails safely if Certbot needs a new agreement or registration.
            accepted = getattr(self.args, "accept_acme_terms", False)
            email = getattr(self.args, "acme_email", None)
            no_email = getattr(self.args, "acme_no_email", False)
            self.require(accepted and bool(email) != bool(no_email),
                         "New ACME registration requires explicit --accept-acme-terms plus --acme-email or --acme-no-email at action time.")
            values.append("--agree-tos")
            if email:
                self.require(len(email) <= 254 and re.fullmatch(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", email),
                             "ACME contact email format is unsupported; value withheld.")
                values.extend(["--email", email])
            else:
                values.append("--register-unsafely-without-email")
        return values

    def site_text(self, tls):
        http_action = f"return 308 https://{self.domain}$request_uri;" if tls else "return 503;"
        text = f"""{MARKER}
# domain: {self.domain}
server {{
    listen 80;
    listen [::]:80;
    server_name {self.domain};
    location ^~ /.well-known/acme-challenge/ {{
        root {WEBROOT};
        default_type text/plain;
        try_files $uri =404;
    }}
    location / {{ {http_action} }}
}}
"""
        if tls:
            text += f"""server {{
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name {self.domain};
    ssl_certificate {self.cert};
    ssl_certificate_key {self.key};
    ssl_protocols TLSv1.2 TLSv1.3;
    add_header Strict-Transport-Security "max-age=31536000" always;
    client_max_body_size 50m;
    client_body_timeout 120s;
    location / {{
        proxy_pass http://127.0.0.1:4318;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Connection "";
        proxy_read_timeout 60s;
        proxy_send_timeout 120s;
    }}
}}
"""
        return text

    def write_site(self, tls):
        self.touched = True
        AVAILABLE.write_text(self.site_text(tls))
        AVAILABLE.chmod(0o644)
        if not ENABLED.is_symlink():
            ENABLED.symlink_to(AVAILABLE)
        self.validate()

    def hook_text(self):
        return f"""#!/bin/sh
{MARKER}
set -eu
case "${{RENEWED_LINEAGE:-}}" in
    {self.cert.parent})
        {BINARY} -t -c {CONFIG}
        /usr/bin/systemctl reload {UNIT}
        ;;
esac
"""

    def prepare(self):
        self.inspect()
        self.require(not any(path.is_symlink() for path in [HOOK.parent, *HOOK.parent.parents]), "Renewal hook directories must have no symlink ancestors.")
        self.require(not HOOK.is_symlink() and (not HOOK.exists() or HOOK.is_file()), "Managed nginx renewal hook must be a regular file.")
        if HOOK.exists():
            self.require(MARKER in HOOK.read_text(), "An unmanaged nginx renewal hook already exists; it will not be overwritten.")
        self.saved = (AVAILABLE.read_bytes() if AVAILABLE.exists() else None,
                      os.readlink(ENABLED) if ENABLED.is_symlink() else None,
                      HOOK.read_bytes() if HOOK.exists() else None)
        valid = self.certificate_valid()
        arguments = None
        if not valid:
            self.require(self.settings["managedCertificate"], "Supplied TLS certificate/key are missing, invalid or expire within 24 hours.")
            arguments = self.certbot_arguments()  # Agreement guard runs before any site mutation.
            self.require(shutil.which("certbot"), "certbot must be installed explicitly before requesting a new certificate.")
        if self.settings["managedCertificate"]:
            self.require(not any(path.is_symlink() for path in [WEBROOT, *WEBROOT.parents]), "ACME webroot must have no symlink ancestors.")
            WEBROOT.mkdir(mode=0o755, parents=True, exist_ok=True)
            WEBROOT.chmod(0o755)
        if arguments:
            self.write_site(False)
            self.reload()
            self.run(arguments, capture=False)
            self.require(self.certificate_valid(), "Certbot did not produce the required domain certificate and key.")
        self.write_site(True)
        if self.settings["managedCertificate"]:
            HOOK.parent.mkdir(parents=True, exist_ok=True)
            HOOK.write_text(self.hook_text())
            HOOK.chmod(0o755)

    def restore(self):
        if self.saved is None or not self.touched:
            return
        site, link, hook = self.saved
        if site is None:
            AVAILABLE.unlink(missing_ok=True)
        else:
            AVAILABLE.write_bytes(site)
            AVAILABLE.chmod(0o644)
        ENABLED.unlink(missing_ok=True)
        if link is not None:
            ENABLED.symlink_to(link)
        if hook is None:
            HOOK.unlink(missing_ok=True)
        else:
            HOOK.write_bytes(hook)
            HOOK.chmod(0o755)
        self.reload()
