import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Forms stays out of sight unless NEXT_PUBLIC_FORMS=1: its addresses go to Documents. The top bar reads the same flag.
  // Page images, figure crops and uploads go through this site, not to supabase.co from the browser: some Indian
  // networks block supabase.co outright (connection reset), which left every page image blank there. The server
  // side reaches it fine, so the browser asks /storage/... here and Vercel fetches it.
  async rewrites() {
    return [{ source: "/storage/:path*", destination: `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/:path*` }];
  },
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
