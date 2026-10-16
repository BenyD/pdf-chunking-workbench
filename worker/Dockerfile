FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      tesseract-ocr tesseract-ocr-eng tesseract-ocr-hin \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1
# The local embedding model for pure mode, baked in so a cold start never downloads it.
ARG LOCAL_EMBEDDING_MODEL=snowflake/snowflake-arctic-embed-s
ENV LOCAL_MODEL_CACHE=/app/models LOCAL_EMBEDDING_MODEL=${LOCAL_EMBEDDING_MODEL}
RUN python -c "from fastembed import TextEmbedding; TextEmbedding('${LOCAL_EMBEDDING_MODEL}', cache_dir='/app/models')"

COPY app ./app
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
