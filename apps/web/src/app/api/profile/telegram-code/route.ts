import { randomInt } from "node:crypto";
import { NextResponse } from "next/server";
import { apiHandler, jsonError, requireUser } from "@/lib/api/auth";
import { getAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Unambiguous alphabet (no 0/O, 1/I) for link codes. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomLinkCode(): string {
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * POST /api/profile/telegram-code — generate and store a fresh 6-char
 * Telegram link code on the user's profile. Returns `{ code }`.
 */
export const POST = apiHandler(async () => {
  const user = await requireUser();
  const admin = getAdminClient();

  const code = randomLinkCode();
  const { error } = await admin
    .from("profiles")
    .update({ telegram_link_code: code })
    .eq("id", user.id);
  if (error) return jsonError(500, error.message);
  return NextResponse.json({ code });
});
