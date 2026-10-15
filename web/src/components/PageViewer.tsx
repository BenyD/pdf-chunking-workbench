"use client";
import { useState, type CSSProperties } from "react";
import { ItemLink } from "@/components/quartz/ui/item";
import { Skeleton } from "@/components/quartz/ui/skeleton";
import type { Kind } from "@/lib/quartz/kind";
import { cn } from "@/lib/quartz/utils";
import type { BBox, ChunkType } from "@/lib/types";

/** Each passage type borrows one of the system's kind hues, so a row's label and its box on the page match. */
export const chunkKind: Record<ChunkType, Kind> = { text: "agent", table: "key", table_row: "key", figure: "model", record: "deploy" };
export const typeLabel: Record<ChunkType, string> = { text: "Text", table: "Table", table_row: "Table row", figure: "Figure", record: "Form" };

/** How many more times a page image is requested after a failed load. */
const RETRIES = 3;

export interface Overlay { id: string; type: ChunkType; box: BBox; label: string; selected?: boolean }

/**
 * A rendered page with the passages drawn on it. Boxes are fractions of the page, so percentages place
 * them at any width. Quartz has no hotspot component; each box is a kind-lined region holding a stretched
 * ItemLink to the selected passage, which brings the focus ring, the name and the keyboard press.
 */
export function PageViewer({ imageUrl, alt, overlays, onSelect, className, fill }: {
  imageUrl: string; alt: string; overlays: Overlay[]; onSelect?: (id: string) => void; className?: string;
  /** Fill a parent that already has the page's aspect ratio, and load the image only when it nears the view. */
  fill?: boolean;
}) {
  const [loaded, setLoaded] = useState(false);
  // Storage drops a connection now and then; the image is asked for again a few times before giving up.
  const [attempt, setAttempt] = useState(0);
  const gaveUp = attempt >= RETRIES;
  const src = attempt ? `${imageUrl}${imageUrl.includes("?") ? "&" : "?"}retry=${attempt}` : imageUrl;
  const onError = () => { if (!gaveUp) setTimeout(() => setAttempt((n) => n + 1), 600 * (attempt + 1)); };
  // SkeletonSwap renders only its fallback while loading, which would keep the image out of the DOM and
  // it would never load; so the image is always mounted and a Skeleton covers it until it has.
  return (
    <div className={cn("frame relative bg-paper select-none", fill ? "h-full" : "min-h-96", className)}>
      {!loaded && !gaveUp && <Skeleton className="absolute inset-0" />}
      {!loaded && gaveUp && <p className="absolute inset-0 flex items-center justify-center p-4 text-center type-body-sm text-text-3">The page image did not load. Reload to try again.</p>}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} loading={fill ? "lazy" : undefined} decoding="async" className={cn("block h-full w-full", !loaded && "invisible")} draggable={false} onLoad={() => setLoaded(true)} onError={onError} />
      {loaded && overlays.map((o) => (
        <div
          key={o.id}
          data-kind={chunkKind[o.type]}
          className={cn("absolute top-(--y) left-(--x) h-(--h) w-(--w) border border-accent-mark", o.selected && "border-2 bg-accent-wash/50")}
          style={{ "--x": `${o.box.x0 * 100}%`, "--y": `${o.box.y0 * 100}%`, "--w": `${(o.box.x1 - o.box.x0) * 100}%`, "--h": `${(o.box.y1 - o.box.y0) * 100}%` } as CSSProperties}
        >
          <ItemLink href="#passage" aria-label={o.label} aria-current={o.selected ? "true" : undefined} onClick={(e) => { e.preventDefault(); onSelect?.(o.id); }} />
        </div>
      ))}
    </div>
  );
}
