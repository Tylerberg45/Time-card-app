import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [],
  typescript: { tsconfigPath: "tsconfig.railway.json" },
};

export default nextConfig;
