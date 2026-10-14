import { Suspense } from "react";
import { PageSkeleton } from "@/components/Skeletons";
import { EvalView } from "@/components/EvalView";

export default function EvalPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <EvalView />
    </Suspense>
  );
}
