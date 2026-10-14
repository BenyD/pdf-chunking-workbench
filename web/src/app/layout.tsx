import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Suspense } from "react";
import "./globals.css";
import "@/components/quartz/styles.css";
import { TopNav } from "@/components/TopNav";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QuartzPortalProvider } from "@/lib/quartz/portal";

const inter = Inter({ variable: "--font-sans", subsets: ["latin"] });
const mono = JetBrains_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "Documents", template: "%s" },
  description: "Layout-aware PDF chunking, hybrid search and zonal OCR",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#f5f7fb" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable} h-full antialiased`}>
      <body className="quartz flex min-h-full flex-col">
        <QuartzPortalProvider>
        <TooltipProvider>
          <Suspense fallback={<div className="h-(--topbar)" />}>
            <TopNav />
          </Suspense>
          <main className="mx-auto flex min-h-0 w-full max-w-(--container) flex-1 flex-col gap-6 px-(--gutter-sm) py-6 sm:px-(--gutter)">{children}</main>
        </TooltipProvider>
        </QuartzPortalProvider>
      </body>
    </html>
  );
}
