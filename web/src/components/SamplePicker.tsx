"use client";
import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SAMPLES } from "@/lib/samples";
import { cn } from "@/lib/utils";

/** Pick which sample documents to load, with a first-page preview of the selected one. */
export function SamplePicker({ open, onOpenChange, loaded, onLoad }: {
  open: boolean; onOpenChange: (open: boolean) => void; loaded: Set<string>; onLoad: (keys: string[]) => Promise<void>;
}) {
  const available = useMemo(() => SAMPLES.filter((s) => !loaded.has(s.key)), [loaded]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<string>(SAMPLES[0].key);
  const [busy, setBusy] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);

  useEffect(() => { if (open) { setSelected(new Set(available.map((s) => s.key))); setPreview(available[0]?.key ?? SAMPLES[0].key); } }, [open, available]);
  useEffect(() => { setImgLoaded(false); }, [preview]);

  const current = SAMPLES.find((s) => s.key === preview) ?? SAMPLES[0];
  const toggle = (key: string) => setSelected((cur) => { const n = new Set(cur); if (n.has(key)) n.delete(key); else n.add(key); return n; });

  async function load() {
    setBusy(true);
    try { await onLoad([...selected]); onOpenChange(false); } finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] w-[calc(100vw-1.5rem)] max-w-[calc(100vw-1.5rem)] overflow-x-hidden overflow-y-auto sm:w-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Sample documents</DialogTitle>
          <DialogDescription>Choose what to load. Each one is processed in the background and appears in the library as it finishes.</DialogDescription>
        </DialogHeader>
        <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <ul className="order-2 min-w-0 divide-y rounded-[1.25rem] bg-muted/60 md:order-1">
            {SAMPLES.map((s) => {
              const isLoaded = loaded.has(s.key);
              const checked = selected.has(s.key);
              return (
                <li key={s.key} className={cn("flex cursor-pointer items-start gap-3 px-3 py-2.5 text-sm transition-colors hover:bg-muted/50", preview === s.key && "bg-primary/5")} onClick={() => setPreview(s.key)}>
                  {isLoaded ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" /> : (
                    <Checkbox className="mt-0.5" checked={checked} onCheckedChange={() => toggle(s.key)} onClick={(e) => e.stopPropagation()} aria-label={`select ${s.name}`} />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2"><span className="truncate font-medium">{s.name.replace(".pdf", "")}</span><span className="shrink-0 text-xs text-muted-foreground">{s.pages} {s.pages === 1 ? "page" : "pages"}</span></div>
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{s.blurb}</p>
                    {isLoaded && <span className="text-[11px] text-emerald-700">Already loaded</span>}
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="order-1 min-w-0 md:order-2">
            <div className="relative h-48 w-full overflow-hidden rounded-[1.25rem] bg-white ring-1 ring-black/5 sm:h-64 md:h-auto md:aspect-[1/1.3]">
              {!imgLoaded && <div className="absolute inset-0 animate-pulse bg-muted" />}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img key={current.key} src={`/samples/previews/${current.key}.png`} alt={`first page of ${current.name}`} onLoad={() => setImgLoaded(true)} className={cn("block h-full w-full object-cover object-top transition-opacity", imgLoaded ? "opacity-100" : "opacity-0")} />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">First page of {current.name.replace(".pdf", "")}</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={load} disabled={busy || selected.size === 0}>{busy ? <Loader2 className="animate-spin" data-icon="inline-start" /> : null}Load {selected.size} {selected.size === 1 ? "document" : "documents"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
