-- The comparison that justifies the pipeline. The same documents are chunked
-- the ways Amazon Bedrock Knowledge Bases offers (fixed-size, semantic,
-- hierarchical) and by our own chunker with every model call off, and each set
-- is scored on the same questions with the same search. Hierarchical parents
-- are stored as hier_parent and never embedded: search runs over the children
-- and hands back their parent, as Bedrock does. The live app reads only
-- 'contextual'; nothing here changes what it shows.
alter table chunks drop constraint if exists chunks_strategy_check;
alter table chunks add constraint chunks_strategy_check
  check (strategy in ('naive', 'structural', 'contextual', 'fixed', 'semantic', 'hierarchical', 'hier_parent'));
