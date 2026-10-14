import { Suspense } from "react";
import { SkeletonText } from "@/components/quartz/ui/skeleton";
import { SearchView } from "@/components/SearchView";

export const metadata = { title: "Search" };

export default function SearchPage() {
  return (
    <Suspense fallback={<div className="flex flex-col gap-2"><SkeletonText type="heading-lg" className="w-48" /><SkeletonText type="body" className="w-72" /></div>}>
      <SearchView />
    </Suspense>
  );
}
