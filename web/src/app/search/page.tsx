import { Suspense } from "react";
import { PageSkeleton } from "@/components/Skeletons";
import { SearchView } from "@/components/SearchView";

export default function SearchPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <SearchView />
    </Suspense>
  );
}
