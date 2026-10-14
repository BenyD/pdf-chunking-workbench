import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Suspense } from "react";
import "./globals.css";
import { HeaderProvider } from "@/components/HeaderContext";
import { TopNav } from "@/components/TopNav";
import { TooltipProvider } from "@/components/ui/tooltip";

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
      <body className="flex min-h-full flex-col">
        <TooltipProvider>
          <HeaderProvider>
            <Suspense fallback={<div className="h-16" />}>
              <TopNav />
            </Suspense>
            <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-4 sm:px-6 sm:py-6">{children}</main>
          </HeaderProvider>
        </TooltipProvider>
      </body>
    </html>
  );
}
