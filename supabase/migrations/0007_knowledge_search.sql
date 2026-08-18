-- 0007: full-text search over the knowledge base.
--
-- Knowledge reaches agents by injection today: every project doc plus the
-- agent's own docs are prepended to its system prompt on every run and every
-- chat turn. That cost is O(all docs) per run and grows with the knowledge
-- base. This migration adds the retrieval half — agents can search for a fact
-- they do not have instead of carrying every fact they might need.
--
-- Authorization note: RLS is not used (see 0002); the default-privilege
-- revokes there cover the objects below.

-- A stored generated column, so the index stays correct without triggers.
-- Config 'simple' rather than 'english': docs here are written in whatever
-- language the team uses, and 'simple' does not stem the wrong language into
-- nonsense. The cost is no stemming at all, which the tool compensates for
-- with an ILIKE fallback when the tsquery finds nothing.
alter table public.agent_knowledge
  add column search_vector tsvector
  generated always as (
    to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(content, ''))
  ) stored;

create index agent_knowledge_search_idx
  on public.agent_knowledge
  using gin (search_vector);
