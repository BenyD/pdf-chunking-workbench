import { Suspense } from "react";
import { SkeletonText } from "@/components/quartz/ui/skeleton";
import { OcrView } from "@/components/OcrView";

export const metadata = { title: "Forms" };

export default function OcrPage() {
  return (
    <Suspense fallback={<div className="flex flex-col gap-2"><SkeletonText type="heading-lg" className="w-48" /><SkeletonText type="body" className="w-72" /></div>}>
      <OcrView />
    </Suspense>
  );
}
