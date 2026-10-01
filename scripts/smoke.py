#!/usr/bin/env python3
"""Run a real server and check HTTP, durable storage, and mail delivery without a browser."""
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import time
import urllib.request

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="blackwall-smoke-") as temporary:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    environment = os.environ.copy()
    environment.update(DATABASE_URL=f"sqlite://{temporary}/work.db?mode=rwc", BIND_ADDR=f"127.0.0.1:{port}", DEV_MAIL_DIR=f"{temporary}/mail")
    process = None
    token = None
    log = open(f"{temporary}/server.log", "w+")

    def request(method, path, data=None):
        headers = {}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        if data is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(base + path, data=None if data is None else json.dumps(data).encode(), headers=headers, method=method)
        with urllib.request.urlopen(request, timeout=10) as response:
            body = response.read()
            return json.loads(body) if body and response.headers.get_content_type() == "application/json" else body

    def start():
        global process
        process = subprocess.Popen([str(root / "target/debug/blackwall")], cwd=root, env=environment, stdout=log, stderr=log)
        for _ in range(100):
            if process.poll() is not None:
                log.seek(0)
                raise RuntimeError(log.read())
            try:
                assert request("GET", "/health")["status"] == "ok"
                return
            except OSError:
                time.sleep(0.1)
        raise RuntimeError("server did not start")

    def stop():
        global process
        if process is not None:
            process.send_signal(signal.SIGINT)
            process.wait(timeout=10)
            assert process.returncode == 0
            process = None

    try:
        start()
        session = request("POST", "/api/auth/register", {"email": "owner@example.com", "password": "smoke-password-123", "display_name": "Owner"})
        token = session["token"]
        workspace = request("POST", "/api/workspaces", {"name": "HTTP smoke"})
        workspace_id = workspace["workspace"]["id"]
        path = f"/api/workspaces/{workspace_id}"

        def command(command):
            revision = request("GET", path)["revision"]
            return request("POST", path + "/commands", {"revision": revision, "command": command})

        team = command({"type": "create_team", "name": "Operations", "members": []})["result"]["id"]
        issue = command({"type": "create_issue", "input": {"team_id": team, "title": "Verify actual HTTP", "assignee": session["profile"]["id"]}})["result"]["id"]
        invitation = command({"type": "invite", "email": "colleague@example.com", "role": "member", "token_hash": "server-generated"})["result"]["id"]
        cancelled = command({"type": "invite", "email": "cancelled@example.com", "role": "member", "token_hash": "server-generated"})["result"]["id"]
        command({"type": "cancel_invitation", "id": cancelled})
        stop()
        start()
        persisted = request("GET", path)
        assert persisted["workspace"]["issues"][0]["id"] == issue
        for _ in range(100):
            files = list(Path(temporary, "mail").glob("*.json"))
            if files:
                break
            time.sleep(0.1)
        assert len(files) == 1, "only the active invitation should deliver"
        mail = json.loads(files[0].read_text())
        assert mail["to"] == "colleague@example.com"
        assert mail["invitation_id"] == invitation
        assert files[0].stat().st_mode & 0o777 == 0o600
        colleague = request("POST", "/api/auth/register", {"email": "colleague@example.com", "password": "smoke-password-456", "display_name": "Colleague"})
        token = colleague["token"]
        joined = request("POST", path + "/invitations/accept", {"token": mail["token"]})
        assert len(joined["workspace"]["members"]) == 2
        assert request("GET", "/api/workspaces")[0]["id"] == workspace_id
        shell = request("GET", "/login")
        assert b"<!DOCTYPE html>" in shell and b"/assets/" in shell
        assert request("GET", "/api/schema.json")["components"]["schemas"]["Command"]
        print("PASS: real HTTP, restart persistence, invitation delivery/cancellation/acceptance, HTML, assets, OpenAPI")
    finally:
        stop()
        log.close()
