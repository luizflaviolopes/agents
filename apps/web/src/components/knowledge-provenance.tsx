import type { AgentKnowledgeRow } from "@agent-fleet/shared";
import { timeAgo } from "@/lib/format";

/**
 * Knowledge doc + the provenance agent names joined in by the knowledge API
 * routes (created_by/updated_by resolve the *_agent_id columns).
 */
export interface KnowledgeDocJoined extends AgentKnowledgeRow {
  created_by: { name: string } | null;
  updated_by: { name: string } | null;
}

/**
 * One-line provenance for a knowledge doc: which agent wrote/edited it, or
 * "You" when it is human-authored (all provenance columns null — a human
 * edit also nulls out updated_by_agent_id).
 */
export function ProvenanceLine({ doc }: { doc: KnowledgeDocJoined }) {
  let line: string;
  if (doc.updated_by_agent_id) {
    line = `Edited by ${doc.updated_by?.name ?? "an agent"} · ${timeAgo(doc.updated_at)}`;
  } else if (doc.created_by_agent_id) {
    line = `Added by ${doc.created_by?.name ?? "an agent"} · ${timeAgo(doc.created_at)}`;
  } else {
    line = `You · updated ${timeAgo(doc.updated_at)}`;
  }
  return <p className="truncate text-xs text-muted-foreground">{line}</p>;
}
