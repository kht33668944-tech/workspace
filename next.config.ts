import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  output: "standalone",
  serverExternalPackages: ["playwright", "playwright-core", "patchright", "patchright-core", "sharp", "tesseract.js"],
  compress: true,
  outputFileTracingIncludes: {
    "/api/coupang-price-inventory/export": ["./lib/templates/*.xlsx"],
    "/api/esm-price-inventory/export": ["./lib/templates/*.xlsx"],
    "/api/smartstore-price-inventory/export": ["./lib/templates/*.xlsx"],
  },
};

export default nextConfig;
