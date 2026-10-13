#!/usr/bin/env python3
"""Check real HTTP, PostgreSQL persistence, and expired-lease recovery."""
import json
import os
from pathlib import Path
import shutil
import re
import signal
import socket
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
import uuid

root = Path(__file__).resolve().parents[1]
admin_url = os.environ.get("TEST_POSTGRES_URL")
if not admin_url or urllib.parse.urlsplit(admin_url).scheme not in ("postgres", "postgresql"):
    raise SystemExit("Set TEST_POSTGRES_URL to PostgreSQL with CREATEDB privileges")
if shutil.which("psql"):
    psql = ["psql", "--dbname", admin_url]
else:
    parsed = urllib.parse.urlsplit(admin_url)
    if parsed.hostname not in ("127.0.0.1", "localhost"):
        raise SystemExit("Install psql for a non-local TEST_POSTGRES_URL")
    container_url = urllib.parse.urlunsplit(parsed._replace(netloc=f"{parsed.username}:{parsed.password}@127.0.0.1:5432"))
    psql = ["docker", "compose", "exec", "-T", "postgres", "psql", "--dbname", container_url]


def sql(statement, database=None):
    command = psql.copy()
    if database:
        parsed = urllib.parse.urlsplit(command[-1])
        command[-1] = urllib.parse.urlunsplit(parsed._replace(path=f"/{database}"))
    return subprocess.check_output(command + ["-v", "ON_ERROR_STOP=1", "-Atc", statement], cwd=root, text=True).strip()


