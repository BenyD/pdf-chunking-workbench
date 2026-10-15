import { notFound } from "next/navigation";
import { FormsHome } from "@/components/FormsHome";
import { formsEnabled } from "@/lib/flags";

export const metadata = { title: "Forms" };

export default function FormsPage() {
  if (!formsEnabled) notFound();
  return <FormsHome />;
}
