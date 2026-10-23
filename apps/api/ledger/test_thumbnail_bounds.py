import fcntl
import io
import json
import os
import resource
import signal
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace

import pytest
from ninja.errors import HttpError
from PIL import Image

from . import media, pdf_thumbnail_renderer
from .models import Change, UploadedFile
from .test_api import client as client
from .test_api import group as group
from .test_api import send
from .test_media import bill as bill
from .test_media import pdf_bytes
from .test_media import storage as storage
from .test_media_thumbnails import attach_pdf

pytestmark = pytest.mark.django_db


@pytest.fixture
def children(monkeypatch):
    started, outputs, popen = [], [], subprocess.Popen

    def start(*args, **kwargs):
        child = popen(*args, **kwargs)
        started.append(child)
        outputs.append(kwargs["stdout"])
        return child

    monkeypatch.setattr(media.subprocess, "Popen", start)
    yield started, outputs
    for child in started:
        if child.poll() is None:
            child.kill()
        child.wait(timeout=2)


def fake_renderer(tmp_path, monkeypatch, code):
    path = tmp_path / "synthetic_renderer.py"
    path.write_text(f"import os, sys, time, runpy\nrunpy.run_path({str(media._THUMBNAIL_RENDERER)!r})['limit_resources']()\n" + code)
    monkeypatch.setattr(media, "_THUMBNAIL_RENDERER", path)


def assert_reaped(children):
    started, outputs = children
    assert started and all(child.returncode is not None for child in started)
    assert all(output.closed for output in outputs)
    for child in started:
        with pytest.raises(ChildProcessError):
            os.waitpid(child.pid, os.WNOHANG)


def test_stalled_child_is_killed_reaped_and_next_real_pdf_succeeds(client, bill, storage, monkeypatch, tmp_path, children, record_property):
    file_id = attach_pdf(client, bill)
    path = f"/media/{file_id}/thumbnail"
    changes, objects = Change.objects.count(), dict(storage.objects)
    deadline = media._THUMBNAIL_DEADLINE
    with monkeypatch.context() as patch:
        fake_renderer(tmp_path, patch, "time.sleep(60)\n")
        start = time.monotonic()
        response = send(client, "get", path)
        elapsed = time.monotonic() - start
    record_property("timeout_elapsed_seconds", elapsed)
    record_property("timed_out_child_pid", children[0][0].pid)
    assert response.status_code == 503 and response["Cache-Control"] == "private, no-store"
    assert deadline <= elapsed < deadline + 1.5 and children[0][0].returncode == -signal.SIGKILL
    assert_reaped(children)
    assert send(client, "get", path).status_code == 200  # Actual isolated PDFium renderer after timeout.
    assert len(children[0]) == 2 and children[0][1].returncode == 0
    assert_reaped(children)
    assert storage.objects == objects and Change.objects.count() == changes and UploadedFile.objects.count() == 1


@pytest.mark.parametrize("code", [
    "sys.stderr.write('SYNTHETIC_PRIVATE_DIAGNOSTIC'); sys.exit(7)\n",
    "pass\n",
    "sys.stdout.buffer.write(b'SYNTHETIC_MALFORMED_OUTPUT')\n",
    "sys.stdout.buffer.write(b'x' * (64 * 1024 + 1))\n",
    "from PIL import Image\nImage.new('RGB', (225, 1)).save(sys.stdout.buffer, 'JPEG')\n",
])
def test_failed_or_invalid_child_output_is_private_and_clean(client, bill, storage, monkeypatch, tmp_path, children, code):
    file_id = attach_pdf(client, bill)
    before, changes = dict(storage.objects), Change.objects.count()
    fake_renderer(tmp_path, monkeypatch, code)
    response = send(client, "get", f"/media/{file_id}/thumbnail")
    assert response.status_code == 503 and response["Cache-Control"] == "private, no-store"
    assert response.json()["detail"] == "Preview unavailable; tap the file to open it or retry the preview"
    assert b"SYNTHETIC_" not in response.content
    assert_reaped(children)
    assert storage.objects == before and Change.objects.count() == changes
    assert send(client, "get", f"/media/{file_id}/url").status_code == 200


