-- Full-text search that knows about codes and headings.
--
-- 1. The index weights the context (breadcrumb and situating sentence) above
--    the body, so a question naming a section or heading finds that section
--    before the sections that merely mention the word.
-- 2. A query token carrying a digit (F-11000, 303, 109(2), 2.1 mm) is a code.
--    Chunks that contain every such token rank above all others, whatever the
--    rest of the question says; when no chunk has the code, nothing changes.
-- 3. Ranks are normalised by document length so a 900-token table part cannot
--    beat the single row it was split from by repeating header words.

alter table chunks drop column if exists tsv;
alter table chunks add column tsv tsvector generated always as (
  setweight(to_tsvector('english', coalesce(context, '')), 'A') ||
  setweight(to_tsvector('english', raw_text), 'B')
) stored;
create index if not exists chunks_tsv_idx on chunks using gin (tsv);

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
