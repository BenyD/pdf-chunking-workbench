-- Meaning search with a small open-source embedding model that runs inside our own worker: no API call, and
-- nothing is generated. Its vectors (384 numbers per passage) live in their own column, so the API model's
-- vectors and the local model's can sit side by side and be compared. hybrid_search_local is hybrid_search
-- with that column: the same keyword ranking, the same fusion.
alter table chunks add column if not exists embedding_local vector(384);
create index if not exists chunks_embedding_local_idx on chunks using hnsw (embedding_local vector_cosine_ops);

create or replace function hybrid_search_local(
  query_text        text,
  query_embedding   vector(384),
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
  with q as (
    select websearch_to_tsquery('english', query_text) as q_and,
           coalesce(
             (select to_tsquery('english', string_agg(quote_literal(lexeme), ' | '))
                from unnest(to_tsvector('english', query_text))),
             websearch_to_tsquery('english', query_text)
           ) as q_or,
           (select to_tsquery('english', string_agg('(' || plainto_tsquery('english', tok)::text || ')', ' & '))
              from regexp_split_to_table(query_text, '\s+') as tok
             where tok ~ '[0-9]' and numnode(plainto_tsquery('english', tok)) > 0) as q_must
  ),
  fts as (
    select id, rank from (
      select c.id,
             row_number() over (
               order by (q.q_must is not null and c.tsv @@ q.q_must) desc,
                        ts_rank_cd(c.tsv, q.q_and, 1) desc,
                        ts_rank_cd(c.tsv, q.q_or, 1) desc
             )::int as rank
      from chunks c, q
      where c.strategy = p_strategy
        and (p_document_id is null or c.document_id = p_document_id)
        and c.tsv @@ q.q_or
    ) ranked
    order by rank
    limit greatest(match_count, 1) * 4
  ),
  vec as (
    select c.id,
           row_number() over (order by c.embedding_local <=> query_embedding)::int as rank
    from chunks c
    where c.strategy = p_strategy
      and (p_document_id is null or c.document_id = p_document_id)
      and c.embedding_local is not null
      and query_embedding is not null
    order by c.embedding_local <=> query_embedding
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
