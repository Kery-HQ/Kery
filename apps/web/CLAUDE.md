# Kery Web — Design Language

## Aesthetic

Flat developer tool with a warm, Claude-inspired palette. Light mode: warm cream surfaces with a barely-perceptible warm tint throughout. Dark mode: very dark warm charcoal (not pure black). Yellow-gold accent (Kery brand). No glass effects, no decorative gradients, no shadows for elevation. Dense but breathable, keyboard-first, subtle animations.

## Imports

Always use `@/` path aliases: `@/components/ui/button`, `@/lib/utils`, `@/pages/Overview`, etc.

## Colors

OKLCH-based. Light mode: warm cream base (hue ~80, very low chroma). Dark mode: warm near-black (same hue family). The warm tint is subtle — every surface carries it. Never use raw hex/rgb — use CSS variables or Tailwind tokens.

- **Accent**: Kery yellow-gold (`--primary`, hue 82). Used for active states, focus rings, primary buttons. Dark text on yellow (`--primary-foreground`).
- **Sidebar**: noticeably sandier/darker than the main background in light mode; darker than background in dark mode (like Claude).
- **Status**: semantic colors — `bg-status-pass`, `text-status-pass`, etc.
- **Elevation**: `surface-1` → `surface-2` → `surface-3`, stepping in warmth/lightness. Use `bg-surface-2` on cards, `bg-surface-3` for raised panels. Prefer `bg-card border` over surface tokens for cards.

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

- **UI font**: Plus Jakarta Sans (`font-sans`) — humanist, warm, great at UI sizes.
- **Serif**: Lora (`font-serif`) — available for prose/marketing contexts if needed.
- **Monospace**: Roboto Mono (`font-mono`) — clean, readable. Use for code blocks, IDs, routes, costs, timestamps. Use `mono-ui` class for compact ID/slug fields.

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
- Layout shifts: 150-200ms, `ease-out`
- Never exceed 250ms
- Use `animate-fade-in` on page content areas
- Use `stagger-item` class on list items for staggered entrance
- Use `dot-pulse` on running status dots
- Always respect `prefers-reduced-motion`

## Surface System

The glass utility classes still exist in globals.css but are now flat-rendered. Use them normally — they render as simple bordered surfaces:

- `.liquid-glass` — `bg-card border` — for cards, panels
- `.liquid-glass-strong` — `bg-sidebar border` — for sidebar, header
- `.glass-card-flat` — bordered card with hover border highlight
- `.glass-row` — list rows with muted hover background
- `.glass-stage` — transparent wrapper (no visual styling)
- `.glass-divider` — uses `--border` color
- `.liquid-glow-hover` — subtle border-color transition on hover

Prefer `bg-card border rounded-lg` over `.liquid-glass` for new components — it's more explicit.

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
- **Do** use `bg-card border rounded-lg` for cards and panels
- **Don't** use raw hex/rgb colors — always CSS variables or Tailwind tokens
- **Don't** use `backdrop-filter` / blur effects anywhere
- **Don't** use box-shadows for elevation — use border + surface tokens
- **Don't** use warm/tinted backgrounds — always neutral surface tokens
- **Don't** use `font-display` — it maps to Inter, same as sans. Just use `font-semibold`.
- **Don't** use emojis in the UI
- **Don't** add animations longer than 250ms
- **Don't** import from relative paths — always use `@/` aliases
