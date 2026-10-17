-- Passages with almost no text of their own stop coming first in pure-mode search.
--
-- The local model (snowflake-arctic-embed-s) scores a short or list-like passage close to many unrelated
-- questions: a contents entry such as "15. Documentation 115 General 115 Documents required 116", a lone "A" left
-- by the layout, a figure whose only text is "Figure J". On the live site "What action was decided for the bowl in
-- Figure 1 given its rim dent?" across all documents put the WHO guide's contents page first, above the
-- inspection report's Figure 1. Nothing is deleted: such a passage is scored lower, and still comes up when
-- nothing better matches.
--
-- own_text_length is a passage's length once contents entries (a title, then the page it starts on) are taken
-- out and spaces collapsed. hybrid_search_local scales the fused score of a text or figure passage with fewer
-- than 200 characters of its own down in proportion, to a fifth for a passage with none. Tables, rows and
-- records keep their score: a row is short by nature and is often the answer. When the question asks about a
-- page ("On which page does ... begin?"), a contents page is the answer, so its entries count as its own text.
-- Measured on the 129-question benchmark in docs/DECISIONS.md section 29 (scripts/eval_hubs.py).

create or replace function own_text_length(t text, keep_contents boolean default false)
returns int
language sql immutable parallel safe
as $$
  select length(btrim(regexp_replace(
           case when keep_contents then coalesce(t, '')
                else regexp_replace(coalesce(t, ''), '[A-Z][^\n.0-9]{1,120}?\s[0-9]{1,3}(?=\s+[A-Z0-9]|\s*$)', ' ', 'g')
           end,
           '\s+', ' ', 'g')));
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
           query_text ~* '\mpages?\M' as asks_page
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
