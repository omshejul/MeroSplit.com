FROM python:3.12-slim
# Pillow wheels provide HarfBuzz/RAQM; this small runtime enables complex-script shaping.
RUN apt-get update && apt-get install -y --no-install-recommends libfribidi0 && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.13.1 /uv /bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev
RUN .venv/bin/python -c "from PIL import features; assert features.check('raqm'), 'Invite images require RAQM/FriBiDi'"
COPY . .
# export:web archives the complete Expo shell before this API-only context is built.
RUN mkdir -p web-dist && tar -xf web-dist.tar -C web-dist && rm web-dist.tar && test -s web-dist/index.html
RUN useradd --create-home app
USER app
ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1
# Access logs stay off: OAuth queries and /j/ invite paths contain bearer capabilities.
CMD ["sh", "-c", "uvicorn config.asgi:application --host 0.0.0.0 --port ${PORT:-8000} --workers 2 --no-access-log --timeout-keep-alive 5"]
