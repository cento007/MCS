# TDS 06 — Wireframes & Design System (WS5)

- **Status:** **Final** — `ui-ux-designer` critique pass incorporated 2026-08-11 (see §8.3); ready for WS7 constraint audit
- **Owner:** WS5 / ui-designer
- **Date:** 2026-08-11
- **Inputs:** `docs/tds/01-foundation-decisions.md` (Foundation Contract — consumes F2.1, F4, F5.4, F5.6, F7, F9 verbatim), `Requirements.md` (PRD v2.1 — §4.1–4.4, §8, §9, §14), `docs/project-plan.md` (WS5 row), `docs/tds/02-service-architecture-and-deployment.md` (WS1 §4.3 launch queueing, §5.1 interrupt/cold-pause semantics, §5.2 observed-session applicability, §6.3 fidelity degradation, §7.2 worker heartbeats), `docs/tds/05-frontend-architecture.md` (WS4 §5.1 connection status, §6 live chat model, §7 Settings behavior — reconciled bidirectionally in this pass)
- **Consumers:** WS4 (frontend architecture — token names and component inventory are the handoff surface), WS2 (screens reference API surfaces conceptually only), WS7 (constraint audit)

This document contains (1) the design-system foundations — semantic tokens, type scale, spacing, and a component inventory expressed as CSS-variable-style tokens that WS4 can consume directly — and (2) low-fidelity ASCII wireframes with interaction notes for every Phase 1–2 screen. Phase 3–5 screens appear as placeholder shells only, marked with the F9.3 callout. Vocabulary discipline per F9.5: entity names per F4.1, session states per F7 (lowercase: `created`, `running`, `paused`, `completed`, `failed`, `archived`), event names per F6 — verbatim, no synonyms.

**Non-goals:** no component code, no React/Tailwind implementation detail (WS4), no endpoint shapes (WS2), no new entity or state names.

---

## 1. Design Principles (per PRD §14)

All decisions below serve five principles: **fast, minimal, operator-focused, dark mode first, mobile-friendly monitoring.**

Practical interpretation used throughout:

| Principle | Design consequence |
|---|---|
| Fast | Skeleton loading, optimistic UI where safe, no blocking spinners on navigation, dense tables over card grids for lists |
| Minimal | One accent color; grayscale + semantic status colors carry all other meaning; no decorative imagery; minimal wordmark only |
| Operator-focused | Compact line heights, monospace for identifiers/paths/costs/logs, keyboard-first workflows, persistent state visibility (session-state dots everywhere a Session appears) |
| Dark mode first | Tokens are authored dark-first; elevation expressed by lighter surfaces + borders, not shadows; a light mapping is a later re-skin of the same semantic tokens (WS4 owns theme switching mechanics; PRD §4.4.1 theme setting defaults to dark) |
| Mobile-friendly monitoring | Mobile targets *monitoring* (read state, read stream, pause/end, acknowledge), not authoring. Full editing flows (Settings forms, ADR editing) are desktop-first and merely usable on mobile |

---

## 2. Design System Foundations

### 2.1 Color tokens (dark-first, semantic)

Values are the canonical dark theme. WS4 maps these to CSS custom properties verbatim; components reference only semantic tokens, never raw hex.

#### 2.1.1 Background layers

Elevation model: three layers plus an inset. Higher = lighter. No drop shadows on dark surfaces; separation comes from background delta + 1px border.

```css
--mc-bg-app:      #0D1117;   /* page background, layer 0 */
--mc-bg-surface:  #151B23;   /* cards, panels, sidebar, table headers — layer 1 */
--mc-bg-raised:   #1C232D;   /* modals, popovers, dropdowns, toasts — layer 2 */
--mc-bg-inset:    #0A0E14;   /* code blocks, tool-call I/O, terminal-style areas */
--mc-bg-overlay:  rgba(1, 4, 9, 0.72);  /* modal scrim */
--mc-bg-hover:    rgba(177, 186, 196, 0.08);  /* row/list hover wash, any layer */
--mc-bg-selected: rgba(77, 159, 255, 0.12);   /* selected row/tab wash */
```

#### 2.1.2 Borders and focus

```css
--mc-border:        #2B3340;  /* default hairline: cards, tables, inputs */
--mc-border-strong: #3D4654;  /* hover state on interactive borders, dividers needing emphasis */
--mc-border-focus:  var(--mc-accent);  /* focus ring color, see §7 */
```

#### 2.1.3 Text hierarchy

```css
--mc-text-primary:   #E6EDF3;  /* headings, body, values          — ≥12:1 on all layers   */
--mc-text-secondary: #A0ABBB;  /* labels, metadata, table headers — ≥6:1 on all layers    */
--mc-text-muted:     #838D9C;  /* hints, placeholders, timestamps — ≥4.5:1 on ALL layers  */
--mc-text-disabled:  #4D5560;  /* disabled controls only (non-essential, exempt per WCAG) */
--mc-text-inverse:   #0D1117;  /* text on accent / on light chips */
```

#### 2.1.4 Accent (single accent, blue)

```css
--mc-accent:        #4D9FFF;  /* primary actions, links, active nav, focus */
--mc-accent-hover:  #6FB2FF;
--mc-accent-active: #3B8BEB;
--mc-accent-subtle: #10243E;  /* tinted backgrounds: selected nav item, info chips */
--mc-on-accent:     #06101F;  /* text/icon on solid accent fills (dark-on-light-blue, ≥6.5:1) */
```

#### 2.1.5 Status colors

```css
--mc-success:        #3FB950;   --mc-success-subtle: #12261A;
--mc-warning:        #D29922;   --mc-warning-subtle: #2A2413;
--mc-danger:         #F85149;   --mc-danger-subtle:  #331B1E;
--mc-info:           #58A6FF;   --mc-info-subtle:    #10243E;
```

Usage: `success/warning/danger/info` are reserved for outcomes and health (Test Connection results, service health, error banners, destructive buttons). Session states use the dedicated set below — never reuse raw status tokens for session states, so that (e.g.) a `failed` badge and a form validation error remain independently themeable.

#### 2.1.6 Session-state colors and glyphs (mapped 1:1 to F7 states)

| F7 state | **Glyph** | Token | Value | Subtle bg token | Value | Dot behavior |
|---|---|---|---|---|---|---|
| `created` | `○` | `--mc-state-created` | `#9BA7B4` | `--mc-state-created-subtle` | `#1D242D` | static |
| `running` | `▶` | `--mc-state-running` | `#3FB950` | `--mc-state-running-subtle` | `#12261A` | **pulsing** (see §2.5 StatusDot; respects reduced motion, §7) |
| `paused` | `‖` | `--mc-state-paused` | `#D29922` | `--mc-state-paused-subtle` | `#2A2413` | static |
| `completed` | `✓` | `--mc-state-completed` | `#58A6FF` | `--mc-state-completed-subtle` | `#10243E` | static |
| `failed` | `✕` | `--mc-state-failed` | `#F85149` | `--mc-state-failed-subtle` | `#331B1E` | static |
| `archived` | `▣` | `--mc-state-archived` | `#818B96` | `--mc-state-archived-subtle` | `#191E26` | static |

Badges pair the subtle background with the full-strength color as text/dot (see §2.5 Badge).

**Colour is never the only channel.** Green/amber/red are indistinguishable to deuteranopic operators, and Mission Control's densest surfaces (session tabs, mobile chips, the sidebar open-sessions strip) have no room for a state word. Therefore:

- **Every state badge carries the verbatim F7 state name as text**, and
- **every StatusDot carries the state glyph above**, so *shape* carries the meaning wherever the label is absent. The glyph is mandatory in all dot-without-adjacent-label contexts: Active Projects widget, Dashboard/mobile session chips, sidebar open-sessions strip, Live Session tab bar, mobile session chip scroller.
- Each glyph-only dot exposes the verbatim F7 state name via `aria-label` **and** `title` (e.g. `aria-label="running"`) — never a synonym, per F9.5.
- `--mc-state-archived` at `#818B96` clears 4.5:1 on its own subtle background (4.83:1), so the archived badge uses the same full-strength-on-subtle recipe as every other state; the previous "`archived` badge also uses a `--mc-text-muted` label" exception is removed — one recipe, six states.

### 2.2 Typography

Operator-dense: small default size, compact line heights, monospace for anything an operator might copy, compare, or scan columnar.

```css
--mc-font-ui:   "Inter", "Segoe UI", system-ui, sans-serif;
--mc-font-mono: "JetBrains Mono", "Cascadia Code", ui-monospace, "SF Mono", monospace;
```

**Font delivery (binding on WS4): both families are self-hosted.** Inter and JetBrains Mono ship as `woff2` subsets inside `apps/frontend` (bundled assets, hashed filenames), declared with `@font-face { font-display: swap; }`. **No external CDN, no Google Fonts, no runtime network font fetch of any kind.** Mission Control is a self-hosted LAN product that must be fully usable on an air-gapped or internet-less home server; a CDN link would silently degrade the entire UI to Segoe UI / Consolas exactly when the operator is least able to diagnose it, and would leak instance usage to a third party. The remaining stack entries are last-resort fallbacks for a corrupted asset, not the expected rendering path.

| Token | Size / line-height | Weight | Usage |
|---|---|---|---|
| `--mc-fs-2xs` | 11 / 14 px | 400–500 | badge text, table micro-labels, timestamps |
| `--mc-fs-xs` | 12 / 16 px | 400–500 | secondary metadata, sidebar items, breadcrumbs |
| `--mc-fs-sm` | 13 / 18 px | 400 | **default body & table cell size** (dense) |
| `--mc-fs-md` | 14 / 20 px | 400–500 | form inputs, chat message body, section labels |
| `--mc-fs-lg` | 16 / 22 px | 600 | card/widget titles, modal titles |
| `--mc-fs-xl` | 20 / 26 px | 600 | page titles |
| `--mc-fs-2xl` | 26 / 32 px | 600 | dashboard metric numerals (mono) |

Monospace (`--mc-font-mono`) is mandatory for: Session IDs, `runtime_session_id`, commit SHAs, branch names, file paths, costs (`$0.4821`), token counts, durations, tool-call names and I/O, code blocks, API tokens, and the `requestId` in error surfaces (F5.4).

**Session identity — how a Session is labelled (binding across every screen).** Session primary keys are UUIDv7 (F4.2), whose leading bits are a millisecond timestamp. Two Sessions created in the same hour therefore share a near-identical prefix (`0198a2f3…`, `0198a1c0…`, `01989f11…`) — a short prefix is the *worst* available discriminator for the exact case the operator hits most (several sessions launched this afternoon). Rules:

| Surface | Label |
|---|---|
| Any list, tab, chip, widget row, or notification | **Primary line = human title**; **secondary line = `project · branch`** |
| Compact machine identifier in a table column | **Last 6 hex characters** of the UUID (the random tail), mono, column header `ID` — never the leading prefix |
| Session detail header | Full UUID, mono, `--mc-fs-2xs`, click-to-copy (§5.5) |

The **title** is auto-derived on session creation from the first user prompt (first sentence, trimmed to ~60 chars on a word boundary; the composer-started `created` flow derives it from the prompt that started the session). It is editable inline anywhere it appears as the page/tab heading (pencil affordance, `Enter` commits, `Esc` reverts). A Session with no prompt yet (started via `[Start]` with no prompt) falls back to `Untitled session · ‹HH:MM›` until its first prompt arrives, at which point the title auto-fills — unless the operator already set one, which always wins.

### 2.3 Spacing, radius, sizing

4px base grid.

```css
--mc-sp-05: 2px;  --mc-sp-1: 4px;   --mc-sp-2: 8px;   --mc-sp-3: 12px;
--mc-sp-4: 16px;  --mc-sp-5: 20px;  --mc-sp-6: 24px;  --mc-sp-8: 32px;
--mc-sp-10: 40px; --mc-sp-12: 48px;

--mc-radius-sm: 4px;   /* badges, chips, inline code */
--mc-radius-md: 6px;   /* buttons, inputs, cards, table container */
--mc-radius-lg: 10px;  /* modals, toasts */
--mc-radius-full: 999px; /* status dots, avatar */

--mc-control-sm: 28px;  /* compact buttons/inputs in table rows, panel headers */
--mc-control-md: 32px;  /* default desktop control height */
--mc-control-lg: 40px;  /* mobile touch targets, login form */
--mc-row-dense:  36px;  /* table row height */
--mc-sidebar-w:  220px; /* desktop nav rail */
--mc-panel-w:    340px; /* live-session right panel */
```

### 2.4 Motion

Minimal and purposeful only: `--mc-motion-fast: 120ms` (hover, focus), `--mc-motion-base: 200ms` (panel/modal enter, toast slide), easing `cubic-bezier(0.2, 0, 0, 1)`. The only looping animations permitted are the `running` state dot pulse and the streaming-cursor blink in live chat. All motion is disabled under `prefers-reduced-motion` (§7).

### 2.5 Component inventory

Canonical component list WS4 implements. States listed are the design-relevant ones; all interactive components additionally have the universal focus-visible ring (§7).

