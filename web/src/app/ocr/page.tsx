import { Suspense } from "react";
import { OcrView } from "@/components/OcrView";

export default function OcrPage() {
  return (
    <Suspense fallback={<p className="text-sm text-zinc-500">Loading…</p>}>
      <OcrView />
    </Suspense>
  );
}
