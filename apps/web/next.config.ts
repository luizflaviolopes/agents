import type { NextConfig } from "next";
import { config } from "dotenv";
import path from "node:path";

// Single source of truth: the monorepo root .env (worker loads it the same way).
config({ path: path.resolve(__dirname, "../../.env") });

const nextConfig: NextConfig = {
  transpilePackages: ["@agent-fleet/shared"],
  // Inline the public Supabase vars into every compiled bundle (including the
  // middleware), since they come from the monorepo root .env rather than a
  // local env file Next.js discovers on its own.
  env: {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
  },
};

export default nextConfig;
