import { Suspense } from "react";
import { EvalView } from "@/components/EvalView";

export default function EvalPage() {
  return (
    <Suspense fallback={<p className="text-sm text-zinc-500">Loading…</p>}>
      <EvalView />
    </Suspense>
  );
}
