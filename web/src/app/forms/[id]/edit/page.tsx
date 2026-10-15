import { notFound } from "next/navigation";
import { Suspense } from "react";
import { FormWizard } from "@/components/FormWizard";
import { SkeletonText } from "@/components/quartz/ui/skeleton";
import { formsEnabled } from "@/lib/flags";

export const metadata = { title: "Edit form" };

export default function EditFormPage() {
  if (!formsEnabled) notFound();
  return (
    <Suspense fallback={<div className="flex flex-col gap-2"><SkeletonText type="heading-lg" className="w-48" /><SkeletonText type="body" className="w-72" /></div>}>
      <FormWizard />
    </Suspense>
  );
}