| Component | Variants | States | Key tokens / notes |
|---|---|---|---|
| **Button** | primary (solid accent), secondary (surface + border), ghost (borderless), danger (solid `--mc-danger`), icon-only | default, hover, active, disabled, **loading** (inline spinner replaces label, width preserved) | Heights `--mc-control-sm/md/lg`; primary uses `--mc-on-accent` text |
| **Input** | text, number, password, textarea, **path** (mono font + trailing validity hint), **secret** (see §4.4), select, search (leading icon, `/` shortcut) | default, focus, disabled, invalid (border `--mc-danger` + `--mc-fs-xs` message below) | `--mc-bg-inset` fill, `--mc-border` |
| **Toggle** | default, with inline label | on, off, disabled | on = accent track |
| **Badge** | state badge (F7 states, §2.1.6), neutral tag, count, **phase tag** (`P3`/`P4`) | — | `--mc-fs-2xs` 500 wt, `--mc-radius-sm`, subtle bg + full-strength text, always includes label text |
| **StatusDot** | 10px dot carrying the F7 **state glyph** (`○ ▶ ‖ ✓ ✕ ▣`, §2.1.6); health dot (`● ▲ ✕ ◌ ⟳`) | `running` pulses; **reduced-emphasis** when the connection chip is not `live` (§3.3) | Glyph is mandatory — the dot may appear without an adjacent text label, but never without its glyph + `aria-label`/`title` carrying the verbatim F7 state name |
| **ConnectionChip** | shell-level transport indicator | `live`, `reconnecting`, `offline` | §3.3; persistent in the desktop top bar and mobile header |
| **OpenSessionsStrip** | sidebar footer (desktop), tab bar (Live Session view), chip scroller (mobile) | per-entry: F7 state glyph, title, unread-activity dot with count | §3.4 — one shared data source, three renderings; max 6 entries |
| **CommandPalette** | `Ctrl+K` overlay | idle, filtering, empty | §4.7; the primary keyboard surface |
| **FindBar** | scoped find within the Conversation region | idle, matching (`n/m`), no-match | §5.5; virtualizer-aware |
| **BudgetMeter** | dashboard stat (numeral + rule), top-bar chip | under threshold, at/over threshold (`--mc-warning`), over budget (`--mc-danger`) | §5.2 / §3.1 |
| **AttentionRow** | row inside the Needs Attention widget | failed session, unhealthy service, sync failure, budget breach | §5.2; every row deep-links |
| **Table** | dense (default), selectable rows | loading (skeleton rows), empty (EmptyState inside body), row hover, row selected | `--mc-row-dense`; header `--mc-fs-2xs` uppercase `--mc-text-secondary`; sticky header on scroll |
| **Card / Widget** | dashboard widget (title + action link + body), stat card (metric numeral) | loading (skeleton), empty, error (inline ErrorBanner) | `--mc-bg-surface`, 1px `--mc-border`, `--mc-radius-md`, padding `--mc-sp-4` |
| **Tabs** | page-level (underline style), panel-level (contained), **session tabs** (closable, with StatusDot — §5.5) | active, hover, **phase-gated** (full-contrast label + muted `P3`/`P4` Badge — *never* `disabled`, see below) | Active = `--mc-text-primary` + 2px accent underline |
| **Toast** | success, danger, info, warning | auto-dismiss (5s), sticky (danger persists until dismissed) | `--mc-bg-raised`, `--mc-radius-lg`, left 3px status rule; max 3 stacked; bottom-right desktop, top mobile; see §4.5 |
| **Modal** | sm (400px — confirms), md (560px — forms), lg (720px) | loading, error | Scrim `--mc-bg-overlay`; focus-trapped; Esc closes; destructive confirms require explicit danger button |
| **ErrorBanner** | inline (panel/form scope), page-level | — | `--mc-danger-subtle` bg, `--mc-danger` rule; renders F5.4 envelope: message, `code` (mono chip), `requestId` (mono + copy button); see §4.3 |
| **EmptyState** | with primary CTA, plain | — | Centered, `--mc-text-muted`, one-line hint + one action max |
| **Skeleton** | text line, table row, widget block | — | Shimmer disabled under reduced motion (static blocks) |
| **KeyValueList** | two-column label/value, dense | — | Labels `--mc-text-secondary`, values often mono; used in detail headers, Services health |
| **MessageBlock** (chat) | user, assistant, system, tool (F4 Message roles) | streaming (assistant: animated cursor + pill), error | See §5.5 |
| **ToolCallBlock** | collapsed (default), expanded | running, ok, error | See §5.5 |
| **SecretField** | unset, set (masked), replacing | saved (with timestamp), pending-save | See §4.4 — actions are `[Replace]` and `[Clear]`; the field has **no** save button of its own |
| **HealthRow** | service row in Services panel | ok, degraded, down, not-configured, checking | See §5.7.12 |

**Phase-gated navigation treatment (canonical, applies to nav items, tabs, and Settings categories alike).** A Phase 3/4 destination renders with a **full-contrast label**, **normal hover and focus styling**, and a **muted `P3`/`P4` Badge**; activating it navigates to the placeholder shell (§6) which explains the phase. It is **never** `disabled`, never `aria-disabled`, never dimmed to `--mc-text-disabled`. Rationale: these targets are focusable and they *do* something (they route), so `disabled` would be a lie to both the pointer user and the screen-reader user, and `--mc-text-disabled` is deliberately exempt from the AA contrast floor — using it on a reachable target puts unreadable text in the navigation. The Badge, not the contrast, communicates "later phase".

---

## 3. Application Shell & Navigation

### 3.1 Desktop shell

Persistent left rail (`--mc-sidebar-w`), slim top bar. Nav order groups Phase 1–2 pages first; Phase 3/4 pages carry a muted `P3`/`P4` Badge at full label contrast and lead to placeholder shells (§6) — visible so the operator sees the roadmap, badged so nobody expects function, never `disabled` (§2.5 phase-gated treatment).

```
+------------------------------------------------------------------------------------------+
| [#] MISSION CONTROL  [ / Search… ]      ‹$3.42/$10.00›  ● live   [Bell•3]  [MB v]        |
+----------------+-------------------------------------------------------------------------+
|  ◧ Dashboard   |                                                                         |
|  ▤ Projects    |                                                                         |
|  ▶ Sessions    |                          <page content>                                 |
|  ▣ ADRs        |                                                                         |
|  ─────────     |                                                                         |
|  ◌ Memory  P3  |                                                                         |
|  ◌ Agents  P4  |                                                                         |
|  ─────────     |                                                                         |
|  ⚙ Settings    |                                                                         |
|                |                                                                         |
|  ─────────     |                                                                         |
|  ▶ 2 running   |                                                                         |
|  OPEN SESSIONS |                                                                         |
|  ▶ Refactor q… |                                                                         |
|  ▶ Inventory…•3|                                                                         |
|  ‖ Fix nginx…  |                                                                         |
+----------------+-------------------------------------------------------------------------+
```

- **Wordmark:** text-only `MISSION CONTROL` in `--mc-fs-sm` 600wt + a 16px glyph. No further branding (non-goal).
- **Top bar, left→right:** global search (Phase 2 semantic search entry point; Phase 1 it filters Projects/Sessions by name), **spend chip** `‹$3.42/$10.00›` (§5.2 / WC1 — mono `--mc-fs-2xs`, click → Dashboard spend stat; turns `--mc-warning` at the alert threshold and `--mc-danger` over budget; hidden entirely when cost-budget alerts are disabled in Settings), **connection chip** (§3.3), notification bell with unread count (opens inbox popover, §4.5), account menu (profile, theme, sign out).
- **Sidebar footer, two parts:**
  1. **`▶ 2 running`** — live count of `running` Sessions with a pulsing, glyph-bearing StatusDot; click → Sessions list pre-filtered to `running`. This is a live region (§3.3).
  2. **Open-sessions strip** (§3.4) — the shell-level session switcher, present on *every* page.
- Active nav item: `--mc-bg-selected` wash + accent left rule.

### 3.2 Mobile shell (monitoring-first)

< 768px: sidebar collapses to a bottom tab bar with the four monitoring-relevant destinations plus overflow. Touch targets `--mc-control-lg`.

```
+------------------------------+
| MISSION CONTROL ● live [Bell•3] |
+------------------------------+
|                              |
|        <page content>        |
|                              |
+------------------------------+
| ◧ Home  ▶ Sessions  ▤ Proj  ≡ More |
+------------------------------+
```

`More` sheet: ADRs, Memory `P3`, Agents `P4`, Settings, Sign out — same phase-gated treatment as desktop (§2.5).

The **connection chip** (§3.3) sits in the mobile header next to the bell and collapses to its dot + one-word state to fit. The spend chip is *not* in the mobile header (space); it appears in the mobile Dashboard stack instead.

### 3.3 Connection liveness (mandatory shell element)

Everything on a monitoring dashboard is a claim about the present. If the WebSocket (F5.6) is down, every dot, duration, and count on screen is a claim about the past, and nothing on screen says so. The connection chip is therefore not decoration — it is the trust indicator for the whole product (WS4 §5.1 requires it; this section specifies its visual and behavioral contract).

| Chip state | Render | Meaning |
|---|---|---|
| `live` | `● live` — `--mc-success` dot, `--mc-text-secondary` label | Socket `open`; subscribed channels current |
| `reconnecting` | `◌ reconnecting` — `--mc-warning` dot with slow spin (static under reduced motion) | Socket in `backoff`/`connecting` (WS4 §5.1); a retry is scheduled |
| `offline` | `✕ offline` — `--mc-danger` dot, `--mc-danger` label + `[Retry]` | Backoff exhausted or the browser is offline |

The chip's tooltip/popover shows `last update HH:MM:SS` and, in `reconnecting`, `next attempt in Ns`.

**Degraded-liveness rule (applies whenever the chip is NOT `live`):** every live region drops to reduced emphasis — `--mc-text-muted` values, StatusDot pulse suspended (glyph retained), and a `last updated HH:MM` line appended to the region — and **all client-side ticking durations FREEZE at their last known value.** A duration counter that keeps incrementing while the socket is dead is actively lying to the operator: it renders as though the session were confirmed alive when the truth is unknown. Frozen durations render with a `~` prefix (`~00:42:10`) to mark them as last-known rather than current.

Live regions covered by this rule (the complete Phase 1–2 list; same set WS4 wires to channels):

| Live region | Degraded rendering |
|---|---|
| Sidebar `▶ n running` count | Muted count + `last updated HH:MM` on hover |
| Sidebar open-sessions strip (§3.4) | Muted titles, dots static, unread counts stop accruing |
| Dashboard **Needs Attention** widget | Muted rows + inline `last updated HH:MM` in the widget header |
| Dashboard **Active Sessions** widget | Muted rows, frozen `~` durations |
| Dashboard **spend** stat and top-bar chip | Muted; `~` prefix on the amount |
| Sessions table state cells + durations | Muted state badges, frozen `~` durations |
| Live Session tab dots | Static glyph dots, muted |
| Live Session header duration/cost | Frozen `~`; header gains the §5.5 reconnect strip |
| Streaming pill | Replaced by `⏸ stream interrupted — reconnecting` (§5.5), never left spinning |

On return to `live`, WS4 refetches per F6.3 (no replay), emphasis restores, durations resume from server truth, and the chip flashes success once before settling.

### 3.4 Open-sessions strip (shell-level session switcher)

Multi-session work is the product's headline capability (PRD §4.2), so the switcher belongs to the **shell**, not to one screen. A switcher that only exists inside the Live Session view forces a two-step navigation (go to Sessions → find the row → open) to answer "is B still running while I read the Dashboard?" — which is the question multi-session support exists to answer.

- **One data source, three renderings.** The strip's contents = the operator's **open session set** (persisted, capped at 6 — WS4 §6.5 `uiStore`, `localStorage`-backed, so it survives reload and re-login). The desktop sidebar footer renders it vertically; the Live Session view's tab bar (§5.5) renders **the same set** horizontally; mobile renders it as the chip scroller. They cannot diverge because there is only one set: closing a tab in the Live Session view removes it from the sidebar strip in the same interaction, and opening a Session from anywhere adds it to both.
- **Per entry:** F7 **state glyph** dot (§2.1.6) + **title** (truncated with `…`, full title in `title` attribute) + **unread-activity dot with numeric count**.
- **Unread activity** = messages/tool calls/state changes arriving on that Session's channel while it is not the visible route. Rendered as an accent dot with a count (`•3`, `9+` cap); a `failed` transition renders the count in `--mc-danger` regardless of size. Opening the Session clears its count. Counts stop accruing (and are marked stale) when the connection chip is not `live` (§3.3).
- **Interaction:** click switches to `/sessions/:id`; `Alt+1…9` selects the nth entry; `Alt+[` / `Alt+]` move to the previous/next entry (§4.6). The strip has a header row `OPEN SESSIONS` at `--mc-fs-2xs` uppercase; when the set is empty the whole block is omitted (no empty-state noise in the nav).
- **Overflow:** the cap is 6; opening a 7th evicts the least-recently-viewed *non-`running`* entry (never a `running` one) and shows a one-line toast naming what was closed.

---

## 4. Cross-Cutting Interaction Patterns

These apply to every wireframe in §5 and are not repeated per screen except where behavior is specific.

### 4.1 Loading states

- **Navigation:** never block; render page chrome immediately, skeleton the data regions (table rows ×5, widget blocks).
- **In-place refresh:** subtle top-of-region 2px accent progress bar; existing data stays visible (no content flash).
- **Buttons that trigger requests:** inline loading state (spinner replaces label, width preserved, disabled).

### 4.2 Empty states

Every list/table has a designed empty state: one muted line + at most one primary CTA. Examples appear per screen. Filtered-to-empty shows "No results for these filters" + "Clear filters" ghost button (distinct from true-empty).

### 4.3 Error display (F5.4 error envelope)

All API errors surface the F5.4 envelope consistently:

- **Form/action errors** → inline ErrorBanner scoped to the form/panel: human `message`, `code` as mono chip (e.g., `INVALID_STATE_TRANSITION`), `requestId` in `--mc-fs-2xs` mono with a copy-icon button ("Copy request ID"). Field-level `details` map to per-field invalid states where present.
- **Page-load errors** → page-level ErrorBanner replacing the data region, with a Retry button. Chrome/nav stays interactive.
- **Background/async failures** (WebSocket push of `sync.failed` etc.) → danger toast (sticky) + Notification inbox entry (§4.5).
- The `requestId` is always shown — it is the operator's bridge to logs (F5.4: also in `X-Request-Id` and logs).

```
+----------------------------------------------------------------------+
| ✕  Could not reach GitHub: token was rejected.                       |
|    [GITHUB_AUTH_FAILED]        requestId: 0198a2f3-…-8b1c  [copy]    |
+----------------------------------------------------------------------+
```

### 4.4 Secret fields (write-only, PRD §4.4)

SecretField pattern used by every integration credential (GitHub PAT, Telegram bot token, Qdrant API key, API tokens):

