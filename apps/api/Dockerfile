FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.13.1 /uv /bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev
COPY . .
# export:web places the same Expo app in web-dist before this API-only context is built.
RUN test -s web-dist/index.html
RUN useradd --create-home app
USER app
ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1
# Access logs stay off because OAuth request queries can contain short-lived codes.
CMD ["sh", "-c", "uvicorn config.asgi:application --host 0.0.0.0 --port ${PORT:-8000} --workers 2 --no-access-log --timeout-keep-alive 5"]
