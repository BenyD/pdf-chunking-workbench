import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import "./globals.css";
import "@/components/quartz/styles.css";
import { TopNav } from "@/components/TopNav";
import { QuartzPortalProvider } from "@/lib/quartz/portal";

export const metadata: Metadata = {
  title: { default: "Documents", template: "%s" },
  description: "Layout-aware PDF chunking, hybrid search and zonal OCR",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#f5f7fb" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full">
      <body className="quartz flex min-h-full flex-col">
        <QuartzPortalProvider>
          <Suspense fallback={<div className="h-(--topbar)" />}>
            <TopNav />
          </Suspense>
          <div className="flex min-h-0 flex-1 flex-col bg-page">
            <main className="mx-auto flex min-h-0 w-full max-w-(--container) flex-1 flex-col gap-6 px-(--gutter-sm) py-6 sm:px-(--gutter)">{children}</main>
          </div>
        </QuartzPortalProvider>
      </body>
    </html>
  );
}