- **Unset:** empty password input, placeholder "Not set".
- **Set:** static masked row `•••••••••••• (saved 2026-08-11 09:14)` + `[Replace]` and `[Clear]`. The stored value is **never** redisplayed or round-tripped to the client.
- **`[Replace]` unlocks a fresh empty password input and nothing else.** It has **no `[Save]` button of its own** — the panel's sticky `[Save changes]` bar is the single commit path for every field on the panel, secrets included. `[Cancel]` on the field re-locks it and discards the typed value.
- **Why no per-field save:** a `[Save]` inside a field that sits above a panel-level `[Save changes]` bar creates the worst failure mode in the whole Settings surface — the operator pastes a token, clicks the nearer button, sees *something* confirm, navigates away, and cannot tell whether the credential persisted, because the one value the UI is forbidden to read back is a secret. One commit path removes the ambiguity structurally.
- **Confirmation after save:** on a successful panel save, a replaced secret returns to its masked state with a **fresh `(saved ‹timestamp›)`** — the changed timestamp is the confirmation that the write landed, and it is the only honest confirmation possible for a write-only value. A secret that is still in `Replace` mode with typed content contributes to the panel's dirty count as "1 change" and is described in the Save bar as e.g. "3 changes (incl. 1 secret)".
- **`[Clear]`** (ghost, danger text) is a separately-confirmed destructive action with its own confirm modal ("Clear GitHub personal access token? Integrations using it will stop working.") and is **not** batched behind `[Save changes]` — destroying a credential is not an edit, and pairing it with a batched save invites clearing-by-accident. Named `[Clear]` verbatim, matching WS4 §7.3.
- Reminder line under every secret: "Secrets are encrypted at rest and cannot be viewed after saving."

### 4.5 Toasts vs. notification inbox

Two channels with a strict rule — **toasts are ephemeral feedback about what the operator just did or must see now; the inbox is the durable record (F4 Notification entity, Phase 2):**

| Channel | Content | Behavior |
|---|---|---|
| Toast | Action confirmations ("Settings saved"), transient failures with retry, live alerts while the relevant screen is not open (e.g., `session.failed` while on Dashboard) | Bottom-right (desktop) / top (mobile); success/info auto-dismiss 5s; danger sticky until dismissed; max 3 stacked, oldest collapses to counter |
| Inbox (bell) | Everything the Telegram Worker also cares about: session completions, daily report, sync failures, alerts (PRD §9) | Unread badge on bell; popover list (newest first) with per-item mark-read, "Mark all read"; items deep-link (e.g., to the Session) |

Phase 1: toast system only (client-side feedback). The bell + inbox and the Dashboard Notifications widget light up in Phase 2 with the Notification entity; until then the bell shows the §4.2 empty state.

### 4.6 Keyboard model (canonical shortcut table)

This table is the single source of truth; §7.3 adds the focus/suppression rules and the `?` cheat sheet renders it verbatim.

| Shortcut | Action | Scope |
|---|---|---|
| `Ctrl+K` (`Cmd+K`) | **Command palette** (§4.7) — the primary keyboard surface | Global |
| `/` | Focus global search | Global |
| `?` | Shortcut cheat sheet | Global |
| `Esc` | Close modal/popover/palette/find bar; from composer → conversation region; **stop an in-flight turn** when the conversation region has focus (§5.5) | Global |
| `g d` / `g p` / `g s` / `g r` | Go to Dashboard / Projects / Sessions / ADRs | Global |
| `g m` / `g e` / `g ,` | Go to Memory `P3` / Agents `P4` / Settings | Global |
| **`Alt+1…9`** | Switch to the nth open Session (§3.4 strip order) | Global |
| **`Alt+[` / `Alt+]`** | Previous / next open Session | Global |
| `n` | Primary "New …" action for the current list | Lists |
| `↑ ↓` / `Enter` / `o` | Row traversal / open / overflow menu | Tables |
| `Ctrl+Enter` | Send prompt | Composer |
| `Ctrl+F` | Find in transcript (§5.5) | Conversation region |
| `Enter` / `Space` | Toggle focused ToolCallBlock | Conversation region |
| `Ctrl+S` | Save the dirty Settings panel | Settings |

