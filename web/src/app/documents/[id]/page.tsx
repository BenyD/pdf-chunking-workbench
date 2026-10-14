import { Suspense } from "react";
import { ExplorerRoute } from "@/components/ExplorerRoute";
import { Skeleton } from "@/components/ui/skeleton";

export const metadata = { title: "Document" };

export default function DocumentPage() {
  return (
    <Suspense fallback={<div className="space-y-3"><Skeleton className="h-7 w-1/2" /><Skeleton className="h-24 w-full" /><Skeleton className="h-96 w-full" /></div>}>
      <ExplorerRoute />
    </Suspense>
  );
}
