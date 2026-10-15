import { Suspense } from "react";
import { FormWizard } from "@/components/FormWizard";
import { SkeletonText } from "@/components/quartz/ui/skeleton";

export const metadata = { title: "New form" };

export default function NewFormPage() {
  return (
    <Suspense fallback={<div className="flex flex-col gap-2"><SkeletonText type="heading-lg" className="w-48" /><SkeletonText type="body" className="w-72" /></div>}>
      <FormWizard />
    </Suspense>
  );
}
