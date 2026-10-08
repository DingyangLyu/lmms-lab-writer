import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";
const internalHost = process.env.TAURI_DEV_HOST || "localhost";

const nextConfig: NextConfig = {
  output: "export",
  images: {
    unoptimized: true,
  },
  transpilePackages: ["@lmms-lab/latex-editor", "@lmms-lab/writer-shared", "@lmms-lab/writing"],
  assetPrefix: isProd ? undefined : `http://${internalHost}:3000`,
  productionBrowserSourceMaps: false,
};

export default nextConfig;
