import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Forms stays out of sight unless NEXT_PUBLIC_FORMS=1: its addresses go to Documents. The top bar reads the same flag.
  async redirects() {
    if (process.env.NEXT_PUBLIC_FORMS === "1") return [];
    return [{ source: "/forms/:path*", destination: "/", permanent: false }];
  },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
