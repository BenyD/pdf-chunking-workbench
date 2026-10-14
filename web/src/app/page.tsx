import { Suspense } from "react";
import { DocumentsHome } from "@/components/DocumentsHome";

export default function Home() {
  return (
    <Suspense fallback={<p className="text-sm text-zinc-500">Loading…</p>}>
      <DocumentsHome />
    </Suspense>
  );
}
