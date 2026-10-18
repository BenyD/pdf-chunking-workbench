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
    // The app is about how documents are cut and searched: Compare and SOP check were taken out (2026-10-18); their
    // old addresses go to Documents. The benchmark and the SOP check live on as scripts and in docs/DECISIONS.md.
    const gone = [{ source: "/compare", destination: "/", permanent: false }, { source: "/sop-check", destination: "/", permanent: false }];
    if (process.env.NEXT_PUBLIC_FORMS === "1") return gone;
    return [...gone, { source: "/forms/:path*", destination: "/", permanent: false }];
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
