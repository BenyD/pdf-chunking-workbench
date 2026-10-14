import { Suspense } from "react";
import { PageSkeleton } from "@/components/Skeletons";
import { OcrView } from "@/components/OcrView";

export const metadata = { title: "Zonal OCR" };

export default function OcrPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <OcrView />
    </Suspense>
  );
}
