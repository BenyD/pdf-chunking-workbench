import { Suspense } from "react";
import { SearchView } from "@/components/SearchView";

export default function SearchPage() {
  return (
    <Suspense fallback={<p className="text-sm text-zinc-500">Loading…</p>}>
      <SearchView />
    </Suspense>
  );
}
