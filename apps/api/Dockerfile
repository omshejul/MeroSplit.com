FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.13.1 /uv /bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev
COPY . .
RUN useradd --create-home app
USER app
ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1
CMD ["sh", "-c", "gunicorn config.wsgi --bind 0.0.0.0:${PORT:-8000} --workers 2 --timeout 60 --access-logfile - --access-logformat '%(m)s status=%(s)s bytes=%(b)s seconds=%(L)s'"]
