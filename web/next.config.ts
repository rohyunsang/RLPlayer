import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  trailingSlash: false,
  reactStrictMode: true,
  // Pin the workspace root: a sibling lockfile at the repo root otherwise wins.
  turbopack: { root: path.resolve(__dirname) },
};

export default nextConfig;
