#!/usr/bin/env python3
"""Run blackwall-deploy against a scratch root with systemctl, curl and runuser stubbed."""
from pathlib import Path
import fcntl
import os
import shutil
import signal
import subprocess
import tarfile
import tempfile

script = (Path(__file__).resolve().parent / "blackwall-deploy").read_text()
old, new = "a" * 40, "b" * 40
real_readlink, real_sleep = shutil.which("readlink"), shutil.which("sleep")

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


def deploy(work, *, previous=old, unhealthy=(), restart_fails=(), archive=None, existing=None, setup=None, locked=False, extra_stubs={}):
    root = work / "opt"
    bins = work / "bin"
    bins.mkdir()
    for name, body in {**stubs, **extra_stubs}.items():
        (bins / name).write_text(f"#!/bin/sh\n{body}\n")
        (bins / name).chmod(0o755)
    release_files(root / "releases" / old)
    tarball = work / "release.tar.gz"
    outside = work / "outside"
    outside.write_text(f'#!/bin/sh\necho "outside ran" >> "{work / "calls.log"}"\n')
    outside.chmod(0o755)
    if archive:
        staging = work / "staging"
        release_files(staging)
        archive(staging, work)
        with tarfile.open(tarball, "w:gz") as tar:
            for entry in sorted(staging.iterdir()):
                tar.add(entry, entry.name)
    else:
        release_files(root / "releases" / new)
        if existing:
            existing(root / "releases" / new, work)
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
    if setup:
        setup(root)
    if locked:
        lock = open(root / "deploy.lock", "w")
        fcntl.flock(lock, fcntl.LOCK_EX)
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
    if locked:
        lock.close()
    lock_free = True
    with open(root / "deploy.lock") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            lock_free = False
    leftover = work / "leftover.pid"
    if leftover.exists():
        os.kill(int(leftover.read_text()), signal.SIGTERM)
    current = root / "current"
    links = [path for path in current.rglob("*") if path.is_symlink()] if current.exists() else []
    return {
        "code": result.returncode,
        "current": current.resolve().name if current.is_symlink() else None,
        "current_exists": (current / "blackwall").is_file() and (current / "web/index.html").is_file(),
        "dangling": [str(link) for link in links if not link.exists()],
        "links": len(links),
        "releases": sorted(path.name for path in (root / "releases").iterdir()) if (root / "releases").is_dir() else [],
        "elsewhere_kept": (work / "elsewhere/keep").is_file(),
        "lock_free": lock_free,
        "lock_mode": (root / "deploy.lock").stat().st_mode & 0o777,
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
    assert o["current_exists"], "current release is missing its files"
    assert not o["dangling"], f"dangling links in the current release: {o['dangling']}"


def healthy_deploy_with_link(o):
    healthy_deploy(o)
    assert o["links"] == 1, "the release lost its internal link"


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
    assert not [name for name in o["releases"] if name.startswith(".unpack.")], "unpack dir left behind"


def rejected_existing_release(o):
    assert o["code"] != 0 and o["current"] == old
    assert "migrating" not in o["output"] and "outside ran" not in o["calls"]
    assert "failed its checks" in o["output"]


def refused_while_locked(o):
    assert o["code"] != 0 and o["current"] == old
    assert "another deploy is running" in o["output"] and "migrating" not in o["output"]


rollback_kept = "c" * 40
pruned = "d" * 40
linked = "e" * 40


def prune_removes_only_the_link(o):
    prune_keeps_current_and_rollback(o)
    assert linked not in o["releases"], f"the old release link was not pruned: {o['releases']}"


def prune_removes_only_the_outside_link(o):
    assert o["elsewhere_kept"], "pruning deleted the directory a release link points to"
    prune_removes_only_the_link(o)


def lock_released(o):
    healthy_deploy(o)
    assert o["lock_free"], "a process left behind by migrate still holds the deploy lock"


def private_lock(o):
    healthy_deploy(o)
    assert o["lock_mode"] == 0o600, f"deploy.lock has mode {o['lock_mode']:o}"


def prune_keeps_current_and_rollback(o):
    assert o["code"] == 0 and o["current"] == new
    assert new in o["releases"] and rollback_kept in o["releases"], f"pruned too much: {o['releases']}"
    assert pruned not in o["releases"] and old not in o["releases"], f"nothing was pruned: {o['releases']}"


def symlinked_binary(staging, work):
    (staging / "blackwall").unlink()
    (staging / "blackwall").symlink_to(work / "outside")


def symlinked_web_file(staging, work):
    (staging / "web/index.html").unlink()
    (staging / "web/index.html").symlink_to(work / "outside")


def internal_symlink(staging, work):
    (staging / "web/home.html").symlink_to("index.html")


def absolute_symlink_into_staging(staging, work):
    (staging / "web/content.html").write_text("ok")
    (staging / "web/index.html").unlink()
    (staging / "web/index.html").symlink_to(work / "opt/releases" / f"{new}.tmp/web/content.html")


def relative_symlink_into_staging(staging, work):
    (staging / "web/content.html").write_text("ok")
    (staging / "web/index.html").unlink()
    (staging / "web/index.html").symlink_to(f"../../{new}.tmp/web/content.html")


def existing_symlinked_binary(release, work):
    (release / "blackwall").unlink()
    (release / "blackwall").symlink_to(work / "outside")


def existing_link_outside(release, work):
    (release / "web/index.html").unlink()
    (release / "web/index.html").symlink_to(work / "outside")


def existing_internal_link(release, work):
    (release / "web/home.html").symlink_to("index.html")


def old_releases(root):
    # The new release and the rollback release are older than five others, so only the guards keep them.
    releases = root / "releases"
    for name in [rollback_kept, new, pruned, old] + [str(n) * 40 for n in range(5)]:
        if not (releases / name).exists():
            release_files(releases / name)
    (root / "current").unlink()
    (root / "current").symlink_to(releases / rollback_kept)
    for age, name in enumerate([str(n) * 40 for n in range(5)] + [old, pruned, new, rollback_kept]):
        os.utime(releases / name, (1_000_000 - age * 1000,) * 2)


def old_release_linked_outside(root):
    old_releases(root)
    elsewhere = root.parent / "elsewhere"
    release_files(elsewhere)
    (elsewhere / "keep").write_text("ok")
    (root / "releases" / linked).symlink_to(elsewhere)
    os.utime(elsewhere, (1_000,) * 2)


def old_release_linked_to_releases(root):
    old_releases(root)
    (root / "releases" / linked).symlink_to(root / "releases")
    os.utime(root / "releases", (1_000,) * 2)


def migrate_leaves_a_process(release, work):
    (release / "blackwall").write_text(f'#!/bin/sh\n"{real_sleep}" 30 >/dev/null 2>&1 &\necho $! > "{work / "leftover.pid"}"\n')


def readlink_fails_for(path_pattern):
    return {"readlink": f'case "$1 $2" in "-f "{path_pattern}) exit 1 ;; esac\nexec "{real_readlink}" "$@"'}


def dangling_symlink(staging, work):
    (staging / "web/home.html").symlink_to("missing.html")


case("healthy deploy switches to the new release", healthy_deploy)
case("failed restart rolls back", rollback_after_failed_restart, restart_fails=[new])
case("failed health check rolls back and checks the old release", rollback_after_failed_health_check, unhealthy=[new])
case("both releases unhealthy", both_releases_down, unhealthy=[new, old])
case("restart fails for both releases", both_releases_down, restart_fails=[new, old])
case("first deploy has nothing to roll back to", first_deploy_unhealthy, previous=None, unhealthy=[new])
case("redeploying the current release has nothing to roll back to", redeploy_unhealthy, previous=new, unhealthy=[new])
case("archive with an internal symlink installs", healthy_deploy_with_link, archive=internal_symlink)
case("archive whose binary is a symlink is rejected", rejected_archive, archive=symlinked_binary)
case("archive with a file linked outside the release is rejected", rejected_archive, archive=symlinked_web_file)
case("archive with an absolute link into its unpack dir is rejected", rejected_archive, archive=absolute_symlink_into_staging)
case("archive with a relative link back into its unpack dir is rejected", rejected_archive, archive=relative_symlink_into_staging)
case("archive with a dangling link is rejected", rejected_archive, archive=dangling_symlink)
case("archive is rejected when its unpack dir cannot be resolved", rejected_archive, archive=symlinked_web_file, extra_stubs=readlink_fails_for('*/.unpack.*'))
case("archive is rejected when listing its links fails", rejected_archive, archive=internal_symlink, extra_stubs={"find": "exit 2"})
case("redeploying an existing release whose binary is a symlink is rejected", rejected_existing_release, existing=existing_symlinked_binary)
case("redeploying an existing release with a link outside it is rejected", rejected_existing_release, existing=existing_link_outside)
case("redeploying an existing release with an internal link installs", healthy_deploy_with_link, existing=existing_internal_link)
case("redeploying an existing release is rejected when it cannot be resolved", rejected_existing_release, existing=existing_link_outside, extra_stubs=readlink_fails_for(f'*/releases/{new}'))
case("deploy is refused while another holds the lock", refused_while_locked, locked=True)
case("a process left behind by migrate does not hold the lock", lock_released, existing=migrate_leaves_a_process)
case("the lock file is private to root", private_lock)
case("pruning keeps the current and rollback releases", prune_keeps_current_and_rollback, setup=old_releases)
case("pruning an old release linked outside removes only the link", prune_removes_only_the_outside_link, setup=old_release_linked_outside)
case("pruning an old release linked to the releases dir removes only the link", prune_removes_only_the_link, setup=old_release_linked_to_releases)

if failures:
    raise SystemExit(f"{len(failures)} deploy case(s) failed")
