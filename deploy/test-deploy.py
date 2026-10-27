#!/usr/bin/env python3
"""Run blackwall-deploy against a scratch root with systemctl, curl and runuser stubbed."""
from pathlib import Path
import os
import subprocess
import tarfile
import tempfile

script = (Path(__file__).resolve().parent / "blackwall-deploy").read_text()
old, new = "a" * 40, "b" * 40

stubs = {
    "runuser": 'shift 3\nexec "$@"',
    "systemctl": """release=$(basename "$(readlink -f "$DEPLOY_ROOT/current")")
echo "systemctl $1 $release" >> "$DEPLOY_LOG"
case "$1 $RESTART_FAILS" in "restart "*"$release"*) exit 17 ;; esac""",
    "curl": """release=$(basename "$(readlink -f "$DEPLOY_ROOT/current")")
echo "curl $release" >> "$DEPLOY_LOG"
case "$UNHEALTHY" in *"$release"*) exit 22 ;; esac""",
    "journalctl": "exit 0",
    "sleep": "exit 0",
}


def release_files(release):
    (release / "web").mkdir(parents=True)
    (release / "web/index.html").write_text("ok")
    (release / "blackwall").write_text("#!/bin/sh\n")
    (release / "blackwall").chmod(0o755)


def deploy(work, *, previous=old, unhealthy=(), restart_fails=(), archive=None):
    root = work / "opt"
    bins = work / "bin"
    bins.mkdir()
    for name, body in stubs.items():
        (bins / name).write_text(f"#!/bin/sh\n{body}\n")
        (bins / name).chmod(0o755)
    release_files(root / "releases" / old)
    tarball = work / "release.tar.gz"
    if archive:
        staging = work / "staging"
        release_files(staging)
        outside = work / "outside"
        outside.write_text(f'#!/bin/sh\necho "outside ran" >> "{work / "calls.log"}"\n')
        outside.chmod(0o755)
        archive(staging, outside)
        with tarfile.open(tarball, "w:gz") as tar:
            for entry in sorted(staging.iterdir()):
                tar.add(entry, entry.name)
    else:
        release_files(root / "releases" / new)
    if previous:
        (root / "current").symlink_to(root / "releases" / previous)
    env_file = work / "blackwall.env"
    env_file.write_text("BIND_ADDR=127.0.0.1:3999\n")
    patched = script.replace("root=/opt/blackwall\n", f"root={root}\n").replace(
        "env_file=/etc/blackwall/blackwall.env\n", f"env_file={env_file}\n"
    )
    assert str(root) in patched and str(env_file) in patched, "deploy paths not patched"
    (work / "deploy").write_text(patched)
    log = work / "calls.log"
    log.touch()
    result = subprocess.run(
        ["bash", work / "deploy", tarball, new],
        env=dict(
            os.environ,
            PATH=f"{bins}:{os.environ['PATH']}",
            DEPLOY_ROOT=str(root),
            DEPLOY_LOG=str(log),
            UNHEALTHY=" ".join(unhealthy),
            RESTART_FAILS=" ".join(restart_fails),
        ),
        capture_output=True,
        text=True,
    )
    current = root / "current"
    return {
        "code": result.returncode,
        "current": current.resolve().name if current.is_symlink() else None,
        "installed": (root / "releases" / new).exists(),
        "output": result.stdout + result.stderr,
        "calls": log.read_text().splitlines(),
    }


failures = []


def case(name, check, **kwargs):
    with tempfile.TemporaryDirectory() as work:
        outcome = deploy(Path(work), **kwargs)
    try:
        check(outcome)
        print(f"ok {name}")
    except AssertionError as error:
        failures.append(name)
        print(f"FAIL {name}: {error}\nexit {outcome['code']}, current {outcome['current']}")
        print(outcome["output"] + "\n".join(outcome["calls"]))


def healthy_deploy(o):
    assert o["code"] == 0 and o["current"] == new
    assert f"deployed {new}" in o["output"]


def rollback_after_failed_restart(o):
    assert o["code"] == 1 and o["current"] == old
    assert f"systemctl restart {old}" in o["calls"] and f"curl {old}" in o["calls"]
    assert f"rolled back to {old}" in o["output"]


def rollback_after_failed_health_check(o):
    assert o["code"] == 1 and o["current"] == old
    assert o["calls"][-1] == f"systemctl is-active {old}", "rolled-back release was not health-checked"
    assert f"rolled back to {old}" in o["output"]


def both_releases_down(o):
    assert o["code"] == 1 and o["current"] == old
    assert "both releases are down" in o["output"] and "rolled back" not in o["output"]


def first_deploy_unhealthy(o):
    assert o["code"] == 1 and o["current"] == new
    assert "no previous release" in o["output"]


def redeploy_unhealthy(o):
    assert o["code"] == 1 and o["current"] == new
    assert f"systemctl restart {new}" in o["calls"]
    assert "no previous release" in o["output"]


def rejected_archive(o):
    assert o["code"] != 0 and o["current"] == old and not o["installed"]
    assert "migrating" not in o["output"] and "outside ran" not in o["calls"]


def symlinked_binary(staging, outside):
    (staging / "blackwall").unlink()
    (staging / "blackwall").symlink_to(outside)


def symlinked_web_file(staging, outside):
    (staging / "web/index.html").unlink()
    (staging / "web/index.html").symlink_to(outside)


def internal_symlink(staging, outside):
    (staging / "web/home.html").symlink_to("index.html")


case("healthy deploy switches to the new release", healthy_deploy)
case("failed restart rolls back", rollback_after_failed_restart, restart_fails=[new])
case("failed health check rolls back and checks the old release", rollback_after_failed_health_check, unhealthy=[new])
case("both releases unhealthy", both_releases_down, unhealthy=[new, old])
case("restart fails for both releases", both_releases_down, restart_fails=[new, old])
case("first deploy has nothing to roll back to", first_deploy_unhealthy, previous=None, unhealthy=[new])
case("redeploying the current release has nothing to roll back to", redeploy_unhealthy, previous=new, unhealthy=[new])
case("archive with an internal symlink installs", healthy_deploy, archive=internal_symlink)
case("archive whose binary is a symlink is rejected", rejected_archive, archive=symlinked_binary)
case("archive with a file linked outside the release is rejected", rejected_archive, archive=symlinked_web_file)

if failures:
    raise SystemExit(f"{len(failures)} deploy case(s) failed")
