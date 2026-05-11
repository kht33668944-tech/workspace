import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  output: "standalone",
  serverExternalPackages: ["playwright", "playwright-core", "patchright", "patchright-core", "sharp", "tesseract.js"],
  compress: true,
};

export default nextConfig;
