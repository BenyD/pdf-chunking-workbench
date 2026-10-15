import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ReadForm } from "@/components/ReadForm";
import { SkeletonText } from "@/components/quartz/ui/skeleton";
import { formsEnabled } from "@/lib/flags";

export const metadata = { title: "Form" };

export default function FormPage() {
  if (!formsEnabled) notFound();
  return (
    <Suspense fallback={<div className="flex flex-col gap-2"><SkeletonText type="heading-lg" className="w-48" /><SkeletonText type="body" className="w-72" /></div>}>
      <ReadForm />
    </Suspense>
  );
}
