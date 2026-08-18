import { NextResponse } from "next/server";
import {
  INTEGRATION_TYPES,
  MCP_INTEGRATION_TYPES,
  gmailIntegrationConfigSchema,
  mcpIntegrationConfigSchema,
  slackIntegrationConfigSchema,
  upsertIntegrationSchema,
} from "@agent-fleet/shared";
import type { IntegrationRow } from "@agent-fleet/shared";
import {
  apiHandler,
  jsonError,
  parseBody,
  requireProjectAccess,
  requireUser,
} from "@/lib/api/auth";
import { getAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * Mask secret values before they leave the server: any config key containing
 * "token" or "secret" (userToken, clientSecret, refreshToken, …) is reduced
 * to its last 4 characters prefixed with '••••'. Full secrets are write-only.
 */
function maskConfig(config: Record<string, unknown>): Record<string, unknown> {
  const masked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (/token|secret/i.test(key)) {
      masked[key] =
        typeof value === "string" && value.length > 0
          ? `••••${value.slice(-4)}`
          : "••••";
    } else {
      masked[key] = value;
    }
  }
  return masked;
}

/**
 * GET /api/projects/[id]/integrations — one entry per integration type with
 * a `configured` flag and the MASKED config. Never returns full secrets.
 */
export const GET = apiHandler(async (_request: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser();
  await requireProjectAccess(user.id, id);
  const admin = getAdminClient();

  const { data: rows, error } = await admin
    .from("integrations")
    .select("*")
    .eq("project_id", id);
  if (error) return jsonError(500, error.message);

  const integrations = INTEGRATION_TYPES.map((type) => {
    const row = ((rows ?? []) as IntegrationRow[]).find((r) => r.type === type);
    return {
      type,
      configured: Boolean(row),
      config: row ? maskConfig(row.config) : {},
      updatedAt: row?.updated_at ?? null,
    };
  });
  return NextResponse.json({ integrations });
});

/**
 * PUT /api/projects/[id]/integrations — upsert the credentials for one
 * integration type (unique per (project_id, type)). The config is validated
 * against the per-type schema; the response only ever contains the masked
 * version.
 */
/**
 * A github/notion integration holds two independent secrets — `writeToken` for
 * approved MCP calls and `cloneToken` for cloning workspace repos — and the
 * form only sends the ones the owner actually typed, because secrets come back
 * masked and cannot be round-tripped. Carry the stored value over for any
 * secret the request omits, so saving one never silently drops the other.
 *
 * Secrets only. Non-secret fields (headerName, envVar, url) keep replace
 * semantics, which is what lets them be cleared.
 */
async function carryOverSecrets(
  admin: ReturnType<typeof getAdminClient>,
  projectId: string,
  type: string,
  config: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { data } = await admin
    .from("integrations")
    .select("config")
    .eq("project_id", projectId)
    .eq("type", type)
    .maybeSingle();

  const prior = ((data as { config?: Record<string, unknown> } | null)?.config ??
    {}) as Record<string, unknown>;
  const merged = { ...config };
  for (const key of ["writeToken", "cloneToken"]) {
    if (!merged[key] && typeof prior[key] === "string") merged[key] = prior[key];
  }
  return merged;
}

export const PUT = apiHandler(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser();
  await requireProjectAccess(user.id, id);
  const input = await parseBody(request, upsertIntegrationSchema);

  const admin = getAdminClient();

  // github/notion share one shape: credentials for the action executor's own
  // MCP connection and for cloning workspace repos, plus where the write token
  // goes (0010).
  const configSchema =
    input.type === "slack"
      ? slackIntegrationConfigSchema
      : input.type === "gmail"
        ? gmailIntegrationConfigSchema
        : mcpIntegrationConfigSchema;

  const config = MCP_INTEGRATION_TYPES.includes(
    input.type as (typeof MCP_INTEGRATION_TYPES)[number],
  )
    ? await carryOverSecrets(admin, id, input.type, input.config)
    : input.config;

  const parsedConfig = configSchema.safeParse(config);
  if (!parsedConfig.success) {
    return jsonError(
      400,
      `Invalid ${input.type} config: ${
        parsedConfig.error.errors[0]?.message ?? "invalid"
      }`,
    );
  }

  const { data: row, error } = await admin
    .from("integrations")
    .upsert(
      { project_id: id, type: input.type, config: parsedConfig.data },
      { onConflict: "project_id,type" },
    )
    .select()
    .single();
  if (error || !row) {
    return jsonError(500, error?.message ?? "Failed to save integration");
  }

  const saved = row as IntegrationRow;
  return NextResponse.json({
    integration: {
      type: saved.type,
      configured: true,
      config: maskConfig(saved.config),
      updatedAt: saved.updated_at,
    },
  });
});
