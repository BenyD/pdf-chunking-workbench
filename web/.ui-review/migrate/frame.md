# Migration frame: Quartz (design.how), 2026-10-15

Target system: Quartz from https://design.how/systems/quartz, installed with
`npx shadcn add https://design.how/r/quartz/theme.json` on 2026-10-15 (registry
items as served that day; no version field in the registry).
Criteria: `.claude/skills/quartz/SKILL.md` (global rules, page shell, anti-slop)
and the Quartz lint (`quartz.eslint.config.mjs`).
Mode: full, on the person's ask ("use this design system", with the design.how
setup prompt pasted in full).
Scope: every screen of the web app: Documents (with the sample picker dialog),
Document view, Search, Forms. Shared layer: root layout, top bar, nav.
Pilot: Documents, the screen the person complained about most during the build.
Budget: this session.
Widths and themes: 390 and 1280, light only (the app ships no dark theme).
Parity: mapped. Quartz tokens replace the previous palette; behaviour and copy
stay as they are.
Run branch: ds/2026-10-15-migrate. One commit per verified surface.
Baseline lint: 304 errors, 2 warnings from the Quartz lint on the pre-migration code.
Workers: this host runs one agent; phases run in sequence and are self-verified
with the lint, a render at both widths and the rule walk from ui-review.
