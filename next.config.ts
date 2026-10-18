import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep the dev badge out of the bottom-left corner, where the sidebar footer sits.
  devIndicators: { position: "bottom-right" },
};

export default nextConfig;