database = "blackwall_smoke_" + uuid.uuid4().hex
sql(f"CREATE DATABASE {database}")
try:
    with tempfile.TemporaryDirectory(prefix="blackwall-smoke-") as temporary:
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        base = f"http://127.0.0.1:{port}"
        parsed = urllib.parse.urlsplit(admin_url)
        environment = os.environ.copy()
        environment.pop("DEV_MAIL_DIR", None)
        environment.pop("SMTP_URL", None)
        environment.update(DATABASE_URL=urllib.parse.urlunsplit(parsed._replace(path=f"/{database}")), BIND_ADDR=f"127.0.0.1:{port}", WEB_DIR=str(root / "web/build/client"))
        binary = str(root / "target/debug/blackwall")
        process = None
        worker = None
        token = None
        with open(f"{temporary}/server.log", "w+") as log:
            def request(method, path, data=None):
                headers = {}
                if token:
                    headers["Authorization"] = f"Bearer {token}"
                if data is not None:
                    headers["Content-Type"] = "application/json"
                req = urllib.request.Request(base + path, data=None if data is None else json.dumps(data).encode(), headers=headers, method=method)
                with urllib.request.urlopen(req, timeout=10) as response:
                    body = response.read()
                    return json.loads(body) if body and response.headers.get_content_type() == "application/json" else body

            def start():
                global process, worker
                process = subprocess.Popen([binary], cwd=temporary, env=environment, stdout=log, stderr=log)
                worker = subprocess.Popen([binary, "worker"], cwd=temporary, env=environment, stdout=log, stderr=log)
                for _ in range(100):
                    if process.poll() is not None or worker.poll() is not None:
                        log.seek(0)
                        raise RuntimeError(log.read())
                    try:
                        assert request("GET", "/health")["status"] == "ok"
                        return
                    except OSError:
                        time.sleep(0.1)
                raise RuntimeError("server did not start")

            def stop():
                global process, worker
                procs = [proc for proc in (process, worker) if proc is not None]
                for proc in procs:
                    try:
                        proc.send_signal(signal.SIGINT)
                    except Exception:
                        pass
                first = None
                for proc in procs:
                    try:
                        try:
                            proc.wait(timeout=40)
                        except subprocess.TimeoutExpired:
                            proc.kill()
                            proc.wait()
                            raise
                        assert proc.returncode == 0
                    except Exception as error:
                        if first is None:
                            first = error
                process = None
                worker = None
                if first is not None:
                    raise first

            try:
                for _ in range(2):
                    subprocess.run([binary, "migrate"], cwd=temporary, env=environment, stdout=log, stderr=log, check=True)
                start()
                session = request("POST", "/internal-api/auth/register", {"email": "owner@example.com", "password": "smoke-password-123", "display_name": "Owner"})
                token = session["token"]
                workspace = request("POST", "/internal-api/workspaces", {"name": "HTTP smoke", "slug": "http-smoke"})
                workspace_id = workspace["workspace"]["id"]
                path = f"/internal-api/workspaces/{workspace_id}"

                def command(value, expected=None, key=None):
                    payload = {"expected_versions": expected or {}, "command": value}
                    if key:
                        payload["idempotency_key"] = key
                    return request("POST", path + "/commands", payload)

                team = command({"type": "create_team", "name": "Operations", "key": "OPS", "members": []})["result"]["id"]
                creation = {"type": "create_issue", "input": {"team_id": team, "title": "Verify actual HTTP", "assignee": session["profile"]["id"]}}
                created = command(creation, key="smoke-create")
                assert command(creation, key="smoke-create") == created
                issue = created["result"]["id"]
                invitation = command({"type": "invite", "email": "colleague@example.com", "role": "member", "token_hash": "server-generated"})["result"]["id"]
                cancelled = command({"type": "invite", "email": "cancelled@example.com", "role": "member", "token_hash": "server-generated"})
                cancelled_id = cancelled["result"]["id"]
                command({"type": "cancel_invitation", "id": cancelled_id}, {cancelled_id: cancelled["versions"][cancelled_id]})
                stop()
                # Model a worker crash after claiming but before delivering the invitation.
                assert sql(f"SELECT count(*) FROM jobs WHERE kind='email' AND payload->>'to'='colleague@example.com' AND state='pending'", database) == "1"
                sql("UPDATE jobs SET state='running',attempts=1,claim_token=gen_random_uuid(),lease_expires_at=clock_timestamp()-interval '1 second' WHERE kind='email' AND payload->>'to'='colleague@example.com'", database)
                environment["DEV_MAIL_DIR"] = f"{temporary}/mail"
                start()
                persisted = request("GET", path + f"/issues/{issue}")
                assert persisted["id"] == issue and persisted["version"] >= 1
                page = request("GET", path + "/issues?limit=1&offset=0")
                assert len(page["items"]) == 1 and not page["has_more"]
                for _ in range(100):
                    spooled = {json.loads(file.read_text())["to"]: file for file in Path(temporary, "mail").glob("*.json")}
                    if "colleague@example.com" in spooled:
                        break
                    time.sleep(0.1)
                file = spooled["colleague@example.com"]
                mail = json.loads(file.read_text())
                assert mail["invitation_id"] == invitation
                assert file.stat().st_mode & 0o777 == 0o600
                assert sql("SELECT attempts FROM jobs WHERE kind='email' AND payload->>'to'='colleague@example.com'", database) == "2"
                for _ in range(100):
                    cancelled_state = sql("SELECT state FROM jobs WHERE kind='email' AND payload->>'to'='cancelled@example.com'", database)
                    if cancelled_state in ("cancelled", "succeeded"):
                        break
                    time.sleep(0.1)
                assert cancelled_state in ("cancelled", "succeeded")
                assert "cancelled@example.com" not in spooled
                colleague = request("POST", "/internal-api/auth/register", {"email": "colleague@example.com", "password": "smoke-password-456", "display_name": "Colleague"})
                token = colleague["token"]
                joined = request("POST", path + "/invitations/accept", {"token": mail["token"]})
                assert joined["workspace"]["id"] == workspace_id
                assert len(request("GET", path + "/members")) == 2
                assert request("GET", "/internal-api/workspaces")[0]["id"] == workspace_id
                shell = request("GET", "/login")
                assert b"<!DOCTYPE html>" in shell and b"/assets/" in shell
                assets = re.findall(rb"(?:src|href)=[\"'](/assets/[^\"']+\.js)[\"']", shell)
                assert assets
                assert len(request("GET", assets[0].decode())) > 100
                assert request("GET", "/internal-api/schema.json")["components"]["schemas"]["Command"]
                print("PASS: PostgreSQL migrations, real HTTP, idempotency, restart, expired-lease recovery, invitation delivery and acceptance, HTML, assets, OpenAPI")
            except Exception:
                log.flush()
                log.seek(0)
                print(log.read())
                raise
            finally:
                stop()
finally:
    sql(f"DROP DATABASE {database} WITH (FORCE)")
