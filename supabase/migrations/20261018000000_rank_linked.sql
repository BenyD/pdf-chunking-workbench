-- Passages linked from the top search results (a figure's key, the table or section a passage cites, a passage
-- sharing a unit number), ranked against the question so the closest ones are shown. Scored by the local model's
-- vectors when a local query vector is given, by the API model's when that is given, else by keyword rank.
create or replace function rank_linked(
  p_ids        uuid[],
  query_text   text,
  q_local      vector(384)  default null,
  q_api        vector(1024) default null,
  p_limit      int          default 5
)
returns table (
  id uuid, document_id uuid, chunk_type text, raw_text text, context text,
  page_start int, page_end int, bboxes jsonb, metadata jsonb, token_count int, score float
)
language sql stable
as $$
  select c.id, c.document_id, c.chunk_type, c.raw_text, c.context, c.page_start, c.page_end, c.bboxes, c.metadata,
         c.token_count,
         coalesce(
           case when q_local is not null and c.embedding_local is not null then 1 - (c.embedding_local <=> q_local) end,
           case when q_api is not null and c.embedding is not null then 1 - (c.embedding <=> q_api) end,
           ts_rank_cd(c.tsv, websearch_to_tsquery('english', query_text))
         )::float as score
  from chunks c
  where c.id = any(p_ids)
  order by score desc
  limit p_limit;
$$;
