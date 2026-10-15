import { Suspense } from "react";
import { ReadForm } from "@/components/ReadForm";
import { SkeletonText } from "@/components/quartz/ui/skeleton";

export const metadata = { title: "Form" };

export default function FormPage() {
  return (
    <Suspense fallback={<div className="flex flex-col gap-2"><SkeletonText type="heading-lg" className="w-48" /><SkeletonText type="body" className="w-72" /></div>}>
      <ReadForm />
    </Suspense>
  );
}
