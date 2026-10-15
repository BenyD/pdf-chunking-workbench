"use client";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Icon, Launch } from "@/components/quartz/icon";
import { Button } from "@/components/quartz/ui/button";
import { Checkbox } from "@/components/quartz/ui/checkbox";
import { Dialog, DialogAction, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/quartz/ui/dialog";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemLink, ItemStatus, ItemTitle } from "@/components/quartz/ui/item";
import { SAMPLES } from "@/lib/samples";

const name = (n: string) => n.replace(/\.pdf$/i, "");

/**
 * Pick which sample documents to load. The list keeps to a name and a page count; the one whose name was clicked
 * shows beside it as the whole PDF, every page scrollable, with its description under it.
 */
export function SamplePicker({ open, onOpenChange, loaded, onLoad, initialPreview }: {
  open: boolean; onOpenChange: (open: boolean) => void; loaded: Set<string>; onLoad: (keys: string[]) => Promise<void>;
  /** The sample to show first when the dialog opens. */
  initialPreview?: string | null;
}) {
  const available = useMemo(() => SAMPLES.filter((s) => !loaded.has(s.key)), [loaded]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<string>(SAMPLES[0].key);

  useEffect(() => {
    if (open) { setSelected(new Set(available.map((s) => s.key))); setPreview(initialPreview ?? available[0]?.key ?? SAMPLES[0].key); }
  }, [open, available, initialPreview]);

  const current = SAMPLES.find((s) => s.key === preview) ?? SAMPLES[0];
  // Phones mostly cannot show a PDF inline; they get the first page as a picture and the link to open the file.
  const pdfInline = useSyncExternalStore(() => () => {}, () => navigator.pdfViewerEnabled !== false, () => true);
  const toggle = (key: string) => setSelected((cur) => { const n = new Set(cur); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const pages = (n: number) => `${n} ${n === 1 ? "page" : "pages"}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Load sample documents</DialogTitle>
          <DialogDescription>Tick the ones to load. Click a name to look through it first.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="grid gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <ItemGroup>
              <ul>
                {SAMPLES.map((s) => {
                  const isLoaded = loaded.has(s.key);
                  const shown = preview === s.key;
                  return (
                    <li key={s.key}>
                      <Item selected={shown}>
                        {!isLoaded && <Checkbox className="z-(--z-raised)" checked={selected.has(s.key)} onCheckedChange={() => toggle(s.key)} aria-label={`Load ${name(s.name)}`} />}
                        <ItemContent>
                          <ItemTitle>
                            <ItemLink href={`/samples/${s.file}`} aria-current={shown ? "true" : undefined} onClick={(e) => { e.preventDefault(); setPreview(s.key); }}>{name(s.name)}</ItemLink>
                          </ItemTitle>
                          <ItemDescription>{pages(s.pages)}</ItemDescription>
                        </ItemContent>
                        {isLoaded && <ItemStatus status="ok">Loaded</ItemStatus>}
                      </Item>
                    </li>
                  );
                })}
              </ul>
            </ItemGroup>
            <figure className="flex min-w-0 flex-col gap-2">
              <div className="frame overflow-hidden bg-paper">
                {/* The browser's own PDF view, so every page can be scrolled through before loading anything. */}
                {pdfInline
                  ? <iframe key={current.key} src={`/samples/${current.file}#toolbar=0&navpanes=0&view=FitH`} title={`${name(current.name)}, every page`} className="block h-72 w-full md:h-[60dvh]" />
                  // eslint-disable-next-line @next/next/no-img-element
                  : <img key={current.key} src={`/samples/previews/${current.key}.png`} alt={`First page of ${name(current.name)}`} className="block h-72 w-full object-cover object-top" />}
              </div>
              <figcaption className="flex flex-col gap-2">
                <span className="type-label text-text-1">{name(current.name)}</span>
                <span className="type-body-sm text-text-2">{pages(current.pages)}. {current.blurb}</span>
                <span><Button variant="secondary" size="sm" nativeButton={false} render={<a href={`/samples/${current.file}`} target="_blank" rel="noreferrer" />}><Icon icon={Launch} />Open the PDF</Button></span>
              </figcaption>
            </figure>
          </div>
        </DialogBody>
        <DialogFooter>
          <DialogClose>Cancel</DialogClose>
          <DialogAction disabled={selected.size === 0} pendingLabel="Loading" onAction={async () => { await onLoad([...selected]); }}>
            Load {selected.size} {selected.size === 1 ? "document" : "documents"}
          </DialogAction>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