def test_admission_wait_is_bounded_before_storage_and_does_not_start_another_child(monkeypatch, tmp_path, children, record_property):
    fake_renderer(tmp_path, monkeypatch, "time.sleep(60)\n")
    monkeypatch.setattr(media, "_THUMBNAIL_DEADLINE", 0.3)
    monkeypatch.setattr(media, "_THUMBNAIL_WAIT", 0.05)
    monkeypatch.setattr(media, "_visible_file", lambda *args: SimpleNamespace(content_type="application/pdf", object_key="synthetic"))
    reads, failures, ready = [], [], threading.Event()

    def read(**kwargs):
        reads.append(1)
        return {"Body": io.BytesIO(pdf_bytes())}

    monkeypatch.setattr(media, "_storage", lambda: SimpleNamespace(get_object=read))
    popen = media.subprocess.Popen

    def start(*args, **kwargs):
        child = popen(*args, **kwargs)
        ready.set()
        return child

    monkeypatch.setattr(media.subprocess, "Popen", start)

    def first():
        try:
            media.pdf_thumbnail(None, "synthetic")
        except HttpError as error:
            failures.append(error.status_code)

    thread = threading.Thread(target=first)
    thread.start()
    try:
        assert ready.wait(2)
        start = time.monotonic()
        with pytest.raises(HttpError) as error:
            media.pdf_thumbnail(None, "synthetic")
        elapsed = time.monotonic() - start
        record_property("admission_wait_seconds", elapsed)
        assert error.value.status_code == 503 and elapsed < 0.25
        assert len(children[0]) == len(reads) == 1
    finally:
        thread.join(2)
    assert not thread.is_alive() and failures == [503]
    assert_reaped(children)
    assert media._thumbnail_slots.acquire(blocking=False)
    media._thumbnail_slots.release()


def test_request_interruption_kills_and_reaps_child(monkeypatch, tmp_path, children):
    fake_renderer(tmp_path, monkeypatch, "time.sleep(60)\n")
    popen = media.subprocess.Popen

    def start(*args, **kwargs):
        child = popen(*args, **kwargs)
        communicate = child.communicate

        def interrupt(*args, **kwargs):
            child.communicate = communicate
            raise KeyboardInterrupt

        child.communicate = interrupt
        return child

    monkeypatch.setattr(media.subprocess, "Popen", start)
    with pytest.raises(KeyboardInterrupt):
        media._render_pdf_thumbnail(pdf_bytes())
    assert_reaped(children)
    assert children[0][0].returncode == -signal.SIGKILL


def test_child_does_not_inherit_server_environment_or_open_descriptors(monkeypatch, tmp_path, children):
    monkeypatch.setenv("MEROSPLIT_SYNTHETIC_SECRET", "never-in-child")
    with tempfile.TemporaryFile() as secret:
        fd = fcntl.fcntl(secret.fileno(), fcntl.F_DUPFD, 100)
        os.set_inheritable(fd, True)
        try:
            fake_renderer(tmp_path, monkeypatch, f"assert 'MEROSPLIT_SYNTHETIC_SECRET' not in os.environ\ntry:\n os.fstat({fd})\nexcept OSError:\n pass\nelse:\n sys.exit(9)\nfrom PIL import Image\nImage.new('RGB',(10,10),'white').save(sys.stdout.buffer,'JPEG')\n")
            result = media._render_pdf_thumbnail(pdf_bytes())
            with Image.open(io.BytesIO(result)) as image:
                assert image.size == (10, 10)
        finally:
            os.close(fd)
    assert_reaped(children)


def test_linux_resource_policy_is_explicit_and_child_applies_host_limits(monkeypatch, record_property):
    calls = []
    fake_resource = SimpleNamespace(**{name: getattr(resource, name) for name in ["RLIMIT_CPU", "RLIMIT_FSIZE", "RLIMIT_CORE", "RLIMIT_NOFILE", "RLIMIT_AS"]}, setrlimit=lambda key, value: calls.append((key, value)))
    with monkeypatch.context() as patch:
        patch.setattr(pdf_thumbnail_renderer, "resource", fake_resource)
        patch.setattr(pdf_thumbnail_renderer, "sys", SimpleNamespace(platform="linux"))
        pdf_thumbnail_renderer.limit_resources()
    assert dict(calls) == {resource.RLIMIT_CPU: (3, 3), resource.RLIMIT_FSIZE: (65536, 65536), resource.RLIMIT_CORE: (0, 0), resource.RLIMIT_NOFILE: (32, 32), resource.RLIMIT_AS: (268435456, 268435456)}
    script = f"import json,runpy,resource,sys\nrunpy.run_path({str(media._THUMBNAIL_RENDERER)!r})['limit_resources']()\nprint(json.dumps({{name:resource.getrlimit(getattr(resource,name)) for name in ['RLIMIT_CPU','RLIMIT_FSIZE','RLIMIT_CORE','RLIMIT_NOFILE']+(['RLIMIT_AS'] if sys.platform.startswith('linux') else [])}}))"
    result = subprocess.run([sys.executable, "-I", "-B", "-c", script], env={}, capture_output=True, timeout=5, check=True)
    limits = json.loads(result.stdout)
    record_property("actual_child_host", sys.platform)
    record_property("actual_child_limits", result.stdout.decode().strip())
    assert limits["RLIMIT_CPU"] == [3, 3] and limits["RLIMIT_FSIZE"] == [65536, 65536]
    assert limits["RLIMIT_CORE"] == [0, 0] and limits["RLIMIT_NOFILE"] == [32, 32]
    if sys.platform.startswith("linux"):
        assert limits["RLIMIT_AS"] == [268435456, 268435456]
