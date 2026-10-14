import { Suspense } from "react";
import { ExplorerRoute } from "@/components/ExplorerRoute";
import { SkeletonText } from "@/components/quartz/ui/skeleton";

export const metadata = { title: "Document" };

export default function DocumentPage() {
  return (
    <Suspense fallback={<div className="flex flex-col gap-2"><SkeletonText type="heading-lg" className="w-72" /><SkeletonText type="body" className="w-24" /></div>}>
      <ExplorerRoute />
    </Suspense>
  );
}
