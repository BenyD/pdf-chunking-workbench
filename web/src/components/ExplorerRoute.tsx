"use client";
import { useParams } from "next/navigation";
import { Explorer } from "./Explorer";

/** Reads the document id on the client so the route streams like the other pages. */
export function ExplorerRoute() {
  const { id } = useParams<{ id: string }>();
  return <Explorer id={id} />;
}
