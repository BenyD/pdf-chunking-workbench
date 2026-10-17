"""Worker settings. Everything comes from environment variables (or worker/.env locally)."""
from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Postgres (Supabase). Direct connection string, not the REST API.
    database_url: str

    # Supabase Storage via its REST API. Service role key never leaves the server.
    supabase_url: str
    supabase_service_role_key: str
    storage_bucket: str = "chunklab"

    # Shared secret between the web app and this worker.
    worker_secret: str = "dev-secret"

    # Model providers
    anthropic_api_key: str | None = None
    voyage_api_key: str | None = None

    # Which model does what. Vision + OCR fallback need judgement -> Opus.
    # Per-chunk context is bulk, simple work -> Haiku.
    vision_model: str = "claude-opus-5-5"
    triage_model: str = "claude-haiku-5-5"    # one cheap look at a figure crop before the Opus description
    context_model: str = "claude-haiku-5-5"
    ocr_model: str = "claude-opus-5-5"
    embedding_model: str = "voyage-4"
    embedding_dim: int = 1024
    # Voyage rate limiting. New accounts without a payment method are capped at
    # a few requests per minute; set VOYAGE_RPM accordingly and the worker paces itself.
    voyage_rpm: int = 60
    voyage_max_tokens_per_request: int = 60_000
    voyage_max_retries: int = 10

    # Rendering
    render_scale: float = 1.25          # 72dpi * 1.25 = 90dpi page renders for the UI
    figure_dpi: int = 150               # crops sent to the vision model
    ocr_dpi: int = 300                  # zonal OCR works best at 300dpi

    # Chunk sizing (tokens, approximate)
    chunk_max_tokens: int = 450
    table_max_tokens: int = 900

    # Dev switches. Both default off; they exist so the pipeline can be tested
    # end to end without spending money or needing keys.
    skip_llm: bool = False              # contextual strategy copies structural chunks
    fake_embeddings: bool = False       # deterministic pseudo-vectors, search is FTS-only in practice

    # Pure mode: no generative model at any step. Passages are cut by rules only, and meaning search uses a
    # small open-source embedding model that runs here on the CPU (ONNX), so no text leaves this server.
    pure: bool = False
    local_embedding_model: str = "snowflake/snowflake-arctic-embed-s"   # beat bge-small-en-v1.5 on our benchmark, 93% to 90% (scripts/compare_local_models.py)
    local_embedding_dim: int = 384
    local_model_cache: str | None = None    # the Docker image bakes the model into /app/models
    local_embedding_threads: int | None = None   # default: the CPUs this container may use (llm/local.py)

    llm_concurrency: int = 6
    tesseract_cmd: str | None = None
    ocr_lang: str = "eng"               # scanned pages
    ocr_lang_garbled: str = "hin+eng"   # pages whose text layer is a legacy-font mojibake (needs the hin pack)
    garbled_text_ratio: float = 0.08    # share of letters on Latin Extended / IPA / combining code points that marks a page as mojibake


settings = Settings()
