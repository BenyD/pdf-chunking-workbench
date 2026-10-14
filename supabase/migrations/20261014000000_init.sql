-- ChunkLab schema
-- One Postgres database holds everything: documents, page renders metadata,
-- chunks for all three strategies, OCR templates/runs and the eval set.
-- Hybrid search (full text + vector) is a single SQL function so the web app
-- does one RPC per query.

create extension if not exists vector;
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- documents
-- ---------------------------------------------------------------------------
create table if not exists documents (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  storage_path  text not null,                 -- path inside the storage bucket
  kind          text not null default 'upload', -- upload | sample
  sample_key    text unique,                    -- stable id for built-in samples
  page_count    int,
  status        text not null default 'queued', -- queued | processing | ready | error
  progress      jsonb not null default '{}'::jsonb,
  stats         jsonb not null default '{}'::jsonb, -- chunk counts, token totals, llm usage
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- pages: one row per rendered page. width/height are PDF points so the UI can
-- scale bounding boxes (stored as fractions) onto the rendered PNG.
-- ---------------------------------------------------------------------------
create table if not exists pages (
  document_id   uuid not null references documents(id) on delete cascade,
  page_number   int  not null,                 -- 1-based
  width         float not null,
  height        float not null,
  image_path    text not null,
  is_scanned    boolean not null default false,
  ocr_applied   boolean not null default false,
  primary key (document_id, page_number)
);

-- ---------------------------------------------------------------------------
-- chunks: every strategy writes its own rows so they can be compared.
--   strategy   : naive | structural | contextual
--   chunk_type : text | table | table_row | figure | record
--   content    : what gets embedded and full-text indexed (context + raw_text)
--   raw_text   : the document text only
--   context    : breadcrumb (structural) or model-written situating sentence (contextual)
--   bboxes     : [{page, x0, y0, x1, y1}] as fractions of page size
-- ---------------------------------------------------------------------------
create table if not exists chunks (
  id            uuid primary key default gen_random_uuid(),
  document_id   uuid not null references documents(id) on delete cascade,
  strategy      text not null check (strategy in ('naive','structural','contextual')),
  chunk_type    text not null check (chunk_type in ('text','table','table_row','figure','record')),
  ordinal       int  not null,
  content       text not null,
  raw_text      text not null,
  context       text,
  page_start    int  not null,
  page_end      int  not null,
  bboxes        jsonb not null default '[]'::jsonb,
  parent_id     uuid references chunks(id) on delete set null,
  prev_id       uuid,
  next_id       uuid,
  metadata      jsonb not null default '{}'::jsonb,
  token_count   int  not null default 0,
  tsv           tsvector generated always as (to_tsvector('english', content)) stored,
  embedding     vector(1024)
);

create index if not exists chunks_doc_strategy_idx on chunks (document_id, strategy, ordinal);
create index if not exists chunks_tsv_idx on chunks using gin (tsv);
create index if not exists chunks_embedding_idx on chunks using hnsw (embedding vector_cosine_ops);
create index if not exists chunks_parent_idx on chunks (parent_id);

-- ---------------------------------------------------------------------------
-- OCR templates: boxes drawn by the user on a sample page, stored as fractions
-- of page width/height so they survive different scan resolutions.
--   fields  : [{name, type: text|date|amount|integer, page, box:{x,y,w,h}, pattern?}]
--   anchors : [{text, page, box:{x,y,w,h}}] words used to re-register shifted scans
-- ---------------------------------------------------------------------------
create table if not exists ocr_templates (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  document_id   uuid references documents(id) on delete set null,
  fields        jsonb not null default '[]'::jsonb,
  anchors       jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now()
);

create table if not exists ocr_runs (
  id            uuid primary key default gen_random_uuid(),
  template_id   uuid references ocr_templates(id) on delete cascade,
  document_id   uuid references documents(id) on delete cascade,
  page_number   int not null default 1,
  result        jsonb not null,
  chunk_id      uuid,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- eval questions: expected page and a substring the right chunk must contain.
-- ---------------------------------------------------------------------------
create table if not exists eval_questions (
  id            uuid primary key default gen_random_uuid(),
  document_id   uuid not null references documents(id) on delete cascade,
  question      text not null,
  expected_page int,
  must_contain  text,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- RLS: the web app and the worker use the service role from the server, which
-- bypasses RLS. Enabling it with no policies closes the anon key completely.
-- ---------------------------------------------------------------------------
alter table documents      enable row level security;
alter table pages          enable row level security;
alter table chunks         enable row level security;
alter table ocr_templates  enable row level security;
alter table ocr_runs       enable row level security;
alter table eval_questions enable row level security;

-- ---------------------------------------------------------------------------
-- Storage bucket for PDFs, page renders and figure crops. Public read so the
-- browser can load renders directly from the CDN.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('chunklab', 'chunklab', true, 209715200)
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit;

-- ---------------------------------------------------------------------------
-- Hybrid search with Reciprocal Rank Fusion.
-- Full text catches exact tokens (section numbers, drug names); vectors catch
-- paraphrase. Each list is ranked independently and fused with 1/(k + rank).
-- ---------------------------------------------------------------------------
create or replace function hybrid_search(
  query_text        text,
  query_embedding   vector(1024),
  p_strategy        text,
  p_document_id     uuid    default null,
  match_count       int     default 10,
  rrf_k             int     default 60,
  full_text_weight  float   default 1.0,
  semantic_weight   float   default 1.0
)
returns table (
  id uuid, document_id uuid, strategy text, chunk_type text,
  content text, raw_text text, context text,
  page_start int, page_end int, bboxes jsonb,
  parent_id uuid, prev_id uuid, next_id uuid, metadata jsonb,
  rrf_score float, fts_rank int, vec_rank int
)
language sql stable
as $$
  with fts as (
    select c.id,
           row_number() over (
             order by ts_rank_cd(c.tsv, websearch_to_tsquery('english', query_text)) desc
           )::int as rank
    from chunks c
    where c.strategy = p_strategy
      and (p_document_id is null or c.document_id = p_document_id)
      and c.tsv @@ websearch_to_tsquery('english', query_text)
    limit greatest(match_count, 1) * 4
  ),
  vec as (
    select c.id,
           row_number() over (order by c.embedding <=> query_embedding)::int as rank
    from chunks c
    where c.strategy = p_strategy
      and (p_document_id is null or c.document_id = p_document_id)
      and c.embedding is not null
      and query_embedding is not null
    order by c.embedding <=> query_embedding
    limit greatest(match_count, 1) * 4
  )
  select c.id, c.document_id, c.strategy, c.chunk_type,
         c.content, c.raw_text, c.context,
         c.page_start, c.page_end, c.bboxes,
         c.parent_id, c.prev_id, c.next_id, c.metadata,
         (coalesce(1.0 / (rrf_k + fts.rank), 0) * full_text_weight
        + coalesce(1.0 / (rrf_k + vec.rank), 0) * semantic_weight)::float as rrf_score,
         fts.rank as fts_rank,
         vec.rank as vec_rank
  from chunks c
  left join fts on fts.id = c.id
  left join vec on vec.id = c.id
  where fts.id is not null or vec.id is not null
  order by rrf_score desc
  limit match_count;
$$;

-- Keep updated_at fresh
create or replace function set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists documents_updated_at on documents;
create trigger documents_updated_at before update on documents
  for each row execute function set_updated_at();
