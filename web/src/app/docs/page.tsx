import { DocsView } from "@/components/DocsView";
import { DOCUMENTATION_MD } from "@/content/documentation";

export const metadata = { title: "Documentation" };

export default function DocsPage() {
  return <DocsView markdown={DOCUMENTATION_MD} />;
}
