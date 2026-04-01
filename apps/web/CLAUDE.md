# Kery Web — Design Language

## Aesthetic

Calm developer tool. Pale sage green surfaces in light mode, deep forest sage in dark mode. Muted terracotta/amber accent (the mango brand) pops against the sage. Dense but breathable, keyboard-first, subtle animations. Inspired by Claude.ai's restraint applied to a dev tool context.

## Imports

Always use `@/` path aliases: `@/components/ui/button`, `@/lib/utils`, `@/pages/Overview`, etc.

## Colors

OKLCH-based. Light mode: pale sage (hue ~148, very low chroma). Dark mode: deep forest sage (same hue, low lightness). Never use raw hex/rgb — use CSS variables or Tailwind tokens.

- **Accent**: muted terracotta (`--primary`). Used for active states, focus rings, primary buttons. Not saturated amber — deliberately quiet.
- **Status**: all muted pastels — sage green, brick red, soft periwinkle, straw yellow. Available as `bg-status-pass`, `text-status-pass`, etc.
- **Elevation**: `surface-1` → `surface-2` → `surface-3`, stepping in brightness. Use `bg-surface-2` on cards, `bg-surface-3` for raised panels.

## Icons

- **Library**: [Phosphor Icons](https://phosphoricons.com/) (`@phosphor-icons/react`) — consistent stroke, multiple weights (`weight` prop), large catalog.
- **Import**: named imports, e.g. `import { Pulse, Gear } from "@phosphor-icons/react"`.
- **Sizing**: match existing patterns — `className="h-4 w-4"` on icons; spinners use `animate-spin` where needed.
- **Types**: use `import type { Icon } from "@phosphor-icons/react"` when storing icon components (e.g. config arrays).

## Typography

| Role | Size | Weight | Class |
|------|------|--------|-------|
| Page title | 20px | 600 | `text-xl font-semibold` |
| Section heading | 14px | 500 | `text-[14px] font-medium` |
| Body text | 13px | 400 | `text-[13px]` |
| Labels / captions | 11px | 500 | `text-[11px] font-medium` |
| Uppercase labels | 11px | 500 | `text-[11px] font-medium uppercase tracking-wider` |
| Code / IDs / durations / URLs / costs | 12-13px | 400 | `font-mono text-[13px]` |

- **UI font**: Ubuntu (loaded via Google Fonts) — warm, rounded, highly legible
- **Display font**: Space Grotesk (`font-display`) — used for page titles (`PageHeader`), nav wordmark "Kery", and section headings that need character
- **Monospace**: Fira Code → Fira Mono → Ubuntu Mono → Menlo → Consolas. Use `font-mono` for code blocks, IDs, routes, costs, timestamps. Use `mono-ui` class for compact ID/slug fields.
- Fira Code ligatures are enabled by default (`liga`, `calt` feature settings)

## Component Library

All in `@/components/ui/`. Radix-backed where noted.

| Component | Import | Key props |
|-----------|--------|-----------|
| `Button` | `@/components/ui/button` | `variant`: default/secondary/outline/ghost/destructive/link. `size`: sm/md/lg/icon/icon-sm. `loading`, `asChild`. |
| `Badge` | `@/components/ui/badge` | `variant`: default/secondary/destructive/outline/success/warning/neutral/running. `dot` for status dot. |
| `Input` | `@/components/ui/input` | h-8, transparent bg. |
| `Textarea` | `@/components/ui/textarea` | min-h-[72px], transparent bg. |
| `Select` | `@/components/ui/select` | Native `<select>` wrapper with chevron. h-8. |
| `Card` | `@/components/ui/card` | `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`. p-4 padding. |
| `Tabs` | `@/components/ui/tabs` | Radix. `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent`. Use `value`/`onValueChange`. Underline style. |
| `Dialog` | `@/components/ui/dialog` | Radix. `Dialog`, `DialogTrigger`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogFooter`, `DialogClose`. |
| `DropdownMenu` | `@/components/ui/dropdown-menu` | Radix. `DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuContent`, `DropdownMenuItem`, `DropdownMenuSeparator`, `DropdownMenuLabel`. |
| `Tooltip` | `@/components/ui/tooltip` | Radix. `Tooltip`, `TooltipTrigger`, `TooltipContent`. Wrap app in `TooltipProvider`. |
| `ScrollArea` | `@/components/ui/scroll-area` | Radix. Custom thin scrollbar. |
| `Separator` | `@/components/ui/separator` | Radix. `h-px` horizontal or `w-px` vertical. |
| `Switch` | `@/components/ui/switch` | Radix. Use `checked`/`onCheckedChange`. |
| `Skeleton` | `@/components/ui/skeleton` | Shimmer loading. Size via className. |
| `Kbd` | `@/components/ui/kbd` | Keyboard shortcut display. |
| `Table` | `@/components/ui/table` | `Table`, `TableHeader`, `TableBody`, `TableRow`, `TableHead`, `TableCell`. h-8 headers, 11px uppercase. |
| `Toaster` | `@/components/ui/sonner` | Mount once in main.tsx. Use `toast()` from `sonner` to trigger. |

## Shared Components

| Component | Import | Props |
|-----------|--------|-------|
| `PageHeader` | `@/components/page-header` | `icon`, `title`, `description?`, `children` (action buttons in header). h-12 bar with border-b. |
| `StatusDot` | `@/components/status-dot` | `status` string (passed/failed/running/clean/issues/stale). Auto-pulses for running/queued. |
| `KpiCard` | `@/components/kpi-card` | `label`, `value`, `suffix?`, `icon?`. Use in grid rows. |
| `EmptyState` | `@/components/empty-state` | `icon?`, `title`, `description?`, `action?` ({label, onClick}). Centered py-16. |
| `CommandPalette` | `@/components/command-palette` | `open`, `onOpenChange`. Mounted in AppShell, triggered by Cmd+K. |

## Shared Utilities

| Function | Import | Returns |
|----------|--------|---------|
| `cn()` | `@/lib/utils` | Merged Tailwind classes |
| `statusVariant()` | `@/lib/formatters` | Badge variant for run status |
| `duration()` | `@/lib/formatters` | "2m 30s" from start/end ISO |
| `relativeTime()` | `@/lib/formatters` | "5m ago" from ISO |
| `formatCost()` | `@/lib/formatters` | "$0.0042" or "$1.23" |
| `formatMs()` | `@/lib/formatters` | "142ms" or "1.2s" |
| `formatReportedAt()` | `@/lib/formatters` | Smart date ("5m ago", "yesterday", "Mar 15") |
| `useHotkey()` | `@/lib/hooks` | Register keyboard shortcut. Ignores when in inputs. |
| `useProject()` | `@/lib/projectContext` | `{ projects, currentProjectId, currentProject, setCurrentProjectId, refreshProjects }` |

## Animation Rules

- Micro-interactions: 100-150ms, `ease-out`
- Layout shifts: 200ms, `ease-out`
- Never exceed 300ms
- Use `animate-fade-in` on page content areas
- Use `stagger-item` class on list items for staggered entrance
- Use `dot-pulse` on running status dots
- Always respect `prefers-reduced-motion`

## Page Structure Pattern

```tsx
export function MyPage() {
  return (
    <div className="flex flex-col min-h-full">
      <PageHeader icon={<Icon className="h-4 w-4" />} title="Page Name">
        {/* action buttons */}
      </PageHeader>
      <div className="p-6 animate-fade-in space-y-6">
        {/* content */}
      </div>
    </div>
  );
}
```

## Do / Don't

- **Do** use `font-mono` for IDs, timestamps, durations, costs, URLs, routes
- **Do** use `StatusDot` for any run/health status indicator
- **Do** use `Dialog` for create/edit/delete confirmations (not `window.confirm`)
- **Do** use `Skeleton` for loading states (not spinners)
- **Do** use `EmptyState` when a list has no data
- **Don't** use raw hex/rgb colors — always CSS variables or Tailwind tokens
- **Don't** use box-shadows for elevation — use surface tokens (`bg-surface-2`, etc.)
- **Don't** use cold blue-gray backgrounds — always use warm surface tokens
- **Don't** use emojis in the UI
- **Don't** add animations longer than 300ms
- **Don't** import from relative paths — always use `@/` aliases