**`Ctrl+1…9` is not used and must not be specified anywhere.** Chrome, Edge, and Firefox consume `Ctrl+1…9` for tab switching at the browser-chrome level; the keydown is never delivered to page JavaScript, so the headline multi-session shortcut would silently do nothing (and, worse, would yank the operator to a different *browser* tab mid-session). `Alt+1…9` is delivered to the page on all three browsers on Windows and Linux, the desktop platforms an operator is most likely to use. *(F8 constrains the **server/dev host** — Windows 11 dev, Ubuntu prod — and says nothing about the operator's browser platform, so it must not be cited to narrow client support: PRD §14 mandates mobile monitoring, which includes iOS Safari, and `Cmd+K` is already bound for macOS in the table above. No capability depends on a chord — the `Ctrl/Cmd+K` palette is the universal fallback, and mobile has no keyboard dependency at all.)* ADR navigation is `g r` (**r**ecords), not `g a` — `g a` collides with Agents, and a chord that resolves differently depending on which page you were on is not a shortcut, it is a coin flip.

### 4.7 Command palette (`Ctrl+K`)

The operator surface that scales past a memorized chord table. One overlay (`--mc-bg-raised`, 560px, focus-trapped), fuzzy-filtered as you type, arrow-navigable, `Enter` executes, `Esc` closes.

```
+--------------------------------------------------+
| ⌘ [ refac|                                     ] |
|--------------------------------------------------|
| SESSIONS                                         |
| ▶ Refactor queue port to batch enqueue           |
|      mission-control · ‹DEV› · running           |
| ✓ Refactor invoice mapper                        |
|      erp-core · ‹main› · completed               |
| ACTIONS                                          |
| ⏸ Pause "Refactor queue port to batch enqueue"   |
| SETTINGS                                         |
| ⚙ Settings → Integrations → GitHub               |
+--------------------------------------------------+
```

Four result groups, in this order:

1. **Sessions** — matched on **title**, project, and branch (never on ID prefix, per §2.2). Each row shows the title plus `project · branch · state`.
2. **Actions** — lifecycle actions for the current or matched Session, offered **only when legal for its F7 state** (the palette applies exactly the same state legality as the row `⋯` menu; an illegal transition is never listed, matching F7 and avoiding a guaranteed `INVALID_STATE_TRANSITION`).
3. **Settings** — jump to any Settings category or integration panel by name.
4. **Commands** — toggle theme, toggle right panel, sign out, open cheat sheet.

The `g` chords are retained as aliases for muscle memory; the palette is the discoverable path and the one that survives feature growth.

---

## 5. Wireframes — Phase 1–2 Screens

Conventions in frames: `[Button]`, `( ) / (•)` radio, `[x]` checkbox, `[▾]` select, `‹mono›` = monospace content. **StatusDots are drawn as their F7 glyph** (§2.1.6) — `○` created, `▶` running, `‖` paused, `✓` completed, `✕` failed, `▣` archived — because that is literally what renders; the coloured disc carries the glyph. `•n` = unread-activity dot with count.

### 5.1 Login

Single local account (F5.5). Centered card on `--mc-bg-app`, controls at `--mc-control-lg`.

```
+------------------------------------------------------------------+
|                                                                  |
|                     [#]  MISSION CONTROL                         |
|                                                                  |
|          +----------------------------------------+              |
|          |  Sign in                               |              |
|          |                                        |              |
|          |  Username                              |              |
|          |  [ operator                        ]   |              |
|          |                                        |              |
|          |  Password                              |              |
|          |  [ ••••••••••••                ] [👁]  |              |
|          |                                        |              |
|          |  [        Sign in         ]            |              |
|          |                                        |              |
|          |  +----------------------------------+  |              |
|          |  | ✕ Invalid username or password.  |  |              |
|          |  |   [AUTH_INVALID_CREDENTIALS]     |  |              |
|          |  |   requestId: ‹0198…4fa1› [copy]  |  |              |
|          |  +----------------------------------+  |              |
|          +----------------------------------------+              |
|                                                                  |
|                   Self-hosted · single operator                  |
+------------------------------------------------------------------+
```

**Interaction notes**
- Primary action: Sign in (`Enter` submits from either field). Loading: button inline spinner; fields stay enabled until response.
- Error: inline ErrorBanner per §4.3 (shown in frame). No lockout UI in V1; repeated failures land in `audit_log_entries` (backend concern).
- No "forgot password" (single local account; password reset is an operator/CLI concern outside this UI). No registration.
- Focus lands on Username on load. Password field has show/hide toggle (`aria-pressed`).

### 5.2 Dashboard Home (PRD §8.1)

Widgets, in grid order: **Needs Attention**, Active Sessions, Spend, Active Projects, Services, Recent ADRs, Upcoming Tasks, Notifications.

The ordering is deliberate. An operator opening this page is asking, in order: *what is broken?* → *what is running?* → *what is it costing me?* → *what else exists?* The previous layout led with inventory (project counts) and made failure something you had to go looking for — a `failed` session, a dead worker, and a blown budget were each reachable only by navigating to the page that owned them.

```
+----------------+---------------------------------------------------------------------------+
| nav (§3.1)     |  Dashboard                                        [+ New Session]         |
|                |                                                                           |
|                |  +----------------------------------------------------------------------+ |
|                |  | ⚠ NEEDS ATTENTION (3)                              updated 14:07     | |
|                |  |----------------------------------------------------------------------| |
|                |  | ✕ Session failed  Fix nginx TLS renewal · homelab-infra   14:02  [→] | |
|                |  |     ‹SESSION_PROCESS_EXIT› · requestId ‹0198…d31a›                   | |
|                |  | ▲ Sync Worker degraded · last job failed 14:02            14:02  [→] | |
|                |  | ▲ Obsidian sync failed · vault path unreadable            13:41  [→] | |
|                |  | ▲ Daily spend ‹$8.40› of ‹$10.00› — 84% (alert at 80%)    now    [→] | |
|                |  +----------------------------------------------------------------------+ |
|                |                                                                           |
|                |  +--------------------------------------------+  +---------------------+  |
|                |  | ACTIVE SESSIONS                          → |  | SPEND (today)     → |  |
|                |  |                                            |  |                     |  |
|                |  | ▶ Refactor queue port to batch enqueue     |  |   ‹$3.42›           |  |
|                |  |    mission-control · ‹DEV›                 |  |   of ‹$10.00›       |  |
|                |  |    running · 00:42:10 · ‹$0.48›   [Open]   |  |   ▬▬▬▬▬▬▭▭▭▭▭▭▭▭▭▭  |  |
|                |  | ▶ Import inventory CSV mapping             |  |   34% · alert at 80%|  |
|                |  |    erp-core · ‹feat/inv›                   |  |                     |  |
|                |  |    running · 00:07:33 · ‹$0.11›   [Open]   |  |   month ‹$71.08›    |  |
|                |  | ‖ Fix nginx TLS renewal                    |  +---------------------+  |
|                |  |    homelab-infra · ‹main›                  |                           |
|                |  |    paused · 01:12:04 · ‹$0.92›    [Open]   |  +---------------------+  |
|                |  +--------------------------------------------+  | SERVICES          → |  |
|                |                                                 |  | ● Postgres ● Queue  |  |
|                |  +--------------------+  +-------------------+  | | ● Telegram ▲ Sync   |  |
|                |  | ACTIVE PROJECTS  → |  | RECENT ADRs     → |  | | ◌ Qdrant  ◌ Ollama  |  |
|                |  |  ‹4›               |  | ADR-014 Queue on  |  | +---------------------+  |
|                |  |  mission-control ▶ |  |   PostgreSQL      |  |                           |
|                |  |  erp-core        ▶ |  | ADR-013 No Redis  |  | +---------------------+  |
|                |  |  homelab-infra   ‖ |  |   in V1           |  | | UPCOMING TASKS      |  |
|                |  |  notes-pipeline    |  | ADR-012 WebSocket |  | | 18:00 Daily report  |  |
|                |  +--------------------+  +-------------------+  | | 18:30 Obsidian sync |  |
|                |                                                 |  +---------------------+  |
|                |  +----------------------------------------------------------------------+ |
|                |  | NOTIFICATIONS                                                      → | |
|                |  | • Session "Import inventory CSV mapping" completed              2m   | |
|                |  | • Obsidian sync failed                                          1h   | |
|                |  +----------------------------------------------------------------------+ |
+----------------+---------------------------------------------------------------------------+
```

**Needs Attention widget (first in the grid, first in the mobile stack)**

Sources, all four wired in Phase 1–2, newest first, max 8 rows:

| Source | Row content | Deep-link target |
|---|---|---|
| Sessions that entered `failed` in the last 24 h (`session.failed`, F6) | `✕ Session failed` · title · project · time · `code` + `requestId` (F5.4) | `/sessions/:id` |
| Any service not `healthy` (Services health, §5.7.12) | `▲ ‹service› degraded/down` · detail | Settings → Services |
| Last `sync.failed` (Phase 2) | `▲ Obsidian sync failed` · reason | Settings → Integrations → Obsidian |
| Cost-budget breach (threshold crossed or budget exceeded, PRD §4.4.2) | `▲ Daily spend ‹$x› of ‹$y› — n%` | Dashboard Spend stat / Settings → Claude Code |

- Severity ordering: `failed` sessions first, then `down` services, then `degraded`/sync/budget. Row glyphs are `✕` (danger) and `▲` (warning) — never colour alone.
- **Empty = one line, not a card.** When nothing needs attention the widget collapses to a single `--mc-success`-ruled row: `✓ All clear · no failures in the last 24 h`. It never occupies a full card's worth of vertical space when there is nothing to say, and it never disappears — its absence and its "all clear" must be distinguishable.
- Rows are dismissible only where they are acknowledgements (budget); a `failed` session leaves the list when it is archived or ages past 24 h, so the list cannot be "cleaned" into hiding a real failure.
- This widget is a live region (§3.3): degraded when the connection chip is not `live`, with `updated HH:MM` in the header.

**Interaction notes**
- Primary action: `+ New Session` (opens Launch Session modal, §5.4.1). Widget titles with `→` link to their pages.
- **Active Sessions** widget is live: rows update via WebSocket (`session.state_changed` on the subscribed channels, F5.6/F6); `running` dots pulse; duration ticks client-side (and **freezes** per §3.3 when not `live`). Shows only `running` + `paused` (that is what "active" means here), newest first, max 6, overflow → "View all →". **Row label is the Session title; the second line is `project · branch`** — no ID appears in this widget at all (§2.2).
- **Spend widget (PRD §4.4.2 cost budget):** today's accumulated cost as a mono `--mc-fs-2xl` numeral, `of ‹$budget›` beneath, and a **thin progress rule** (4px, `--mc-radius-full`) that renders `--mc-accent` under the alert threshold, `--mc-warning` at/over it, and `--mc-danger` over 100%. Secondary line: month-to-date. Costs are SDK-canonical for managed sessions (F1.5); observed sessions contribute nothing and a footnote says so on hover ("Observed sessions report no cost"). If cost-budget alerts are disabled in Settings the widget still shows spend, with `no budget set` in place of the rule — spend is never invisible just because no limit was configured, which was the whole gap: the budget was configurable but the number it constrained appeared nowhere in the UI.
- **Services widget:** the compact variant of the §5.7.12 Services panel (WS4 §7.5 already specifies this component is reusable on the Dashboard) — one glyph+name chip per service, no detail text; click → Settings → Services. Polled on the same 10 s interval as the panel (deliberately *not* WebSocket-driven: health must remain observable when the socket is the sick component).
- **Recent ADRs** and **Notifications** widgets are Phase 2-wired (Adr, Notification entities); in Phase 1 they render their empty states ("No ADRs yet" / "No notifications").
- **Upcoming Tasks:** the PRD names this widget, but no Task entity exists in F4.1. WS5's position: the widget renders **scheduled system activity** derived from Settings and queue schedule — daily-report delivery time (PRD §4.4.3), next Obsidian sync, next repo poll. It is read-only and creates no new entity. WS4 §2.2 currently states the opposite (empty-state placeholder in V1); this is the one open behavioural question left in this document and is flagged for WS7 arbitration in §8.2.
- Empty states: Active Projects → "No projects yet · [Add project]" ; Active Sessions → "No active sessions · [New Session]".
- Loading: shape-matched skeleton widgets. Widget-level fetch errors show the inline ErrorBanner inside that widget only; the rest of the dashboard is unaffected.

**Mobile variant (monitoring)** — single column, **Needs Attention first**, then Active Sessions:

```
+------------------------------+
| Dashboard  ● live   [Bell•2] |
+------------------------------+
| ⚠ NEEDS ATTENTION (3)        |
| ✕ Fix nginx TLS renewal    › |
|   homelab-infra · failed 14:02|
| ▲ Sync Worker degraded     › |
| ▲ Spend ‹$8.40›/‹$10.00›   › |
+------------------------------+
| ACTIVE SESSIONS              |
| ▶ Refactor queue port…       |
|   mission-control · ‹DEV›    |
|   running · 42m · ‹$0.48›  › |
| ▶ Import inventory CSV…      |
|   erp-core · ‹feat/inv›      |
|   running · 7m · ‹$0.11›   › |
| ‖ Fix nginx TLS renewal      |
|   homelab-infra · ‹main›     |
|   paused · 1h12m · ‹$0.92› › |
+------------------------------+
| SPEND today ‹$3.42›/‹$10.00› |
| ▬▬▬▬▬▬▭▭▭▭▭▭▭▭▭▭▭▭  34%      |
+------------------------------+
| NOTIFICATIONS                |
| • Session completed      2m  |
| • Obsidian sync failed   1h  |
+------------------------------+
| ACTIVE PROJECTS   RECENT ADRs|
| (compact counts + top items) |
+------------------------------+
| ◧ Home ▶ Sessions ▤ Proj ≡   |
+------------------------------+
```

When Needs Attention is empty on mobile it is the same single "✓ All clear" rule, so the first card the operator sees is still the answer to "is anything wrong?".

### 5.3 Projects (PRD §8.2)

#### 5.3.1 Projects list

```
+----------------+---------------------------------------------------------------------------+
| nav            |  Projects                                          [+ Add Project]        |
|                |                                                                           |
|                |  [ Filter by name…          ]                                             |
|                |  +---------------------------------------------------------------------+  |
|                |  | NAME             REPOSITORIES  SESSIONS      LAST ACTIVITY          |  |
|                |  |---------------------------------------------------------------------|  |
|                |  | mission-control  2             ▶ 1 running   2 min ago              |  |
|                |  | erp-core         3             ▶ 1 running   9 min ago              |  |
|                |  | homelab-infra    1             ‖ 1 paused    1 h ago                |  |
|                |  | notes-pipeline   1             —             3 d ago                |  |
|                |  +---------------------------------------------------------------------+  |
+----------------+---------------------------------------------------------------------------+
```

- Row click → project detail. Empty: "No projects yet. Projects group repositories, Sessions, and knowledge. · [Add Project]".
- The SESSIONS cell uses **verbatim F7 state names** (`1 running`, `1 paused`) — never "1 active". Per F9.5 the UI may not invent synonyms for locked state vocabulary, and "active" is ambiguous exactly where it matters: it reads as "running" to a new operator while actually spanning `running` + `paused` elsewhere in this document. Where a Project has sessions in several states the cell shows the highest-priority two (`▶ 2 running · ‖ 1 paused`), ordered `running` → `paused` → `failed`. StatusDots here carry their glyph (§2.1.6) since the count text is not a state label for the dot.

#### 5.3.2 Project detail

Tabs mirror PRD §8.2 display list: Repositories, Sessions (Phase 1), Agents (Phase 4), Memory (Phase 3).

```
+----------------+---------------------------------------------------------------------------+
| nav            |  Projects / mission-control                        [+ New Session]        |
|                |                                                                           |
|                |  mission-control                        ▶ 1 running · 2 repositories      |
|                |  Self-hosted AI engineering OS          Workspace: Default                |
|                |  Workflow mode  ( ) Manual  (•) Assisted   ⓘ overrides global setting     |
|                |                                                                           |
|                |  [ Repositories ] [ Sessions ] [ Agents ·P4 ] [ Memory ·P3 ]              |
|                |  ---------------------------------------------------------------------    |
|                |  REPOSITORIES                                                             |
|                |  +---------------------------------------------------------------------+  |
|                |  | NAME        DEFAULT BRANCH  VISIBILITY  OPEN PRs  LAST COMMIT       |  |
|                |  |---------------------------------------------------------------------|  |
|                |  | MCS         ‹main›          private     1         ‹4b4d17e› 2h ago  |  |
|                |  |   └ github.com/cento007/MCS · synced 5 min ago                      |  |
|                |  | MCS-infra   ‹main›          private     0         ‹9c21aa0› 1d ago  |  |
|                |  +---------------------------------------------------------------------+  |
|                |                                                                           |
|                |  Repository row expands ▼: recent Commits (SHA, author, message, files)   |
|                |  and PullRequests (state: open/merged/closed/draft — GitHub truth, A3)   |
+----------------+---------------------------------------------------------------------------+
```

**Interaction notes**
- Primary action: `+ New Session` pre-scoped to this Project.
- **Workflow mode (PRD §4.3):** a per-Project override of the global setting (Settings → Integrations → GitHub, §5.7.3). `Manual` = Mission Control records commits/PRs but takes no git action on the operator's behalf; `Assisted` = Mission Control proposes commit messages, branch names, and PR descriptions for explicit approval. Radio group in the Project header, inline-saving with a toast and an audit-log entry; a `(global)` chip appears next to whichever option matches the global default so the operator can see when they are diverging. Set back to `(global)` via the `⋯` menu ("Follow global workflow mode").
- **Sessions tab:** identical table to §5.4 pre-filtered to the Project (shared component).
- **Agents / Memory tabs:** phase-gated per §2.5 — full-contrast label plus muted `P4`/`P3` Badge, normal focus and hover, never `disabled`/`aria-disabled`; the panel body is the placeholder shell from §6 (same callout content). No dead-end 404s.
- Repository sync status line shows last `repository.synced` time; a failed poll shows a warning chip + links to Settings → Integrations → GitHub.
- Empty (Repositories): "No repositories discovered. Configure discovery roots in Settings → Integrations → GitHub. · [Open Settings]".

### 5.4 Sessions list

```
+----------------+---------------------------------------------------------------------------+
| nav            |  Sessions                                          [+ New Session]        |
|                |                                                                           |
|                |  State [ All ▾ ]  Project [ All ▾ ]  Type [ All ▾ ]   [ Search… ]         |
|                |                                                                           |
|                |  +---------------------------------------------------------------------+  |
|                |  | STATE        SESSION                        TYPE      DURATION  COST|  |
|                |  |              project · branch                            ID         |  |
|                |  |---------------------------------------------------------------------|  |
|                |  | ▶ running    Refactor queue port to…        managed   00:42:10      |  |
|                |  |              mission-control · ‹DEV›                  ‹8b1c4f› $0.48|  |
|                |  | ▶ running    Import inventory CSV mapping   observed  00:07:33      |  |
|                |  |              erp-core · ‹feat/inv›                    ‹2ad901›   ‹—›|  |
|                |  | ‖ paused     Fix nginx TLS renewal          managed   01:12:04      |  |
|                |  |              homelab-infra · ‹main›                   ‹7c0e55› $0.92|  |
|                |  | ✓ completed  Add invoice export endpoint    managed   00:31:19      |  |
|                |  |              erp-core · ‹main›                        ‹19d4b2› $1.21|  |
|                |  | ✕ failed     Rewrite frontmatter parser     managed   00:04:02      |  |
|                |  |              notes-pipeline · ‹main›                  ‹d31a08› $0.07|  |
|                |  | ▣ archived   Spike pg-boss retry policy     managed   00:55:40      |  |
|                |  |              erp-core · ‹main›                        ‹4fa1c7› $0.63|  |
|                |  +---------------------------------------------------------------------+  |
|                |  Showing 50 · [Load more]                                                 |
+----------------+---------------------------------------------------------------------------+
```

**Interaction notes**
- Columns per PRD §4.1 stored metadata: state (F7 badge with glyph), **Session** (primary line = title, secondary line = `project · branch` — §2.2), Type (managed/observed), Duration, Cost (mono; observed sessions may show `—`, cost is canonical for managed via SDK per F1.5), **ID** (mono, **last 6 hex chars** of the UUIDv7 — the random tail, not the timestamp prefix; click-to-copy copies the *full* UUID), plus Updated (relative). Runtime metadata (Claude version, machine) lives in the detail header, not the table.
- **Why the title leads and the ID is demoted:** UUIDv7 encodes a millisecond timestamp in its leading bits (F4.2), so `0198a2f3…`, `0198a1c0…` and `01989f11…` are three sessions from the same afternoon — a prefix column made every row of a busy list look the same and forced the operator to disambiguate by project/branch anyway. The random tail discriminates; the title is what the operator actually remembers. Sorting by ID is not offered (it would be sorting by creation time under a misleading label — sort by Started instead).
- The title cell is inline-editable on the detail page, not in the table; here it is plain text with the full title in `title` for truncated rows.
- State filter chips map 1:1 to F7 states; default view excludes `archived` (toggle "Show archived").
- Cursor pagination (F5.3) surfaces as "Load more", not page numbers — stable under live inserts.
- Row click → Live Session view (§5.5). Rows of `running` sessions update live.
- Row overflow menu `⋯`: Open, Pause/Resume/End (state-appropriate only — invalid transitions are never offered, matching F7; the API would reject with `INVALID_STATE_TRANSITION`), Clone, Export, Generate Context Package, Archive (only from `completed`/`failed`).
- Empty: "No sessions yet. Launch a managed session or attach to a running Claude Code session. · [New Session]".

**Mobile variant:** two-line cards (state badge + **title** / `project · branch` · duration · cost), filter as horizontally scrollable chips. The ID does not appear on mobile at all. **No `+` New Session FAB on mobile** (WS7 arbitration A12, UX register WC5 — WS4 §9.2's position): mobile offers **Resume as new Session** and **Clone** from an existing Session's overflow menu, which are launches with working directory, repository, and branch inherited from a target already vetted on a desktop. Composing a *new* launch target is what mobile omits, because the Launch modal now carries a mandatory working-tree disclosure and branch-change acknowledgement (§5.4.1, WC11) that cannot be honestly reviewed on a phone — and a FAB would give the most consequential, least-verifiable action the highest-prominence slot on the smallest screen. PRD §14 scopes mobile to monitoring.

#### 5.4.1 Launch Session modal (md)

```
+----------------------------------------------------------+
| New Session                                          [✕] |
|                                                          |
| Project      [ mission-control ▾ ]                       |
| Repository   [ MCS ▾ ]                                   |
| Branch       [ ‹DEV› ▾ ]                                 |
| Model        [ default (from Settings) ▾ ]               |
|                                                          |
| Working directory                                        |
| ‹D:\Repos\MCS›                                           |
| Repository is on ‹main› · 3 uncommitted files            |
|                                                          |
| +------------------------------------------------------+ |
| | ⚠ MCS will be checked out to ‹DEV› — 3 uncommitted   | |
| |   files in ‹D:\Repos\MCS›.                           | |
| |   [x] I understand                                   | |
| +------------------------------------------------------+ |
|                                                          |
| ⓘ Runs via Claude Code CLI. Concurrency limit:           |
|   2 of 3 sessions in use.                                |
|                                                          |
|                              [Cancel]  [Create]          |
+----------------------------------------------------------+
```

- **One action: `[Create]`.** It creates the Session in `created` and opens it; the operator starts it by typing the first prompt into the (enabled) composer, or with `[Start]` for a no-prompt start (§5.5). The former "Initial prompt (optional)" textarea and the `Create only` split action are both removed: the composer *is* the prompt field, one screen later, with more room, full keyboard affordances, and no second place to teach. Two prompt-entry surfaces for the same first prompt is a duplicated concept, and the split button forced a launch-mode decision before the operator had written anything.
- **Concurrency:** if the max-concurrent-sessions limit (PRD §4.4.2) is reached, `[Create]` stays enabled — creation is always legal — and the resulting Session shows the `⏳ Queued for launch` affordance (§5.5, WS1 §4.3) the moment it is started. The `ⓘ` line names current usage so the outcome is predictable before clicking.
- **Working directory (WC11):** the **resolved absolute native path** is shown, mono, per F8.1 path rules — not a repo nickname. This is the single most consequential and least visible parameter of a launch: the operator is about to give an agentic runtime write access to a directory, and "MCS" is not a directory.
- **Branch safety (WC11):** the modal shows the repository's **current branch** and **uncommitted-file count**, both read at open and refreshed when Repository changes. If the selected Branch differs from the current branch, a `--mc-warning` chip states **exactly what will happen** in plain language — "MCS will be checked out to ‹DEV› — 3 uncommitted files in ‹D:\Repos\MCS›" — and `[Create]` is blocked until `[x] I understand` is checked. When the selected branch equals the current branch the chip and checkbox are absent entirely (no ceremony for the safe path). The dirty-file count is shown even when branches match, as context.
- Spawn failure (`created → failed`, system-triggered per F7) surfaces as a danger toast + the session opens in `failed` state with the ErrorBanner.

### 5.5 Live Session view (PRD §4.2, §8.3)

The core operator screen. The shell's open-session set (§3.4) rendered as a tab bar across the top; conversation center; right panel with Commits / Files / Timeline / Notes; state-aware prompt composer bottom.

```
+----------------+---------------------------------------------------------------------------+
| nav            | [▶ Refactor queue port ✕][▶ Import inventory •3 ✕][‖ Fix nginx TLS ✕][+]  |
|                +---------------------------------------------------------------------------+
|                | Refactor queue port to batch enqueue                        [✎]           |
|                | mission-control · ‹DEV› · managed · Claude ‹1.0.x› on ‹mc-dev-win11›      |
|                | ‹0198a2f3-9c41-7bd2-a10e-3f7c8b1c4fa1› [copy]                             |
|                | ▶ running   00:42:10   ‹$0.4821›  ‹128.4k tok›      [Stop] [End] [⋯]      |
|                +-----------------------------------------------+---------------------------+
|                | [ Ctrl+F  queue        ]  3/7  [‹][›] [✕]     | [Commits][Files][Timeline]|
|                |                                               | [Notes]                   |
|                |  YOU                                   14:01  |---------------------------|
|                |  Refactor the queue port to expose            | COMMITS (2)               |
|                |  batch enqueue.                               | ‹e4f21b9› queue: add      |
|                |                                               |  batch enqueue            |
|                |  CLAUDE                                14:01  |  3 files · 14:32       [↧] |
|                |  I'll start by reading the QueuePort          | ‹b7d09c2› tests: batch    |
|                |  interface…                                   |  cases    2 files · 14:40 |
|                |                                               |                        [↧] |
|                |  ┌ ▸ tool: Read  packages/shared/queue.ts ┐   |                           |
|                |  │ status: ok · 1.2s                      │   |                           |
|                |  └──────────────────────────────────────--┘   |                           |
|                |  ┌ ▾ tool: Edit  packages/shared/queue.ts ┐   |                           |
|                |  │ status: running…                        │  |                           |
|                |  │ ‹--- a/packages/shared/queue.ts›        │  |                           |
|                |  │ ‹+++ b/packages/shared/queue.ts›        │  |                           |
|                |  │ ‹+  enqueueBatch(jobs: Job[]): …›       │  |                           |
|                |  └─────────────────────────────────────────┘  |                           |
|                |                                               |                           |
|                |  CLAUDE                             ⣾ 14:03   |                           |
|                |  Now updating the pg-boss driver to▌          |                           |
|                |  [ ● Streaming… ]      [Read latest response] |                           |
|                +-----------------------------------------------+---------------------------+
|                | [ Type a prompt… Ctrl+Enter to send                                  ][➤] |
+----------------+---------------------------------------------------------------------------+
```

**Layout & components**
- **Session tabs = the shell's open-session set (§3.4), rendered horizontally.** One tab per open Session with F7 **state glyph** dot + **title** + unread-activity dot with count; closable (`✕` removes it from the open set — it never ends the Session, and the same removal is reflected in the sidebar strip). `[+]` opens the Launch modal or an "attach/observe" picker. `Alt+1…9` selects, `Alt+[`/`Alt+]` step (§4.6). Tab dot and count update live on `session.state_changed` / channel activity — a background tab flipping to `failed` turns red, its glyph becomes `✕`, and a danger toast fires (§4.5). The tab bar and the sidebar strip are the same list by construction, so they cannot disagree about what is open.
- **Header, three lines:**
  1. **Title** at `--mc-fs-xl`, the page `h1`, with an inline `[✎]` edit affordance (`Enter` commits, `Esc` reverts; empty reverts to the derived title).
  2. Project · Branch · type · runtime metadata (Claude version, machine, environment — PRD §4.1).
  3. **Full Session UUID**, mono `--mc-fs-2xs`, `--mc-text-muted`, **click-to-copy** (copies the full ID, confirms with a toast). This is the *only* place the raw ID appears at full length — it exists for correlating with logs, `runtime_session_id`, and support-style debugging, which is exactly the job a full ID is good at and a truncated prefix is not.
  4. Action row: state badge, live duration, cost + tokens (mono; SDK-sourced for managed per F1.5), state-appropriate action buttons, `⋯` menu (Clone, Export, Generate Context Package, Archive when legal).
- **Conversation:** virtualized scroll; the four Message roles (F4: user / assistant / system / tool) render distinctly — user right-aligned label "YOU" with `--mc-bg-surface` block; assistant full-width on `--mc-bg-app`; system messages as centered `--mc-fs-2xs` muted rules ("Session started · model ‹…›"); tool messages as ToolCallBlocks.
- **Streaming indicator:** the in-flight assistant message shows a blinking block cursor `▌` at the text tip plus a `[ ● Streaming… ]` pill (pulse; static text under reduced motion). Autoscroll follows the stream; any manual scroll-up disengages it and shows a floating **`[↓ Jump to latest (n new)]`** chip — the count is the number of turns/blocks appended since follow disengaged, so the operator can tell "one paragraph appeared" from "the agent did nine things while I was reading". The count clears on jump.
- **ToolCallBlock:** collapsed by default — chevron, tool name (mono), primary argument (path/pattern), status (`running…` with spinner / `ok · 1.2s` / `error` in danger). Expanding reveals input and output in `--mc-bg-inset` mono, individually copyable, long output clamped at ~40 lines with "Show full".
- **Find in transcript (`Ctrl+F`, scoped):** when focus is inside the Conversation region, `Ctrl+F` is **intercepted** and opens the in-transcript FindBar instead of the browser's find — browser find only searches the DOM that exists, and the transcript is virtualized, so native find silently misses most of a long session and is worse than useless (it reports "not found" for text that is present). The FindBar shows the query, **match count and position (`3/7`)**, `[‹][›]` prev/next (`Enter`/`Shift+Enter`), and `[✕]`/`Esc` to close. It is **virtualizer-aware**: matching runs over the full committed Message set in the query cache, not the rendered window, and stepping to a match scrolls the virtualizer to that item and highlights it in place. Matches inside collapsed ToolCallBlocks expand the block when stepped to, and the block reports `n matches` while collapsed. `Ctrl+F` pressed anywhere else in the app is left to the browser.
- **Right panel** (`--mc-panel-w`, collapsible): panel-level tabs per PRD §8.3 —
  - **Commits:** Commits recorded during this Session (SHA mono, message, file count, time); click → expandable file list; **`[↧]` jumps the transcript to the moment this Commit was recorded**.
  - **Files:** de-duplicated list of files touched (from tool activity/commits), path mono, per-file touch count.
  - **Timeline:** the F7 transition log — every `session.state_changed` with timestamp and trigger (`user` | `system`), verbatim state names: `created → running (user) 13:58`, `running → paused (user) 14:20`, plus notable events (first commit, `session.completed`). **Every entry is click-to-scroll**: activating it moves the transcript to the corresponding point and flashes the target row.
  - **Notes:** free-text operator notes for this Session (feeds Obsidian Session Notes in Phase 2; plain textarea + saved indicator).
- **Panel↔transcript correlation (WC3):** Timeline and Commits entries are the operator's index into a long transcript — "what happened at 14:32" and "what produced this commit" are the two questions a 400-message session raises, and a side panel that only *lists* them makes the operator scroll-hunt for the answer. Click-to-scroll targets the nearest Message at or before the entry's timestamp; if the target has not been paged in yet, the virtualizer fetches the containing cursor page first (skeleton in place, no scroll jump afterwards) — the same path reverse-infinite-scroll already uses. If no corresponding transcript point exists (e.g., an observed session in degraded fidelity), the entry is not clickable and its tooltip says why.

**Prompt composer — per-F7-state affordances (canonical table)**

| State | Composer | Header actions | Extra surface |
|---|---|---|---|
| `created` | **Enabled**, placeholder "Send a prompt to start this session". Submitting performs **start-with-prompt**: the Session transitions `created → running` on spawn confirm (F7) and the prompt is delivered as the first turn | `[Start]` (alternate: starts with no prompt) | If launch is queued (concurrency saturated, WS1 §4.3), the composer shows a `⏳ Queued for launch` chip + `[Cancel launch]` ghost, the typed prompt is **retained** and sent when the slot frees; the Session stays `created` |
| `running` | Enabled; `Ctrl+Enter` send; send disabled only while empty. **Typing is always allowed, including while a turn is streaming** (see below) | **`[Stop]`** while a turn is in flight, otherwise `[Pause]`; `[End]` | Streaming indicator; queued-prompt entry below the streaming turn |
| `paused` | Disabled, hint "Session paused — resume to continue" | `[Resume]` primary, `[End]` | Amber banner strip "Paused by user at 14:20"; prompts pending at pause time redisplay in the composer for explicit re-send (WS1 §5.1 — never auto-replayed) |
| `completed` | Replaced by completion bar (below) | `[⋯]` menu only | — |
| `failed` | Replaced by failure ErrorBanner: reason, `code`, `requestId` (§4.3) + one-click `[Resume as new session]` (WS1 §4.4 recovery affordance) | `[⋯]` (Resume as new, Clone, Export, Archive) | Partial assistant turn retained above the banner (§ "Failure mid-stream") |
| `archived` | Replaced by muted bar "Archived" | `[⋯]` (Resume as new, Export) | Read-only watermark chip in header |

**`created` — one prompt field, not two.** The composer is live from the moment the Session exists; typing and sending is the natural start gesture, and it means the operator never meets a disabled text box whose only purpose is to tell them to press a button first. `[Start]` remains for the genuine no-prompt case (start the runtime now, decide what to ask in a moment — useful when a launch slot is contested). Both paths land in `running`; only the first carries a first turn. This resolves the divergence with WS4 §6.6 in WS4's favour, and §5.4.1's Launch modal drops its "Initial prompt" field accordingly.

**`[Stop]` — interrupting a turn in flight.** While an assistant turn is streaming, the header's `[Pause]` is replaced by **`[Stop]`** (secondary, `--mc-warning` text). It maps to the runtime interrupt WS1 §5.1 already specifies (SDK `interrupt()` on the active query): the current turn aborts and the partial assistant output already streamed is **persisted as an interrupted message, flagged on the timeline**. Critically, **`[Stop]` is not an F7 transition** — the Session stays `running`, holds its concurrency slot, and the composer stays enabled for the next prompt. It is "stop this turn", not "stop this session", and the button's tooltip says exactly that ("Stop the current turn · the session stays running"). `[Pause]` (which *is* the F7 `running → paused` transition and disposes the process per WS1 §5.1) returns to the header the moment the turn ends.

- **Keyboard:** `Esc` from the conversation region stops an in-flight turn. `Esc` from the composer still returns focus to the conversation region first (one press to leave the field, one to stop) — an operator hammering `Esc` to escape a runaway agent should never have to reach for the mouse, but a single stray `Esc` while typing must not kill a turn.
- **Confirmation:** none. Stopping is cheap, non-destructive (partial output is kept), and speed is the entire point.
- The interrupted turn renders in place with a terminating rule: `— turn stopped by operator 14:03:41`.

**Typing during a streaming turn.** Typing is never blocked, and `Ctrl+Enter` is enabled. The submitted prompt renders immediately as a **visibly-pending entry below the streaming turn** — `--mc-bg-surface` block, `--mc-text-muted`, prefixed `⏳ queued — will send when the current turn finishes` — and is delivered when the current turn completes (WS1 §4.2: the pump services the next inbox prompt when the turn goes idle). Pending entries are cancellable (`✕` on the entry) until delivery, at which point they become an ordinary user Message. Multiple pending prompts stack in submission order. Rationale: an operator watching an agent go down the wrong path must be able to type the correction *while they are thinking it*, not after the turn they are correcting has finished; and the previous specification left this case genuinely undefined — the composer was "enabled" with no statement of what a mid-stream send did.

**Failure mid-stream — the partial turn is kept (`running → failed`, `paused → failed`).**

When a Session transitions to `failed` while an assistant turn is in flight, the partially streamed text is **retained in place at normal emphasis** — not dimmed, not collapsed, not discarded — and is closed with a terminating rule:

```
|  CLAUDE                                                        14:03  |
|  Now updating the pg-boss driver to use the new batch API. I'll       |
|  start with the enqueue path and then rework the retry                |
|  — stream ended here · session failed 14:03:41 · ‹SESSION_PROCESS_EXIT› |
|    · requestId ‹0198a2f3-…-8b1c› [copy]                               |
```

The partial turn is the single most diagnostic artifact on the screen: the last thing the agent said before it died is usually *why* it died, and it is unrecoverable once dropped (the runtime never re-emits it). Discarding it to keep the render tree tidy destroys the operator's primary evidence at the exact moment they need it.

- **Reconciliation rule (clarifies WS4 §6.2):** "the committed Message wins over the partial buffer" applies **only when a canonical Message actually exists** for that turn. If the reconnect refetch returns no Message for the in-flight turn — the ordinary case for a crash, since the runtime never completed it — **the partial buffer is preserved and rendered as above**, marked as interrupted. The buffer is cleared only by a real replacement.
- **Stream death without session failure** (socket drop while the Session remains `running`): the streaming pill is replaced by `⏸ stream interrupted — reconnecting` on the partial turn, the partial text stays visible, and the §3.3 degraded-liveness treatment applies to the header. On reconnect, either the canonical Message arrives and replaces the partial, or streaming resumes and continues appending. **The transcript is never blanked** — a blank conversation reads as "nothing is happening" when the truth is "we lost the wire", and those two states must never look alike.
- The Timeline records the interruption (`stream interrupted 14:03:41`) so the gap is explicable after the fact.

Completion bar (`completed`):

```
+---------------------------------------------------------------------------+
| ✓ Session completed · 01:12:40 · ‹$1.21›                                  |
| [Resume as new session]  [Clone]  [Export]  [Context Package]  [Archive]  |
+---------------------------------------------------------------------------+
```

- **"Resume as new session"** label is deliberate: per F7, resuming a `completed`/`archived` Session always creates a NEW Session record (linked `resumed_from_session_id`); the UI never implies the old record reopens. The new Session opens in a new tab (and joins the open set, §3.4).
- **`archived` keeps `Resume as new session` and `Export`.** F7 lists `archived` as terminal *for the archived record*, but explicitly permits resume from `completed`/`archived` because resume produces a new Session rather than reviving the old one. Archiving is retention housekeeping, not a decision that the work is unrepeatable, and stripping resume from `archived` would make archiving a destructive-feeling act the operator avoids — which defeats the retention policy. `Clone` is also offered; `Archive` obviously is not.
- **Observed sessions:** composer area is replaced by a persistent muted bar `👁 Observed session — read-only`. Pause/Resume are **never rendered** — they are not applicable to a process the operator does not control (WS1 §5.2 applicability matrix; the API rejects them with `OPERATION_NOT_SUPPORTED` per WS2 §1.3). The single header action is `[Stop observing]`, which detaches Mission Control from the session and **never terminates the user's terminal process**. The confirm dialog must say so plainly: *"Mission Control will stop recording this session. The Claude Code session in your terminal keeps running."* Conversation, panels, and streaming render identically to managed sessions.
- **Observed-session fidelity degradation:** when transcript tailing fails and ingest falls back to hook-events-only (WS1 §6.3), the header gains an amber `⚠ Degraded fidelity` chip. **Data binding:** the chip renders from `Session.observation.degraded` on load (WS2 §6.1 — so it is correct on a cold page load, not only for a client that happened to be connected) and is raised live by the **`session.observation_degraded`** event on `session:{id}` (WS2 §6.9). Its popover reads: *"Live transcript unavailable — showing tool and lifecycle events only. Message text may be incomplete."* **The chip does not clear for the life of the Session** (WS7 arbitration A11): the tailer does not re-attach, because re-attaching cannot recover the lines already skipped — the transcript keeps its holes, so a "recovered" chip would overstate what the operator is looking at. The popover therefore states a durable fact, not a transient one. In this mode the conversation renders known tool/lifecycle events normally and shows a muted `--mc-bg-inset` strip where message bodies are unavailable — never a blank conversation, which would read as "nothing is happening" when the session is in fact active.
- **Send failure:** the outgoing user message stays in the composer (not lost), an inline ErrorBanner appears above it with the envelope + `[Retry]`.
- **WebSocket disconnect:** thin warning strip under the header — "Reconnecting… live updates paused" — plus the shell connection chip (§3.3), the frozen `~` durations, and the partial-turn treatment above. On reconnect the client refetches (no replay in V1 per F6.3) and the strip flashes success then hides.

**Mobile variant (monitoring):** conversation + composer only; header collapses to two lines (title, then state + duration + cost); right-panel tabs become a swipe-up sheet; session tabs become a horizontal chip scroller rendering the same open set (§3.4) with **glyph + truncated title + unread count**. Pause/Stop/Resume/End remain reachable (primary mobile monitoring actions), full-width `--mc-control-lg`.

```
+------------------------------+
| Refactor queue port…      ⌄  |
| ▶ running 42m ‹$0.48›        |
| [▶ Refactor…][▶ Import…•3][‖ Fix…] |
+------------------------------+
| CLAUDE              ⣾ 14:03  |
| Now updating the pg-boss     |
| driver to▌                   |
| [ ● Streaming… ]             |
|                              |
| ▸ tool: Edit queue.ts  run…  |
+------------------------------+
| [ Prompt…              ] [➤] |
| [   Stop    ] [    End    ]  |
+------------------------------+
| ≡ Commits · Files · Timeline |
+------------------------------+
```

On mobile the chip scroller is the only session switcher (there is no sidebar), which is why it must render the same set and the same unread counts as the desktop strip — a phone is where "did B fail while I was reading A?" is asked most often.

### 5.6 ADRs (Phase 2 — full detail)

#### 5.6.1 ADR list

```
+----------------+---------------------------------------------------------------------------+
| nav            |  ADRs                                              [+ New ADR]            |
|                |                                                                           |
|                |  Project [ All ▾ ]   [ Search titles… ]                                   |
|                |  +---------------------------------------------------------------------+  |
|                |  | ID       TITLE                          PROJECT        DATE         |  |
|                |  |---------------------------------------------------------------------|  |
|                |  | ADR-014  Queue on PostgreSQL (pg-boss)  mission-ctl    2026-08-11   |  |
|                |  | ADR-013  No Redis in V1                 mission-ctl    2026-08-11   |  |
|                |  | ADR-012  WebSocket as realtime channel  mission-ctl    2026-08-10   |  |
|                |  +---------------------------------------------------------------------+  |
+----------------+---------------------------------------------------------------------------+
```

#### 5.6.2 ADR detail

Sections verbatim per F4.1 Adr / PRD §7.3: Context, Decision, Alternatives, Consequences.

```
+----------------+---------------------------------------------------------------------------+
| nav            |  ADRs / ADR-013                                    [Edit]  [⋯]            |
|                |                                                                           |
|                |  ADR-013 — No Redis in V1                                                 |
|                |  mission-control · 2026-08-11 · from session "No Redis spike"             |
|                |  Synced to Obsidian ✓ 5 min ago  (ADRs/ADR-013.md)                        |
|                |                                                                           |
|                |  CONTEXT                                                                  |
|                |  Redis has no official native Windows build; dev parity requires…         |
|                |                                                                           |
|                |  DECISION                                                                 |
|                |  PostgreSQL is the single stateful substrate; pg-boss provides…           |
|                |                                                                           |
|                |  ALTERNATIVES                                                             |
|                |  Memurai on Windows dev; in-process queue; embedded substitute…           |
|                |                                                                           |
|                |  CONSEQUENCES                                                             |
|                |  One fewer service; queue depth visible in Services health…               |
+----------------+---------------------------------------------------------------------------+
```

**Interaction notes**
- Primary actions: New ADR (modal: title, project, four template sections), Edit (inline section editing).
- Origin link: ADRs generated from a Session (PRD §7.2) show a backlink chip **labelled with the Session title**, not its ID (§2.2).
- Obsidian sync status line per document: synced ✓ / pending ↻ / conflict ⚠ (conflict links to the conflict-policy setting §5.7.6). Sync failures also produce an inbox notification (`sync.failed`).
- Empty: "No ADRs yet. ADRs can be generated from sessions or written here. · [New ADR]".

### 5.7 Settings (PRD §4.4, §8.6 — full detail)

Two-pane layout: category rail (left, within the content area) + active category panel. Every mutable panel has a sticky Save bar that appears on dirty state. Every save writes to the audit log (PRD §4.4 behaviors) and emits `setting.updated`; the UI confirms with a success toast.

**Dirty-state contract (uniform across every Settings panel).** Settings is the one screen where a silently-lost edit is expensive — half of it is credentials and integration wiring whose failure only shows up later, somewhere else, as a broken integration. So dirty state is stated, not implied:

- **The sticky Save bar names the count of changed fields:** `3 changes  [Discard] [Save changes]` (`1 change` singular; secrets counted as described in §4.4). A bare `[Save changes]` tells the operator that *something* is unsaved without telling them how much they are about to lose by discarding.
- **Each changed field is marked** with a `--mc-accent` left rule and a `changed` micro-label, so "3 changes" is verifiable at a glance rather than a number to be trusted.
- **Category or route change while dirty raises a guard modal** (sm, focus-trapped): *"Unsaved changes — you have 3 unsaved changes in Integrations → GitHub."* with `[Discard] [Keep editing] [Save]`. `[Keep editing]` is the default focus; `[Discard]` is danger-styled. This covers the category rail, the main nav, the command palette, and browser back/forward.
- **`beforeunload` is registered while any panel is dirty**, so tab close and reload get the browser's own confirmation. The two mechanisms are complementary: the guard modal covers in-app navigation (where `beforeunload` never fires in an SPA), `beforeunload` covers leaving the app.
- **`Ctrl+S`** saves the dirty panel from anywhere within it.

```
+----------------+---------------------------------------------------------------------------+
| nav            |  Settings                                                                 |
|                |  +---------------+-----------------------------------------------------+  |
|                |  | General       |                                                     |  |
|                |  | Integrations  |            <active category panel>                  |  |
|                |  | Notifications |                                                     |  |
|                |  | Memory    ·P3 |                                                     |  |
|                |  | Agents    ·P4 |                                                     |  |
|                |  | Security      |                                                     |  |
|                |  | Services      |                                                     |  |
|                |  +---------------+-----------------------------------------------------+  |
+----------------+---------------------------------------------------------------------------+
```

Mobile: the category rail becomes a full-screen list; tapping drills into the panel with a back header.

The `Memory ·P3` and `Agents ·P4` rail entries use the §2.5 phase-gated treatment — full-contrast label, muted phase Badge, normal focus and hover, never `disabled`/`aria-disabled` — and route to their placeholder panels (§5.7.9, §5.7.10).

#### 5.7.1 General

```
+---------------------------------------------------------------+
| GENERAL                                                       |
|                                                               |
| Instance name        [ Mission Control — Home ]               |
| Timezone             [ Europe/Amsterdam ▾ ]                   |
| Date format          [ YYYY-MM-DD ▾ ]   Time [ 24h ▾ ]        |
| Theme                [ Dark (default) ▾ ]                     |
| Default landing page [ Dashboard ▾ ]                          |
|                                                               |
|                              [Discard] [Save changes]         |
+---------------------------------------------------------------+
```

#### 5.7.2 Integrations — layout and shared Test Connection pattern

Integrations panel lists six integration cards (GitHub, Claude Code, Telegram, Obsidian, Qdrant, Ollama), each expandable, each with its own Save + **Test Connection**. Bootstrap settings (DB connection, port, encryption key) deliberately do **not** appear anywhere in Settings — per F8.2 they are env-file-only; a muted footnote says so: "Database connection, listen address, and encryption key are bootstrap settings configured in the server environment file."

Test Connection feedback states (uniform across integrations):

```
idle:      [Test Connection]
dirty:     [Test Connection]  (disabled)   Save changes to test
testing:   [⟳ Testing…]  (disabled, spinner)
success:   [Test Connection]
           ✓ Tested saved settings · Connected as cento007 · 2 orgs · 231 ms · 14:07
failure:   [Test Connection]
           +-------------------------------------------------------------+
           | ✕ Tested saved settings · Token rejected by GitHub (401).   |
           |   [GITHUB_AUTH_FAILED]   requestId: ‹0198…9d2e› [copy]      |
           +-------------------------------------------------------------+
```

**Test Connection always tests persisted state — never form contents.** While the panel is dirty the button is **disabled** with the inline hint **"Save changes to test"**, and the success line always begins **"Tested saved settings · ‹detail› · ‹time›"**.

Rationale: a test whose scope depends on which fields happen to be dirty is a test whose result cannot be interpreted. "It works" would mean "it works with the values on your screen", while the running system — workers, pollers, the Telegram dispatcher — uses the values in the database; a green check on unsaved input is a false pass on the exact question the operator asked. The "as-entered where safe" carve-out for path fields is deleted: it made the semantics field-dependent and therefore unlearnable, and path validation is already covered by the per-row `✓ valid` / `✕ not found` hints (§5.7.3), which are explicitly *field* validation, not a connection test. This aligns verbatim with WS4 §7.4 ("Tests run against saved settings … the UI never merges unsaved form values into a test").

Result text is integration-specific on success (see each panel); results are ephemeral client state and are cleared when the panel becomes dirty again (a result describing a previous configuration must not linger next to edited fields).

#### 5.7.3 Integrations → GitHub

```
+---------------------------------------------------------------+
| GITHUB                                        ● Connected     |
|                                                               |
| Personal access token   •••••••••••• (saved 2026-08-10 09:14) |
|                         [Replace] [Clear]                     |
|   Secrets are encrypted at rest and cannot be viewed          |
|   after saving.                                               |
| Account / organizations [ cento007          ] [+ add]         |
| Discovery root paths    ‹D:\Repos›               [✓ valid] ✕  |
|                         ‹E:\Work\clients›        [✓ valid] ✕  |
|                         [+ Add path]                          |
| Sync / polling interval [ 5 minutes ▾ ]                       |
|                                                               |
| Workflow mode           ( ) Manual   (•) Assisted             |
|   ⓘ Assisted lets Mission Control propose commit messages,    |
|     branch names, and PR descriptions for your approval.      |
|     Manual records git activity but never proposes actions.   |
|     Projects can override this individually.                  |
|                                                               |
| [Test Connection]                                             |
|   ✓ Tested saved settings · Connected as cento007 · 231 ms    |
|                       1 change  [Discard] [Save changes]      |
+---------------------------------------------------------------+
```

- Success feedback names the authenticated account. Paths are validated per-row (exists + readable) with inline `✓ valid` / `✕ not found` hints; native absolute paths, mono (F8.1 path rules).
- **Workflow mode (PRD §4.3, WC13):** this is the global default for the two workflow modes the PRD specifies as Phase 1 functionality — until now they had **no surface anywhere in the UI**, which made a stated Phase 1 requirement unimplementable from the design. It lives under GitHub because both modes are entirely about git/PR behaviour. Per-Project override lives on the Project detail header (§5.3.2); the effective mode for a Session is the Project's, falling back to this default. Changing it emits `setting.updated` and is audit-logged like any other setting.
- Secret actions are `[Replace]` and `[Clear]` per §4.4 — no per-field save; the panel Save bar is the single commit path.

#### 5.7.4 Integrations → Claude Code

```
+---------------------------------------------------------------+
| CLAUDE CODE                                   ● Connected     |
|                                                               |
| CLI executable path    ‹C:\Users\…\claude.exe›   [✓ found]    |
| Default model          [ claude-sonnet-4-5 ▾ ]                |
| Max concurrent sessions[ 3 ]                                  |
| Cost budget alerts     [x] Enabled                            |
|   Daily budget         [ $ 10.00 ]  alert at [ 80 ▾ ] %       |
|   Today ‹$3.42› of ‹$10.00› · 34%   [View on Dashboard →]     |
|                                                               |
| [Test Connection]                                             |
|   ✓ Tested saved settings · claude ‹v1.0.x› · 89 ms           |
|                              [Discard] [Save changes]         |
+---------------------------------------------------------------+
```

- Test Connection here validates the executable path and reports the CLI version. (PRD §4.4 lists Test Connection for five integrations; Claude Code gains the same affordance as path validation — WS2 already owns a health/test surface, no new concept.) No secret field: CLI auth belongs to Claude Code itself.
- **Current spend is shown next to the budget that governs it** (WC1) and deep-links to the Dashboard Spend widget (§5.2). A budget field with no visible current value asks the operator to set a limit against a number the product knows and does not show.

#### 5.7.5 Integrations → Telegram

```
+---------------------------------------------------------------+
| TELEGRAM                                      ○ Disabled      |
|                                                               |
| Enabled                [ off ⟋ ]                              |
| Bot token              [ Not set                ]             |
| Chat ID                ‹                        ›             |
|                                                               |
| [Test Connection]  → sends a test message to the chat         |
|                              [Discard] [Save changes]         |
+---------------------------------------------------------------+
```

- Success feedback: "✓ Test message delivered to chat ‹-100123…›". Card header status reflects enable toggle + last known worker delivery health.

#### 5.7.6 Integrations → Obsidian

```
+---------------------------------------------------------------+
| OBSIDIAN                                      ● Syncing       |
|                                                               |
| Vault path       ‹D:\Vaults\Engineering›       [✓ valid]      |
| Sync mode        (•) Two-way  ( ) One-way  ( ) Paused         |
| Sync interval    [ 15 minutes ▾ ]                             |
| Conflict policy  [ Newest wins ▾ ]                            |
|                  (Newest wins / Vault wins / Mission Control  |
|                   wins / Keep both & flag)                    |
|                                                               |
| Last sync ✓ 14:32 · 42 notes · 0 conflicts                    |
| [Test Connection]  ✓ Vault readable & writable · 12 ms        |
|                              [Discard] [Save changes]         |
+---------------------------------------------------------------+
```

- "Paused" sync mode shows an amber card-header status. Conflict count links to inbox entries for `sync.failed` / conflict notifications.

#### 5.7.7 Integrations → Qdrant and Ollama

> **Phase 3 — interface only.** This section is a placeholder/extension point.
> Detailed design is out of TDS scope per the project-plan scope guard.

Both forms are wireframed (they are simple forms, per the WS5 phase guard) but render behind a phase notice; fields are editable so configuration can be staged, and Test Connection is present but returns the WS2 stub behavior until Phase 3.

```
+---------------------------------------------------------------+
| QDRANT                              ◌ Not active (Phase 3)    |
| ⓘ Semantic memory arrives in Phase 3. You can configure and   |
|   test the connection now; nothing is indexed yet.            |
|                                                               |
| Host             ‹127.0.0.1›          Port [ 6333 ]           |
| API key          [ Not set            ]                       |
| Embedding model  [ nomic-embed-text ▾ ]                       |
|                                                               |
| [Test Connection]                                             |
|                              [Discard] [Save changes]         |
+---------------------------------------------------------------+

+---------------------------------------------------------------+
| OLLAMA (optional)                   ◌ Not active (Phase 3+)   |
|                                                               |
| Enabled          [ off ⟋ ]                                    |
| Host             ‹127.0.0.1›          Port [ 11434 ]          |
| Default model    [ (fetched after test) ▾ ]                   |
|                                                               |
| [Test Connection]                                             |
|                              [Discard] [Save changes]         |
+---------------------------------------------------------------+
```

#### 5.7.8 Notifications

```
+---------------------------------------------------------------+
| NOTIFICATIONS                                                 |
|                                                               |
| EVENTS                                                        |
| [x] Session complete       (summary, commits, duration)      |
| [x] Daily report           deliver at [ 18:00 ]              |
| [x] Alerts                 (failed syncs, repository         |
|                             problems, session errors)        |
|                                                               |
| QUIET HOURS                                                   |
| [x] Enabled   from [ 23:00 ] to [ 07:30 ]                     |
|     ⓘ During quiet hours, alerts go to the inbox only;        |
|       Telegram delivery resumes afterwards.                   |
|                              [Discard] [Save changes]         |
+---------------------------------------------------------------+
```

#### 5.7.9 Memory (category)

> **Phase 3 — interface only.** This section is a placeholder/extension point.
> Detailed design is out of TDS scope per the project-plan scope guard.

```
+---------------------------------------------------------------+
| MEMORY                              ◌ Available in Phase 3    |
|                                                               |
| Planned controls: retention policy per memory tier (session / |
| project / agent / global) and indexed sources (Sessions,      |
| Commits, ADRs, Obsidian notes, PR descriptions, docs).        |
+---------------------------------------------------------------+
```

#### 5.7.10 Agents (category)

> **Phase 4 — interface only.** This section is a placeholder/extension point.
> Detailed design is out of TDS scope per the project-plan scope guard.

```
+---------------------------------------------------------------+
| AGENTS                              ◌ Available in Phase 4    |
|                                                               |
| Planned controls: default runtime, default permission         |
| template.                                                     |
+---------------------------------------------------------------+
```

#### 5.7.11 Security

```
+---------------------------------------------------------------+
| SECURITY                                                      |
|                                                               |
| CHANGE PASSWORD                                               |
| Current password  [ ••••••••         ]                        |
| New password      [ ••••••••         ]                        |
| Confirm           [ ••••••••         ]     [Update password]  |
|                                                               |
| SESSION TIMEOUT                                               |
| Sign out after    [ 7 days ▾ ] of inactivity                  |
|                                                               |
| API TOKENS                                                    |
| +-----------------------------------------------------------+ |
| | NAME        CREATED      LAST USED     PREFIX             | |
| | cli-laptop  2026-08-01   2h ago        ‹mct_a1b2…› [Revoke]| |
| | obsidian    2026-07-20   never         ‹mct_9f3e…› [Revoke]| |
| +-----------------------------------------------------------+ |
| [+ Create token]                                              |
|                                                               |
| AUDIT LOG                                                     |
| Retention        [ 180 days ▾ ]         [View audit log →]    |
+---------------------------------------------------------------+
```

- **Create token modal:** name → create → the full token is shown **exactly once** in a mono copy field with a danger-tinted note "You won't see this again", then only the prefix is ever displayed (hashed at rest per F5.5). Revoke requires confirm modal.
- "View audit log" opens a read-only dense table (time, actor, action, target — from `audit_log_entries`), filterable by action type. Setting changes made anywhere in this Settings page appear here.

#### 5.7.12 Services (read-only health, PRD §4.4.7)

Per F2.1, the queue row is **"Queue (PostgreSQL)"** — Redis does not exist in this topology.

```
+---------------------------------------------------------------+
| SERVICES                                  auto-refresh 10s ↻  |
|                                                               |
| +-----------------------------------------------------------+ |
| | SERVICE            STATUS       DETAIL                    | |
| |-----------------------------------------------------------| |
| | ● PostgreSQL       healthy      ‹16.3› · 4 ms             | |
| | ● Queue (PostgreSQL) healthy    depth 2 · 0 failed jobs   | |
| | ● Telegram Worker  healthy      heartbeat 3 s ago         | |
| | ▲ Sync Worker      degraded     last job failed 14:02     | |
| |                                 [view error]              | |
| | ◌ Qdrant           not configured  (Phase 3)              | |
| | ◌ Ollama           disabled                               | |
| +-----------------------------------------------------------+ |
|                                                               |
| Backend ● healthy · uptime 3d 4h · ‹v0.1.0›                   |
+---------------------------------------------------------------+
```

- HealthRow states: `● healthy` (success), `▲ degraded` (warning), `✕ down` (danger), `◌ not configured / disabled` (muted), `⟳ checking`. `[view error]` expands the last error with the §4.3 envelope treatment.
- Workers report via heartbeat (WS1 §7.2 owns the mechanism and thresholds). Vocabulary mapping, so the two documents agree: WS1's heartbeat status `healthy` → `● healthy`; `stale` (heartbeat older than 90 s) → `▲ degraded`, subtext "last seen 2 m ago"; `down` (older than 5 min) → `✕ down`. The row's `degraded` state is also used for a healthy-heartbeat worker reporting job failures (e.g., "last job failed 14:02").
- This panel is also the deep-link target of health-related toasts and inbox alerts.

---

## 6. Phase 3–5 Placeholder Screens

### 6.1 Memory page

> **Phase 3 — interface only.** This section is a placeholder/extension point.
> Detailed design is out of TDS scope per the project-plan scope guard.

Navigation entry exists at full label contrast with a muted `P3` Badge and normal focus/hover (§2.5 phase-gated treatment, §3.1) — reachable, never `disabled`. The shell reserves the layout: a search field and results region, so Phase 3 slots the semantic-search UI (PRD §8.4) without moving navigation.

```
+----------------+-----------------------------------------------------------+
| nav            |  Memory                                                   |
|                |                                                           |
|                |  [ Ask your engineering memory…                    ] [→]  |
|                |                                                           |
|                |     ◌ Semantic memory arrives in Phase 3.                 |
|                |       Qdrant-backed search across sessions, commits,      |
|                |       ADRs, notes, PRs, and docs.                         |
|                |       [Configure Qdrant in Settings →]                    |
+----------------+-----------------------------------------------------------+
```

### 6.2 Agents page

> **Phase 4 — interface only.** This section is a placeholder/extension point.
> Detailed design is out of TDS scope per the project-plan scope guard.

Shell reserves tabs matching PRD §8.5 scope (Global agents / Project agents / Teams) so Phase 4 fills panels without re-architecting navigation.

```
+----------------+-----------------------------------------------------------+
| nav            |  Agents                                                   |
|                |                                                           |
|                |  [ Global ] [ Project ] [ Teams ]                         |
|                |                                                           |
|                |     ◌ The agent framework arrives in Phase 4.             |
|                |       Agents are specialized personas operating           |
|                |       through runtimes (Runtime → Agent → Task).          |
+----------------+-----------------------------------------------------------+
```

---

## 7. Accessibility

Target: **WCAG 2.1 AA** for all Phase 1–2 screens.

### 7.1 Contrast (measured, not asserted)

Every ratio below is computed from the §2.1 hex values against the actual background layers those tokens are used on.

- `--mc-text-primary` `#E6EDF3` on any background layer: ≥ 12:1.
- `--mc-text-secondary` `#A0ABBB` on any background layer: ≥ 6:1.
- **`--mc-text-muted` `#838D9C`: ≥ 4.5:1 on ALL three layers** — 5.64:1 on `--mc-bg-app`, 5.16:1 on `--mc-bg-surface`, 4.71:1 on `--mc-bg-raised`. **The former layer restriction ("muted is restricted to layer-0/1 and never used on `--mc-bg-raised`") is deleted.** It was unenforceable and already violated by this document's own wireframes — the §5.4.1 Launch modal hint, EmptyState copy inside Cards, toast body text, and the "Showing 50" pagination line are all muted text on layer 1 or 2. A rule that the design breaks in four places is not a rule; the correct fix is a token that passes everywhere it is realistically used, which is why `--mc-text-muted` moved from `#768090` (4.34:1 on `--mc-bg-surface`, 3.95:1 on `--mc-bg-raised` — both AA failures) to `#838D9C`.
- **`--mc-state-archived` `#818B96` on `--mc-state-archived-subtle` `#191E26`: 4.83:1** (was `#6E7681` at 3.62:1 — an AA failure), so the archived badge follows the same full-strength-on-subtle recipe as the other five states with no muted-label exception (§2.1.6).
- **`--mc-on-accent` `#06101F` on `--mc-accent` `#4D9FFF`: 7.0:1 — documented as ≥ 6.5:1.** The previous "≥8:1" claim was simply wrong; an overstated contrast figure is worse than none because it suppresses the check that would have caught it.
- Session-state and status colors hold ≥ 3:1 against `--mc-bg-app`/`--mc-bg-surface` for UI-component contrast (dots, borders, icons); used as **text**, they always sit on their `-subtle` background at ≥ 4.5:1 (badge pattern §2.1.6).
- Colour is never the sole carrier of meaning: state badges include the verbatim F7 state name, **every StatusDot carries its state glyph** (§2.1.6), health rows include status words, the streaming pill includes the word "Streaming", Needs Attention rows are glyph-prefixed, and required-field/error states pair colour with icon + text.

**WS6 test-contract assertion list (binding).** The design-token test suite asserts these pairs directly — token-pair assertions, not per-component snapshots, so a token change fails the build rather than a screenshot:

| # | Foreground | Background | Floor | Measured |
|---|---|---|---|---|
| 1 | `--mc-text-primary` | `--mc-bg-app` / `-surface` / `-raised` | 4.5:1 | ≥ 12:1 |
| 2 | `--mc-text-secondary` | `--mc-bg-app` / `-surface` / `-raised` | 4.5:1 | ≥ 6:1 |
| 3 | **`--mc-text-muted`** | **`--mc-bg-surface`** | **4.5:1** | **5.16:1** |
| 4 | **`--mc-text-muted`** | **`--mc-bg-raised`** | **4.5:1** | **4.71:1** |
| 5 | `--mc-text-muted` | `--mc-bg-app` | 4.5:1 | 5.64:1 |
| 6 | **`--mc-state-archived`** | **`--mc-state-archived-subtle`** | **4.5:1** | **4.83:1** |
| 7 | each `--mc-state-*` | its `--mc-state-*-subtle` | 4.5:1 | ≥ 4.5:1 |
| 8 | **`--mc-on-accent`** | **`--mc-accent`** | **4.5:1** | **7.0:1** |
| 9 | each `--mc-state-*` / status colour | `--mc-bg-app`, `--mc-bg-surface` | 3:1 (non-text) | ≥ 3:1 |
| 10 | `--mc-border-focus` ring | `--mc-bg-app`, `--mc-bg-surface`, `--mc-accent` | 3:1 (non-text) | ≥ 3:1 |

Rows 3, 4, 6, and 8 are the four pairs this pass corrected; they are called out because they are the ones a future palette tweak is most likely to break silently. `--mc-text-disabled` is deliberately excluded — WCAG exempts disabled controls — which is also why §2.5 forbids using it on phase-gated navigation, which is *not* disabled.

### 7.2 Focus visibility

- Universal `:focus-visible` ring: `2px solid var(--mc-border-focus)`, `outline-offset: 1px`, on every interactive element including table rows, session tabs, tool-call chevrons, and toast dismiss buttons. Never suppressed; on accent-filled buttons the ring gains a 1px `--mc-bg-app` gap for visibility against the accent fill.
- Focus is programmatically managed at route change (focus the page `h1`), modal open (trap, first field), modal close (restore invoker), and toast action ("View" in a toast is reachable via `F6`-style region cycling, not stolen focus).

### 7.3 Keyboard navigation (operator workflows)

- All §4.6 shortcuts; full app operable without a pointer. The `?` cheat-sheet modal renders the §4.6 table **verbatim and in full** — including `Ctrl+K`, `Alt+1…9`, and `Alt+[`/`Alt+]` — so the documented shortcuts and the discoverable shortcuts are the same set.
- **Text-entry suppression rule (global, mandatory):** **all single-key shortcuts and all chords are suppressed while focus is inside an `input`, `textarea`, or `contenteditable`** — the only exceptions are `Esc` and the send binding (`Ctrl+Enter`). Without this rule, typing the word "grand" in the Notes field navigates to ADRs, and typing "n" in a filter box opens a New Session modal. `Ctrl+K` and `Ctrl+F` are also suppressed inside text entry (a chord that hijacks the field the operator is typing in is the same bug wearing a modifier).
- **Browser-reserved chords are not used.** `Ctrl+1…9` never reaches page JavaScript in Chrome, Edge, or Firefox (it switches *browser* tabs), which is why session switching is `Alt+1…9` (§4.6). The same rule retires `Ctrl+W`, `Ctrl+T`, and `Ctrl+N` from consideration.
- **Tables/lists:** arrow-key row traversal, `Enter` opens, `o` overflow menu on focused row.
- **Live Session view:** `Ctrl+Enter` send; `Alt+1…9` / `Alt+[` / `Alt+]` session switching; `Ctrl+F` in-transcript find; `Esc` from composer returns focus to the conversation region, and `Esc` from the conversation region stops an in-flight turn (§5.5); tool-call blocks toggle with `Enter`/`Space`.
- **Settings:** category rail is a vertical `listbox`/nav with arrow traversal; Save bar reachable via `Tab` from any field; `Ctrl+S` triggers panel Save when dirty; the dirty guard modal (§5.7) traps focus with `[Keep editing]` focused by default.
- Streaming, pulsing dots, skeleton shimmer, and toast slide all honor `prefers-reduced-motion: reduce` (static equivalents; the `running` dot becomes a static filled dot with a ring, glyph retained).
- Screen-reader landmarks: nav rail (`nav`), top bar (`banner`), page (`main`), right session panel (`complementary`), toasts (`status` / danger `alert`).

### 7.4 Streaming transcript accessibility (the core output surface)

The live transcript is the product's primary output. Announcing it badly excludes screen-reader users from the thing they came for; announcing it naively floods them with token-by-token noise and makes the app unusable. The previous formulation ("`aria-live="polite"` off") was also self-contradictory — `polite` and `off` are mutually exclusive values of the same attribute — so this section replaces it with an unambiguous five-part specification.

1. **The transcript container is `role="log"` with `aria-live="off"`.** `role="log"` conveys the semantics (an append-only record) to assistive technology; `aria-live="off"` means the container itself never auto-announces. Streaming assistant text mutates dozens of times per second, and any live value on the container would queue an announcement per mutation.
2. **A separate visually-hidden `aria-live="polite"` region announces boundaries and outcomes only** — never content deltas. Its complete announcement vocabulary:
   - `"Claude is responding"` (turn start)
   - `"Response complete, 4 tool calls"` (turn end, with tool-call count; `"Response complete"` when zero)
   - `"Turn stopped"` (operator `[Stop]`)
   - `"Session failed"` / `"Session completed"` / `"Session paused"` (verbatim F7 state names)
   - `"Stream interrupted, reconnecting"` (§3.3 / §5.5)
   - `"Prompt queued, will send when the current turn finishes"` (mid-stream send)

   One announcement per event, never per delta. This is the difference between a usable narration ("something is happening, and now it's done") and an unusable one.
3. **On turn completion the committed message becomes `role="article"` with `tabindex="-1"`,** and a **persistent "Read latest response" button** (visible in the conversation region, shortcut listed in the cheat sheet) moves focus to it. Focus is never stolen automatically — a focus jump mid-reading is its own accessibility failure — but the path from "the polite region told me a response is complete" to "I am now reading it" is one deliberate keystroke. From there, standard screen-reader reading commands traverse the message at the user's pace. Each committed message also carries an accessible name of the form `"Claude, 14:03, 4 tool calls"`.
4. **ToolCallBlocks expose `aria-expanded`** (they are disclosure buttons) and an accessible name that carries the whole summary without expansion: **`"tool Read, packages/shared/queue.ts, completed in 1.2 seconds"`** — tool, primary argument, outcome, duration. Failed calls read `"…, failed"`; in-flight calls read `"…, running"`. A collapsed tool call must be comprehensible without opening it, because that is exactly the scanning behaviour sighted operators get from the collapsed row.
5. **`aria-busy="true"` on the streaming message while the turn is in flight**, removed on commit — so assistive technology knows the subtree is mid-update and does not present a truncated sentence as final.

Additionally: the `[↓ Jump to latest (n new)]` chip is a real button with an accessible name including the count (`"Jump to latest, 3 new"`); the FindBar reports `"3 of 7 matches"` through its own polite region; and the connection chip (§3.3) is `role="status"` so a transition to `reconnecting`/`offline` is announced once — a screen-reader user has no peripheral vision for a dot in the corner, and the liveness of everything else depends on it.

---

## 8. Handoff Notes & Open Items

### 8.1 For WS4 (frontend architecture)

- Token names and values in §2 are the canonical contract; WS4 maps them into the Tailwind 4 theme (mechanism is WS4's call). Both font families are **self-hosted `woff2` in `apps/frontend`, `font-display: swap`, no CDN** (§2.2) — this is a hard requirement of a LAN-only product, not a preference.
- Component inventory §2.5 is the build list for the shared UI layer; MessageBlock/ToolCallBlock virtualization, autoscroll, and virtualizer-aware find (§5.5) are the perf-critical items.
- **Shared surfaces reconciled with WS4 in this pass** (both documents now agree; WS4 is applying the matching edits):
  - `created` composer is **enabled** with start-with-prompt; `[Start]` is the no-prompt alternate (§5.5, WS4 §6.6). The Launch modal has no initial-prompt field and a single `[Create]` action (§5.4.1).
  - Session detail keeps WS5's **right-panel** layout (Commits/Files/Timeline/Notes as a collapsible panel beside the conversation), not sibling page tabs — WS4 §2.2 absorbs this.
  - Test Connection **always tests persisted state**; disabled while dirty (§5.7.2, WS4 §7.4). SecretField exposes `[Replace]`/`[Clear]` with **no per-field save** (§4.4, WS4 §7.3).
  - The session switcher is **shell-level** (§3.4) and is the same set WS4 §6.5 keeps in `uiStore`; the Live Session tab bar renders that set rather than a second one.
- **Live regions to wire to F5.6 WebSocket channels** (each gets the §3.3 degraded treatment when the connection chip is not `live`, including frozen `~` durations): sidebar running count, sidebar open-sessions strip, Dashboard Needs Attention widget, Dashboard Active Sessions widget, Dashboard spend stat + top-bar spend chip, sessions table state cells and durations, session tab dots and unread counts, live conversation and streaming pill, toast/inbox dispatch. The Services panel and its Dashboard variant are **polled**, not socket-driven (§5.2).
- **Keyboard:** `Alt+1…9` and `Alt+[`/`Alt+]` for session switching (**never `Ctrl+1…9`** — browser-reserved), `Ctrl+K` command palette, `g r` for ADRs, plus the text-entry suppression rule in §7.3.

### 8.2 Flags for WS7 (no foundation conflicts; cross-checks requested)

1. **"Upcoming Tasks" widget (PRD §8.1)** — **one behaviour still needs to be picked, and WS7 should arbitrate.** WS5 §5.2 assumes a **schedule read model** (daily-report time, next Obsidian sync, next repo poll — read-only, no new F4 entity); WS4 §2.2 states the widget renders an **empty-state placeholder in V1**. Both are defensible and they are mutually exclusive on screen. The decision hinges on whether WS2/WS3 expose a schedule read surface at all; if they do not, WS4's placeholder wins by default and §5.2's widget is hidden rather than empty. This is the only open behavioural divergence left between WS4 and WS5 after this pass.
2. **Claude Code Test Connection** (§5.7.4): PRD §4.4 lists Test Connection for five integrations; this design extends the same affordance to the Claude Code CLI path (version probe). WS2 to confirm a test/health surface for it.
3. ~~**Turn interrupt as an addressable action**~~ **RESOLVED** — WS2 §6.3.1 now specifies `POST /api/v1/sessions/{id}/interrupt`: stops the in-flight turn with **no F7 transition** and no `session.state_changed`, persisting the partial assistant Message with `status = 'interrupted'` (WS3 `messages.status`). Errors `SESSION_NOT_RUNNING`, `NO_TURN_IN_FLIGHT`, `OPERATION_NOT_SUPPORTED` (observed sessions). This is the contract behind `[Stop]` in §5.5.
4. ~~**Workflow modes**~~ **RESOLVED** — WS7 blocking findings B11a/B11b assign the storage and the setting: `projects.workflow_mode` CHECK (`manual`,`assisted`) as the per-Project override (WS3) and `GithubSettings.workflowMode` as the global default (WS2). Assisted *actions* (PR description generation, review summaries) remain Phase 2; the setting itself is Phase 1, matching §5.7.3 and §5.3.2.
5. ~~**Observed-session action surface**~~ **RESOLVED** — WS1 §5.2 landed its applicability matrix; §5.5 specifies `[Stop observing]` as the sole action (detach, never kill), no Pause/Resume, plus the `⚠ Degraded fidelity` chip for hook-only ingest (WS1 §6.3). Worker-health vocabulary reconciled with WS1 §7.2 in §5.7.12 (`stale` → `▲ degraded`).
6. ~~**WS4/WS5 divergences** (composer in `created`, session-detail layout, Test Connection dirty semantics, SecretField save path, switcher scope)~~ **RESOLVED** — see §8.1; both documents were amended in the same pass.

### 8.3 Design critique record

The `ui-ux-designer` structured critique pass required by project plan §3 (WS5 row) was performed and **fully incorporated on 2026-08-11**. Twelve must-fix findings and eight secondary findings were accepted and applied; the document status is therefore **final**. Summary of what changed:

| # | Finding | Resolution |
|---|---|---|
| MF1 | UUIDv7 prefixes used as the primary human label — near-identical for same-hour Sessions | Title-first labelling everywhere; `project · branch` secondary; last-6-hex `ID` column; full ID only in the detail header (§2.2, §5.2, §5.4, §5.5) |
| MF2 | Dashboard could not answer "what failed / what needs attention" | **Needs Attention** widget first in grid and mobile stack, four sources, deep-linking, one-line "All clear"; Services strip on Dashboard (§5.2) |
| MF3 | No connection-liveness indicator despite WS4 §5.1 requiring one | Connection chip in top bar + mobile header; degraded-emphasis rule and **frozen durations** for all live regions (§3.3) |
| MF4 | `created` composer disabled in WS5, enabled in WS4 | Resolved in WS4's favour: enabled, start-with-prompt; `[Start]` alternate; Launch modal simplified to `[Cancel] [Create]` (§5.4.1, §5.5) |
| MF5 | Multi-session switcher trapped inside one screen; layout divergence | Switcher promoted to **shell level** (§3.4), tab bar renders the same set; right-panel layout retained; unread counts + "(n new)"; open set persists across reload |
| MF6 | No way to stop a turn; mid-stream typing undefined | `[Stop]` replaces `[Pause]` while a turn is in flight (WS1 interrupt, no F7 transition), `Esc` bound; mid-stream prompts render as pending and deliver on turn end (§5.5) |
| MF7 | Mid-stream failure discarded the partial assistant turn | Partial turn **retained** at normal emphasis with a terminating rule; WS4 §6.2 reconciliation scoped to "only when a canonical Message exists"; disconnect never blanks the transcript (§5.5) |
| MF8 | Settings dirty-state ambiguity; "did my secret save?" hazard | Test Connection always tests persisted state, disabled while dirty; per-field secret `[Save]` removed; guard modal + `beforeunload` + named change count (§4.4, §5.7, §5.7.2) |
| MF9 | Four measured contrast failures, one overstated ratio | `--mc-text-muted` → `#838D9C`, `--mc-state-archived` → `#818B96`, on-accent corrected to ≥6.5:1, layer restriction deleted, ten-pair WS6 assertion table (§2.1, §7.1) |
| MF10 | Streaming a11y incoherent and excluded screen-reader users | Five-part specification: `role="log"`+`aria-live="off"`, separate polite boundary region, `role="article"`+"Read latest response", ToolCallBlock names, `aria-busy` (§7.4) |
| MF11 | `Ctrl+1…9` is browser-reserved and never reaches page JS | `Alt+1…9`, `Alt+[`/`Alt+]`, text-entry suppression rule, `g a` → `g r`, full cheat sheet (§4.6, §7.3) |
| MF12 | State meaning carried by colour alone in compact contexts | **Glyph per F7 state** on every StatusDot, mandatory in dot-without-label contexts, `aria-label`/`title` verbatim; "1 active" → "1 running" (§2.1.6, §5.3.1) |
| WC1 | Cost budget configurable, spend invisible | Dashboard Spend widget + top-bar chip + spend shown beside the budget field (§3.1, §5.2, §5.7.4) |
| WC3 | No transcript search; panels not correlated to transcript | Scoped virtualizer-aware `Ctrl+F` FindBar; Timeline and Commits entries click-to-scroll (§5.5) |
| WC6 | No scalable keyboard surface | `Ctrl+K` command palette with state-legal actions; `g` chords retained as aliases (§4.7) |
| WC8 | Font delivery unstated — CDN fallback risk on an offline server | Both families self-hosted `woff2` in `apps/frontend`, `font-display: swap`, no CDN (§2.2) |
| WC9 | Phase-gated nav treated inconsistently | Single canonical treatment: full-contrast label + muted `P3`/`P4` Badge, never `disabled`/`aria-disabled` (§2.5, applied in §3.1, §5.3.2, §5.7, §6) |
| WC10 | Secret destroy action named inconsistently with WS4 | Renamed `[Remove]` → `[Clear]`; `archived` keeps Resume-as-new + Export per F7 (§4.4, §5.5) |
| WC11 | Launch modal hid the two most consequential parameters | Resolved absolute working directory (mono, F8.1) + current branch + dirty-file count + acknowledged warning chip on branch change (§5.4.1) |
| WC13 | PRD §4.3 Workflow Modes had no UI surface at all | Global control in Settings → Integrations → GitHub + per-Project override on the Project detail header (§5.7.3, §5.3.2) |
