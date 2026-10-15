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
    <html lang="en">
      {/* Quartz scopes every utility under .quartz, so layout classes go on a div inside the body, never on body or html. */}
      <body className="quartz">
        <QuartzPortalProvider>
          <div className="flex min-h-dvh flex-col">
            <Suspense fallback={<div className="h-(--topbar)" />}>
              <TopNav />
            </Suspense>
            <div className="flex min-h-0 flex-1 flex-col bg-page">
              <main className="flex min-h-0 w-full flex-1 flex-col gap-6 px-(--gutter-sm) py-6 sm:px-(--gutter)">{children}</main>
              <footer className="px-(--gutter-sm) pb-6 type-body-sm text-text-3 sm:px-(--gutter)">
                Developed by <a href="https://beny.one" target="_blank" rel="noreferrer" className="text-text-2 underline decoration-1 underline-offset-4 hover:text-text-1">Beny Dishon K</a> as a demo for Quescenta.
              </footer>
            </div>
          </div>
        </QuartzPortalProvider>
      </body>
    </html>
  );
}
