"""Short-lived PDF-to-JPEG child. No Django, storage credentials or persisted files."""

import io
import math
import resource
import sys
from contextlib import closing

MAX_INPUT = 20 * 1024 * 1024
MAX_OUTPUT = 64 * 1024


def limit_resources():
    for name, limit in ((resource.RLIMIT_CPU, 3), (resource.RLIMIT_FSIZE, MAX_OUTPUT),
                        (resource.RLIMIT_CORE, 0), (resource.RLIMIT_NOFILE, 32)):
        resource.setrlimit(name, (limit, limit))
    if sys.platform.startswith("linux"):
        resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024,) * 2)


def render(data: bytes) -> bytes:
    import pypdfium2

    if not 0 < len(data) <= MAX_INPUT:
        raise ValueError("Invalid PDF size")
    with pypdfium2.PdfDocument(data) as document:
        if not len(document):
            raise ValueError("PDF has no pages")
        page = document[0]
        width, height = page.get_size()
        if not all(math.isfinite(value) and value > 0 for value in (width, height)):
            raise ValueError("Invalid page size")
        with closing(page.render(scale=min(1, 224 / max(width, height)), draw_annots=False, limit_image_cache=True)) as bitmap:
            with bitmap.to_pil() as image, image.convert("RGB") as rgb, io.BytesIO() as output:
                rgb.save(output, "JPEG", quality=80)
                result = output.getvalue()
    if len(result) > MAX_OUTPUT:
        raise ValueError("Preview exceeds the output limit")
    return result


if __name__ == "__main__":
    try:
        limit_resources()
        sys.stdout.buffer.write(render(sys.stdin.buffer.read(MAX_INPUT + 1)))
    except Exception:
        sys.exit(1)  # The API returns generic retry copy, never PDF contents or child diagnostics.
