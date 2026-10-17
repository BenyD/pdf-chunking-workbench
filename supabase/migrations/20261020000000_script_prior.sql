-- Passages in an Indian script stop crowding questions asked in English in pure-mode search.
--
-- The local model (snowflake-arctic-embed-s) reads English only. A passage in Hindi, such as the Hindi half of
-- an NPPA price notice, comes out as a vector that sits near every question, so it filled top-five slots for
-- questions it cannot answer: 26 slots in 7 of the 129 benchmark questions, first place in 3 (docs/DECISIONS.md
-- section 31, scripts/eval_hubs.py). For a question with no Indian-script letters, such passages are left out of
-- the meaning ranks; keyword search still finds them, and a question typed in Hindi is unchanged. The nearest
-- 8 x match_count passages are drawn so that leaving some out still leaves 4 x match_count.

create or replace function mostly_indic(t text)
returns boolean
language sql immutable parallel safe
as $$
  select length(regexp_replace(coalesce(t, ''), '[^\u0900-\u0D7F]', '', 'g'))
       > length(regexp_replace(coalesce(t, ''), '[^A-Za-z]', '', 'g'));
$$;

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
             where tok ~ '[0-9]' and numnode(plainto_tsquery('english', tok)) > 0) as q_must,
           query_text ~* '\mpages?\M' as asks_page,
           query_text !~ '[\u0900-\u0D7F]' as latin
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
  vec_near as (
    select c.id, c.raw_text, c.embedding_local <=> query_embedding as dist
    from chunks c
    where c.strategy = p_strategy
      and (p_document_id is null or c.document_id = p_document_id)
      and c.embedding_local is not null
      and query_embedding is not null
    order by c.embedding_local <=> query_embedding
    limit greatest(match_count, 1) * 8
  ),
  vec as (
    -- a passage in an Indian script is left out of the meaning ranks for a question with none: the English-only
    -- model cannot read it, so its vector sits near every question
    select v.id, row_number() over (order by v.dist)::int as rank
    from vec_near v, q
    where not (q.latin and mostly_indic(v.raw_text))
    order by v.dist
    limit greatest(match_count, 1) * 4
  ),
  fused as (
    select c.id, c.document_id, c.strategy, c.chunk_type,
           c.content, c.raw_text, c.context,
           c.page_start, c.page_end, c.bboxes,
           c.parent_id, c.prev_id, c.next_id, c.metadata,
           (coalesce(1.0 / (rrf_k + fts.rank), 0) * full_text_weight
          + coalesce(1.0 / (rrf_k + vec.rank), 0) * semantic_weight)::float as fused,
           fts.rank as f_rank,
           vec.rank as v_rank
    from chunks c
    left join fts on fts.id = c.id
    left join vec on vec.id = c.id
    where fts.id is not null or vec.id is not null
  )
  select f.id, f.document_id, f.strategy, f.chunk_type,
         f.content, f.raw_text, f.context,
         f.page_start, f.page_end, f.bboxes,
         f.parent_id, f.prev_id, f.next_id, f.metadata,
         (f.fused * case
            when f.chunk_type in ('text', 'figure')
              then 1 - 0.8 * (1 - least(1.0, own_text_length(f.raw_text, q.asks_page) / 200.0))
            else 1
          end)::float as rrf_score,
         f.f_rank as fts_rank,
         f.v_rank as vec_rank
  from fused f, q
  order by rrf_score desc
  limit match_count;
$$;
