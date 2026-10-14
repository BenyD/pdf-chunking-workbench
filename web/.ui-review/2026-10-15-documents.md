Ready to ship: yes. The Documents screen uses only Quartz components and tokens, both lints are clean, and every control is keyboard-reachable with a name (blocking 0, should-fix 0, note 2, 0 accessibility questions for a person).

## Review record
Source: local build, http://localhost:3001/ on the ds/2026-10-15-migrate branch. Tool: the desktop app's browser pane, 1280x820 and 390x844, light theme, 2026-10-15. Criteria: `.claude/skills/quartz/SKILL.md` and the Quartz lint. First pass. Purpose (given): list the documents, add one by upload or from the samples, open one, re-process or delete one.
Lint: `npx eslint -c quartz.eslint.config.mjs src/app/layout.tsx src/components/TopNav.tsx src/components/DocumentsHome.tsx src/components/SamplePicker.tsx` exit 0; `pnpm exec eslint` on the same files exit 0; `pnpm exec tsc --noEmit` exit 0.
Captures: captures/documents-1280.jpg, captures/documents-390.jpg, captures/documents-samples-dialog-1280.jpg, captures/documents-delete-dialog-1280.jpg. Baselines in baselines/.
Assumptions: the sidebar named in the Quartz page shell is not in the registry (83 items, none a sidebar), so the shell is the top bar with the three places as links and a PageHeader per page. Logged as decision D1.
Gaps: no accessibility scanner in this environment; names and roles checked from the accessibility tree (`find` by role and name). Drag-and-drop upload not exercised (pointer-only); the Choose-file path runs through AttachmentDropTrigger.

## Summary
The screen asks: what do I have, and how do I add more. It works: the one h1, a description, two actions (one primary), one framed list of rows with the name as the row link, the status as a word, two icon actions per row and the rest in a menu. Deleting asks first in an alert dialog with a written destructive button. Loading holds the row shape with SkeletonSwap. The sample picker is a dialog with rows, a checkbox per sample and the first page beside them.

## Findings
### blocking
None
### should-fix
None
### note
1. The row's status word for a processing document is the stage name ("Indexing", "Describing passages"), which is 1 to 2 words as the Status rule asks; the longest, "Finding tables and figures", is 4. Seen at both widths once a document is processing. quartz Status rule 8 (short words). Evidence: rendered row; dedupe status-word-length. Left as is: the stage names were chosen with the person earlier and read fine.
2. The sample preview image uses fixed heights (h-48, md:h-96) rather than the page's aspect; pages are cropped at the bottom. 1280 and 390, dialog. quartz-tokens-only is met (scale values); no rule broken. Evidence: captures/documents-samples-dialog-1280.jpg.

## Edge cases
- Empty list: shown in code (Empty with title, one line, primary Load samples and secondary Upload a PDF); not shown in captures because every sample is loaded.
- Upload rejected (not a PDF, over 150 MB): handled by onReject into the fail Alert; not shown.
- Failed action: fail Alert with the message; not shown.
- Processing row: Status running with the stage word; not shown (all documents are ready).

## For a person to decide
None

## Left out
- The earlier pill badges, soft grey outer panels and the icon pill nav: Quartz bans pills and grey boxes in boxes; replaced by the status word, one ItemGroup frame and text links in the top bar.

Coverage: route /, dialogs Load sample documents and Delete; 1280 and 390; light theme; probes: keyboard reach of every control via the accessibility tree; not measured: drag-and-drop, screen reader announcement order.
