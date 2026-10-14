import { DocsView } from "@/components/DocsView";
import { PageHeader } from "@/components/PageHeader";
import { DOCUMENTATION_MD } from "@/content/documentation";

export const metadata = { title: "Documentation" };

export default function DocsPage() {
  return (
    <>
      <PageHeader title="Documentation" subtitle="How each page works and what the numbers mean." />
      <DocsView markdown={DOCUMENTATION_MD.replace(/^# .*\n+/, "")} />
    </>
  );
}
