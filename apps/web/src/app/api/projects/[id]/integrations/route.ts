import { NextResponse } from "next/server";
import {
  INTEGRATION_TYPES,
  gmailIntegrationConfigSchema,
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
export const PUT = apiHandler(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser();
  await requireProjectAccess(user.id, id);
  const input = await parseBody(request, upsertIntegrationSchema);

  const configSchema =
    input.type === "slack"
      ? slackIntegrationConfigSchema
      : gmailIntegrationConfigSchema;
  const parsedConfig = configSchema.safeParse(input.config);
  if (!parsedConfig.success) {
    return jsonError(
      400,
      `Invalid ${input.type} config: ${
        parsedConfig.error.errors[0]?.message ?? "invalid"
      }`,
    );
  }

  const admin = getAdminClient();
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
