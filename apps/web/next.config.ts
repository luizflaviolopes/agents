import type { NextConfig } from "next";
import { config } from "dotenv";
import path from "node:path";

// Single source of truth: the monorepo root .env (worker loads it the same way).
config({ path: path.resolve(__dirname, "../../.env") });

const nextConfig: NextConfig = {
  transpilePackages: ["@agent-fleet/shared"],
};

export default nextConfig;
