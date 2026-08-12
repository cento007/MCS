# TDS 06 — Wireframes & Design System (WS5)

- **Status:** **Final (rev. 2 — brand rebase)** — palette, type scale, spacing and radii re-based onto the user-supplied brand direction `Design.md`; supersedes rev. 1 of 2026-08-11. Provenance in §2.6, migration for WS4 in §8.1, revision record in §8.4. Ready for WS7 constraint audit.
- **Owner:** WS5 / ui-designer
- **Date:** 2026-08-12
- **Inputs:** `Design.md` (**user-supplied brand direction** — Supabase-inspired token set; adopted/rejected per §2.6), `docs/tds/01-foundation-decisions.md` (Foundation Contract — consumes F2.1, F4, F5.4, F5.6, F7, F9 verbatim), `Requirements.md` (PRD v2.1 — §4.1–4.4, §8, §9, §14), `docs/project-plan.md` (WS5 row), `docs/tds/02-service-architecture-and-deployment.md` (WS1 §4.3 launch queueing, §5.1 interrupt/cold-pause semantics, §5.2 observed-session applicability, §6.3 fidelity degradation, §7.2 worker heartbeats), `docs/tds/05-frontend-architecture.md` (WS4 §5.1 connection status, §6 live chat model, §7 Settings behavior, §9.1 token structure — reconciled bidirectionally)
- **Consumers:** WS4 (frontend architecture — token names and component inventory are the handoff surface; **rev. 2 carries token renames, see §8.1**), WS2 (screens reference API surfaces conceptually only), WS6 (the §7.1 assertion table is the design-token test contract), WS7 (constraint audit)

This document contains (1) the design-system foundations — semantic tokens, type scale, spacing, and a component inventory expressed as CSS-variable-style tokens that WS4 can consume directly — and (2) low-fidelity ASCII wireframes with interaction notes for every Phase 1–2 screen. Phase 3–5 screens appear as placeholder shells only, marked with the F9.3 callout. Vocabulary discipline per F9.5: entity names per F4.1, session states per F7 (lowercase: `created`, `running`, `paused`, `completed`, `failed`, `archived`), event names per F6 — verbatim, no synonyms.

**Non-goals:** no component code, no React/Tailwind implementation detail (WS4), no endpoint shapes (WS2), no new entity or state names.

---

## 1. Design Principles (per PRD §14)

All decisions below serve five principles: **fast, minimal, operator-focused, dark mode first, mobile-friendly monitoring.**

Practical interpretation used throughout:

| Principle | Design consequence |
|---|---|
| Fast | Skeleton loading, optimistic UI where safe, no blocking spinners on navigation, dense tables over card grids for lists |
| Minimal | **Near-monochrome by default.** A neutral near-black canvas, one emerald accent, and a deliberately low-chroma signal ramp; no decorative imagery; minimal wordmark only. The emerald is the only colour that ever fills an area (§2.1.4) |
| Operator-focused | Compact line heights, monospace for identifiers/paths/costs/logs, keyboard-first workflows, persistent state visibility (session-state dots everywhere a Session appears) |
| Dark mode first | Tokens are authored dark-first; elevation expressed by lighter surfaces + borders, not shadows; a light mapping is a later re-skin of the same semantic tokens (WS4 owns theme switching mechanics; PRD §4.4.1 theme setting defaults to dark). **No light palette is designed in V1** — see §2.6 |
| Mobile-friendly monitoring | Mobile targets *monitoring* (read state, read stream, pause/end, acknowledge), not authoring. Full editing flows (Settings forms, ADR editing) are desktop-first and merely usable on mobile |

---

## 2. Design System Foundations

### 2.1 Color tokens (dark-first, semantic)

Values are the canonical dark theme, re-based in rev. 2 onto `Design.md`'s neutral near-black canvas and emerald accent (§2.6). WS4 maps these to CSS custom properties verbatim; components reference only semantic tokens, never raw hex. **Every ratio quoted in this section is computed, not asserted** — the full assertion table is §7.1.

**The neutral shift.** Rev. 1's surfaces were cool blue-blacks (`#0D1117`, `#151B23`, `#1C232D`). Rev. 2 replaces the entire family with `Design.md`'s neutral greys. This is the single largest visual change in the rebase and it is deliberate: a blue-tinted canvas reads as "console chrome" and, more practically, it put a blue cast under every surface while the accent, the `completed` state, and the `info` status were *also* blue — four blues doing four different jobs. A neutral ground makes the product read as quietly technical and buys back the entire blue region of the spectrum for signalling.

#### 2.1.1 Background layers

Elevation model: three layers plus an inset. Higher = lighter. No drop shadows on dark surfaces; separation comes from background delta + 1px border. On a near-black canvas the layer deltas are necessarily small (1.05–1.15:1) — **the border, not the fill, is what makes an edge visible**, which is why `--mc-border` is mandatory on every raised surface.

```css
--mc-bg-app:      #1c1c1c;   /* page background, layer 0 — Design.md canvas-night      */
--mc-bg-surface:  #202020;   /* cards, panels, sidebar, table headers — layer 1
                                Design.md canvas-night-soft                            */
--mc-bg-raised:   #2b2b2b;   /* modals, popovers, dropdowns, toasts — layer 2 (WS5)    */
--mc-bg-inset:    #141414;   /* code blocks, tool-call I/O, terminal-style areas (WS5) */
--mc-bg-overlay:  rgba(0, 0, 0, 0.72);         /* modal scrim                          */
--mc-bg-hover:    rgba(255, 255, 255, 0.055);  /* row/list hover wash, any layer       */
--mc-bg-selected: rgba(62, 207, 142, 0.12);    /* selected row/tab wash — accent tint  */
```

`--mc-bg-raised` and `--mc-bg-inset` are WS5's choices (Design.md supplies only the two canvas values). Both were picked so that **all three text tokens clear AA on all four layers**; `--mc-bg-raised` is the binding case because it is the lightest and therefore the worst for light-on-dark text — `--mc-text-muted` holds 5.03:1 there (§7.1 row 4).

#### 2.1.2 Borders and focus

```css
--mc-border:              #333333;  /* decorative hairline: card edges, table rules, dividers */
--mc-border-strong:       #4a4a4a;  /* emphasised dividers, hover on decorative borders       */
--mc-border-control:      #7a7a7a;  /* boundary of any control the edge identifies — ≥3:1     */
--mc-border-control-hover:#a3a3a3;  /* hover/active on a control boundary                     */
--mc-border-focus:        var(--mc-accent);  /* focus ring colour, see §7.2                    */
```

**Why two border families (new in rev. 2).** WCAG 2.1 SC 1.4.11 requires 3:1 for "visual information required to identify user-interface components". Rev. 1 had a single `--mc-border` token used for both card edges and input outlines, and never stated a floor for either — an omission, because on a near-black canvas the two cases have opposite answers:

- **A decorative hairline has no floor.** Card, table and divider rules separate content; they identify nothing. `--mc-border` sits at 1.29:1 on `--mc-bg-surface` and that is correct — a 3:1 rule around every table cell would be louder than the data.
- **A control boundary has a 3:1 floor, and on this canvas only a mid-grey can meet it.** For a `#202020` surface, *no darker fill can ever reach 3:1* — pure black against `#202020` tops out at 1.29:1 — so the field's own inset fill mathematically cannot carry identification, and the border must. `--mc-border-control` `#7a7a7a` clears 3:1 on all three layers (3.97 / 3.80 / 3.30 — §7.1 rows 12–14). It applies to text inputs, textareas, selects, search fields, checkboxes, radios, the toggle off-track, and secondary/outline buttons.

#### 2.1.3 Text hierarchy

```css
--mc-text-primary:   #ededed;  /* headings, body, values          — ≥12:1 on all layers  */
--mc-text-secondary: #b2b2b2;  /* labels, metadata, table headers — ≥6.6:1 on all layers */
--mc-text-muted:     #9a9a9a;  /* hints, placeholders, timestamps — ≥5.0:1 on ALL layers */
--mc-text-disabled:  #707070;  /* disabled controls ONLY (exempt per WCAG) — see below   */
--mc-text-inverse:   #171717;  /* text on accent / warning / danger fills — Design.md ink*/
```

Two deliberate calls here:

- **`--mc-text-primary` is `#ededed`, not `#ffffff`.** `Design.md` offers `on-dark: #ffffff`, which measures 17.04:1 on the canvas — far more than needed and, at Mission Control's densities (13–14px mono in table columns and tool-call output), enough to halate. `#ededed` holds **14.56:1** on `--mc-bg-app` and **12.09:1** on `--mc-bg-raised`, comfortably above any floor, and stays inside `Design.md`'s neutral family.
- **`--mc-text-disabled` is `Design.md`'s `ink-mute` `#707070`, and it is not a text colour.** `#707070` measures **3.44:1** on `--mc-bg-app` — it *fails* AA as body text. It is admitted to the system only for disabled controls, which WCAG exempts, and for non-text affordances. `Design.md` uses `ink-mute` for footer body copy on white; that usage does not survive onto this canvas. The muted-text role belongs to `Design.md`'s `ink-mute-2` `#9a9a9a` (6.06:1), which is `--mc-text-muted`. **§2.5 forbids `--mc-text-disabled` on phase-gated navigation for exactly this reason.**

#### 2.1.4 Accent (single accent, emerald) — and the accent-discipline rule

```css
--mc-accent:        #3ecf8e;  /* primary actions, links, active nav, focus — Design.md primary  */
--mc-accent-hover:  #4ade80;  /* Design.md primary-soft                                          */
--mc-accent-active: #24b47e;  /* pressed — Design.md primary-deep                                */
--mc-accent-subtle: #1e3329;  /* tinted grounds: selected nav item, accent chips (WS5)           */
--mc-on-accent:     #171717;  /* text/icon on solid accent fills — Design.md on-primary, 8.98:1  */
```

The emerald is a **dark-canvas colour**. On white it measures **2.00:1** — it fails even the 3:1 non-text floor, which is why `Design.md` only ever uses it as a button *fill* with dark text on it. On `#1c1c1c` it measures **8.54:1** and works as a foreground, a rule, a ring and a fill. This asymmetry is the strongest single argument for the dark-first decision recorded in §2.6.

> **Accent discipline (binding, new in rev. 2).**
> **`--mc-accent` marks operator intent and position — actionable, selected, focused, current. It never reports a system condition.**
>
> Emerald is the brand colour and the call-to-action colour, so any element wearing it reads as "act here" or "you are here". The moment it also means "healthy" or "running", every green pixel becomes ambiguous and the primary button loses its monopoly on urgency. Concretely: the accent is permitted on primary buttons, links, active nav and tab indicators, the focus ring, selected/checked control states, unread-activity dots, the dirty-field rule in Settings, and indeterminate activity bars — all of which are statements about the operator or the interface. It is **forbidden** on session states (§2.1.6), health and outcome status (§2.1.5), and progress meters whose fill encodes a threshold (§5.2 Spend).
>
> This rule is what forced the state and status ramps to be re-hued in rev. 2; the collision it resolves is documented in §2.1.6.

#### 2.1.5 Status colors

```css
--mc-success:  #4fa8bd;   --mc-success-subtle: #212a2c;   /* healthy · connected · live · all clear */
--mc-warning:  #e5b64a;   --mc-warning-subtle: #302b21;   /* degraded · threshold · caution         */
--mc-danger:   #f47460;   --mc-danger-subtle:  #322523;   /* down · error · destructive             */
--mc-info:     #a9bdfa;   --mc-info-subtle:    #2a2c32;   /* neutral information                     */
```

Usage unchanged from rev. 1: `success/warning/danger/info` are reserved for outcomes and health (Test Connection results, service health, error banners, destructive buttons). Session states use the dedicated set below — never reuse raw status tokens for session states, so that (e.g.) a `failed` badge and a form validation error remain independently themeable. The two ramps share values by construction (`--mc-success` = `--mc-state-running`, `--mc-warning` = `--mc-state-paused`, `--mc-danger` = `--mc-state-failed`, `--mc-info` = `--mc-state-completed`) but stay separate tokens.

**`--mc-success` is cyan, not green — and that is the point.** Rev. 1's success green `#3FB950` cannot survive the accent-discipline rule above: a green `● live` chip sitting 200px from an emerald `[+ New Session]` button is precisely the ambiguity the rule exists to prevent. Half-applying the rule ("emerald means CTA, except when it means healthy") is worse than not having it, because the exception is the case an operator meets on every screen. Cyan carries "alive / connected / ok" without borrowing the CTA colour, and it measures 6.22:1 on the canvas.

#### 2.1.6 Session-state colors and glyphs (mapped 1:1 to F7 states)

**The collision this ramp resolves.** Emerald is now the brand and CTA colour. Rev. 1's `running` state was `#3FB950` — also green, and only **ΔE 23.0** from `#3ecf8e`. A `▶ running` badge (a filled pill in green with a short label) would have been visually indistinguishable in role from a primary button. Under rev. 1 that hazard did not exist, because the accent was blue and `running` was green sat ΔE 115.3 apart. The rebase created the collision; re-hueing the ramp is what removes it. Per §2.1.4, **the emerald never encodes state**, so the ramp had to move to a family the accent does not occupy.

| F7 state | **Glyph** | Token | Value | Subtle bg token | Value | On subtle | Dot behavior |
|---|---|---|---|---|---|---|---|
| `created` | `○` | `--mc-state-created` | `#b2b2b2` | `--mc-state-created-subtle` | `#2c2c2c` | 6.59:1 | static |
| `running` | `▶` | `--mc-state-running` | `#4fa8bd` | `--mc-state-running-subtle` | `#212a2c` | 5.35:1 | **pulsing** (see §2.5 StatusDot; respects reduced motion, §7) |
| `paused` | `‖` | `--mc-state-paused` | `#e5b64a` | `--mc-state-paused-subtle` | `#302b21` | 7.45:1 | static |
| `completed` | `✓` | `--mc-state-completed` | `#a9bdfa` | `--mc-state-completed-subtle` | `#2a2c32` | 7.54:1 | static |
| `failed` | `✕` | `--mc-state-failed` | `#f47460` | `--mc-state-failed-subtle` | `#322523` | 5.27:1 | static |
| `archived` | `▣` | `--mc-state-archived` | `#8f8f8f` | `--mc-state-archived-subtle` | `#232323` | 4.86:1 | static |

Badges pair the subtle background with the full-strength color as text/dot (see §2.5 Badge). Subtle grounds are ≈10% of the state hue mixed over `--mc-bg-app`; `archived`'s is deliberately darker (≈7%) because its mark is the dimmest in the ramp and needed the headroom to clear 4.5:1.

**How the ramp was derived, and what it is not confusable with.** Four decisions, each verified rather than assumed:

1. **`running` is cyan `#4fa8bd`.** Cyan keeps the "alive" reading without being the CTA green. It sits at hue 191° against the emerald's 152°, at **ΔE 52.9** in normal vision, and — critically — its relative luminance (0.333) is 30% below the emerald's (0.476), so hue is not the only separator at 10px.
2. **`created` is achromatic `#b2b2b2`,** sharing the value of `--mc-text-secondary`. A Session that has not started earns no colour; this also keeps one more hue out of a near-monochrome UI.
3. **`paused` is a desaturated amber `#e5b64a`,** not `Design.md`'s `accent-yellow` `#ffdb13`. `#ffdb13` passes contrast easily (12.49:1) but is the loudest thing that could possibly be on the screen, and `paused` is the *calmest* state in the ramp — it means an operator deliberately stopped something. `#e5b64a` still measures 9.03:1 and stops shouting.
4. **`failed` is a lightened tomato `#f47460`,** derived from `Design.md`'s `accent-tomato` `#ff2201`. The source value measures **4.45:1** on this canvas — marginally *under* AA for text — so it could not be used as-is. Lightening it to `#f47460` yields **6.10:1** on `--mc-bg-app` and **5.07:1** on `--mc-bg-raised` (the toast case).

**Colour-vision verification (computed, not asserted).** The ramp was simulated under the Viénot–Brettel–Mollon 1999 transforms and scored by CIE76 ΔE *in simulated space*; ΔE ≳ 11 is comfortably distinguishable at badge size. The three states an operator must never confuse are `running`, `paused`, `failed`:

| Pair | Normal | Deuteranopia | Protanopia |
|---|---|---|---|
| `running` / `paused` | ΔE 83.4 | **ΔE 87.2** | ΔE 73.2 |
| `running` / `failed` | ΔE 81.1 | **ΔE 64.6** | ΔE 40.4 |
| `paused` / `failed` | ΔE 64.1 | **ΔE 24.0** | ΔE 38.1 |
| each state vs `--mc-accent` | ΔE ≥ 52.9 | **ΔE ≥ 18.9** | ΔE ≥ 28.3 |

An early candidate for `failed` was a rose-red (`#f5707f`), chosen on the intuition that added blue helps deuteranopes. Simulation disproved it: rose collapses to **ΔE 7.4** against the emerald under deuteranopia (both simulate to near-identical khaki) and to **ΔE 5.4** against `archived` under protanopia. The warmer coral `#f47460` scores 23.5 and 23.7 on those same pairs. The intuition was wrong and the measurement is the reason the value changed — recorded here so it is not "corrected" back later.

**Known residual, accepted:** under *tritanopia* (~0.01% prevalence) `running` and `--mc-accent` converge to ΔE 10.1, since that condition destroys the blue–yellow axis that separates cyan from emerald. It is not designable around without pushing `running` into `completed`'s hue. It is covered by the non-colour channels below, and by the fact that the accent never appears as a state mark in the first place.

**Colour is never the only channel.** No pair of states in this ramp is distinguished by hue alone, because the densest surfaces (session tabs, mobile chips, the sidebar open-sessions strip) have no room for a state word. Therefore:

- **Every state badge carries the verbatim F7 state name as text**, and
- **every StatusDot carries the state glyph above**, so *shape* carries the meaning wherever the label is absent. The glyph is mandatory in all dot-without-adjacent-label contexts: Active Projects widget, Dashboard/mobile session chips, sidebar open-sessions strip, Live Session tab bar, mobile session chip scroller.
- Each glyph-only dot exposes the verbatim F7 state name via `aria-label` **and** `title` (e.g. `aria-label="running"`) — never a synonym, per F9.5.
- `--mc-state-archived` at `#8f8f8f` clears 4.5:1 on its own subtle background (4.86:1), so the archived badge uses the same full-strength-on-subtle recipe as every other state — one recipe, six states.
- **`running` additionally pulses** (§2.5), which is a fourth channel and the only one that survives every form of colour blindness. Under `prefers-reduced-motion` it degrades to a static filled dot with a ring, glyph retained.
- **Primary and danger solid fills never appear in the same action row.** Every destructive confirm in this document pairs `[Cancel]` (secondary) with the danger action; every constructive modal pairs `[Cancel]` with the primary. This is what keeps the deuteranopic ΔE 23.5 between emerald and coral from ever having to be judged side by side.

### 2.2 Typography

Operator-dense: small default size, compact line heights, monospace for anything an operator might copy, compare, or scan columnar. Rev. 2 adopts `Design.md`'s size ladder, weights and tracking; the **token names are unchanged** so WS4's consumption contract survives, but the values shift up one rung (§8.1 carries the migration).

#### 2.2.1 Families — Inter at Circular's metrics

```css
--mc-font-ui:   "Inter", "Segoe UI", system-ui, sans-serif;
--mc-font-mono: "JetBrains Mono", "Cascadia Code", ui-monospace, "SF Mono", monospace;
```

> **Circular is rejected. Do not re-add it.** `Design.md` specifies `Circular` as the display and UI family. Circular is a commercial retail typeface licensed by Lineto; a webfont licence is per-domain and per-pageview, and — decisively — **§2.2.2 requires every face to be self-hosted `woff2` with no CDN, because Mission Control runs on an offline LAN server.** Self-hosting a commercially licensed face on an unmetered, un-domained, air-gapped host is not something the licence contemplates, and there is no free or open substitute that *is* Circular. **Inter stays** — it was already chosen, is already self-hosted, is SIL OFL, and is a geometric-humanist sans in the same genre.
>
> **Circular's character is reproduced through metrics, not through the file.** What makes `Design.md`'s display tier look the way it does is not the glyph outlines — it is the **weight-500 display tier** and the **negative letter-spacing** (−1.92 / −1.44 / −0.72 / −0.42px). Inter set at those metrics lands in the same visual register. Both are carried verbatim in §2.2.3. **JetBrains Mono stays** for code and identifiers; `Design.md` specifies only a generic `ui-monospace` stack for its `code` style, so there is nothing to displace.

#### 2.2.2 Font delivery (binding on WS4) — unchanged from rev. 1

Inter and JetBrains Mono ship as `woff2` subsets inside `apps/frontend` (bundled assets, hashed filenames), declared with `@font-face { font-display: swap; }`. **No external CDN, no Google Fonts, no runtime network font fetch of any kind.** Mission Control is a self-hosted LAN product that must be fully usable on an air-gapped or internet-less home server; a CDN link would silently degrade the entire UI to Segoe UI / Consolas exactly when the operator is least able to diagnose it, and would leak instance usage to a third party. The remaining stack entries are last-resort fallbacks for a corrupted asset, not the expected rendering path.

**Shipped weight subset narrows to 400 and 500 for both families.** `Design.md` uses only those two, and rev. 2 adopts its weights verbatim — so **weight 600 is retired from the system** (rev. 1 used it for card, page and modal titles; those move to 500 plus the display tracking). WS4 §9.1 currently states "UI 400/500/600" and should drop the 600 face: it is a smaller download and one fewer thing that can be inconsistently applied.

#### 2.2.3 Scale, weights and tracking (from `Design.md`, verbatim)

Size tokens keep their rev. 1 `--mc-fs-*` names; line-height and tracking are separate tokens so a single size can serve two roles (18px is both `heading-md` at 1.4 and `body-lg` at 1.55 in `Design.md`, which a fused token cannot express).

```css
/* size — Design.md ladder */
--mc-fs-2xs: 12px;  --mc-fs-xs:  13px;  --mc-fs-sm: 14px;  --mc-fs-md:  16px;
--mc-fs-lg:  18px;  --mc-fs-xl:  22px;  --mc-fs-2xl: 28px; --mc-fs-3xl: 36px;
--mc-fs-4xl: 48px;  --mc-fs-5xl: 64px;

/* line-height — Design.md ratios, verbatim */
--mc-lh-100: 1.0;   --mc-lh-110: 1.1;   --mc-lh-115: 1.15;  --mc-lh-120: 1.2;
--mc-lh-140: 1.4;   --mc-lh-145: 1.45;  --mc-lh-150: 1.5;   --mc-lh-155: 1.55;

/* weight — Design.md uses exactly two */
--mc-fw-regular: 400;  --mc-fw-medium: 500;

/* tracking — Design.md display tier, verbatim */
--mc-track-5xl: -1.92px;  --mc-track-4xl: -1.44px;
--mc-track-3xl: -0.72px;  --mc-track-2xl: -0.42px;  --mc-track-0: 0;
```

Composed text styles — this table is what components reference:

| Style | `Design.md` name | Size token | px / lh | Weight | Tracking | Usage in Mission Control |
|---|---|---|---|---|---|---|
| `display-xxl` | display-xxl | `--mc-fs-5xl` | 64 / 70 | 500 | −1.92px | **Reserved — unused in Phase 1–2** |
| `display-xl` | display-xl | `--mc-fs-4xl` | 48 / 53 | 500 | −1.44px | **Reserved — unused in Phase 1–2** |
| `display-lg` | display-lg | `--mc-fs-3xl` | 36 / 41 | 500 | −0.72px | Login wordmark (§5.1) |
| `display-md` | display-md | `--mc-fs-2xl` | 28 / 34 | 500 | −0.42px | Dashboard metric numerals (mono, §5.2) |
| `heading-lg` | heading-lg | `--mc-fs-xl` | 22 / 26 | 500 | 0 | Page titles (`h1`), Live Session title |
| `heading-md` | heading-md | `--mc-fs-lg` | 18 / 25 | 500 | 0 | Card/widget titles, modal titles |
| `body-lg` | body-lg | `--mc-fs-lg` | 18 / 28 | 400 | 0 | ADR prose body (desktop reading) |
| `body-md` | body-md | `--mc-fs-md` | 16 / 24 | 400 | 0 | Chat message body, form input values |
| `body-sm` | *(derived)* | `--mc-fs-sm` | 14 / 20 | 400 | 0 | **Default body & table cell size** (dense) |
| `button` | button-md | `--mc-fs-sm` | 14 / 14 | 500 | 0 | All button labels |
| `caption` | caption | `--mc-fs-xs` | 13 / 19 | 400 | 0 | Secondary metadata, sidebar items, breadcrumbs |
| `micro` | micro | `--mc-fs-2xs` | 12 / 17 | 400–500 | 0 | Badge text, table micro-labels, timestamps |
| `code` | code | `--mc-fs-sm` | 14 / 21 | 400 | 0 | Mono: IDs, paths, costs, tool I/O |

**The one interpolation, declared.** `body-sm` (14 / 20) has no counterpart in `Design.md`, whose only 14px styles are `button-md` (line-height 1.0) and `code` (1.5). Mission Control's default surface is a dense table, and neither of those line-heights works for a wrapping sans cell. 20px (≈1.43) sits between them. **This is the sole place rev. 2 extrapolates beyond the supplied ladder**; everything else in the table is `Design.md` verbatim.

**Density note.** Rev. 1's default body was 13/18 and its badge text 11/14. Adopting the ladder moves those to 14/20 and 12/17 — marginally airier, and better for it: 11px badge text was below every practical legibility guideline, and `--mc-row-dense` at 36px still comfortably holds a 14/20 cell (§2.3). The two reserved display sizes (48, 64) are carried because §2.6 adopts the ladder verbatim, but they are honestly recorded as unused — an operator console has no hero headline.

Monospace (`--mc-font-mono`) is mandatory for: Session IDs, `runtime_session_id`, commit SHAs, branch names, file paths, costs (`$0.4821`), token counts, durations, tool-call names and I/O, code blocks, API tokens, and the `requestId` in error surfaces (F5.4).

**Session identity — how a Session is labelled (binding across every screen).** Session primary keys are UUIDv7 (F4.2), whose leading bits are a millisecond timestamp. Two Sessions created in the same hour therefore share a near-identical prefix (`0198a2f3…`, `0198a1c0…`, `01989f11…`) — a short prefix is the *worst* available discriminator for the exact case the operator hits most (several sessions launched this afternoon). Rules:

| Surface | Label |
|---|---|
| Any list, tab, chip, widget row, or notification | **Primary line = human title**; **secondary line = `project · branch`** |
| Compact machine identifier in a table column | **Last 6 hex characters** of the UUID (the random tail), mono, column header `ID` — never the leading prefix |
| Session detail header | Full UUID, mono, `--mc-fs-2xs`, click-to-copy (§5.5) |

The **title** is auto-derived on session creation from the first user prompt (first sentence, trimmed to ~60 chars on a word boundary; the composer-started `created` flow derives it from the prompt that started the session). It is editable inline anywhere it appears as the page/tab heading (pencil affordance, `Enter` commits, `Esc` reverts). A Session with no prompt yet (started via `[Start]` with no prompt) falls back to `Untitled session · ‹HH:MM›` until its first prompt arrives, at which point the title auto-fills — unless the operator already set one, which always wins.

### 2.3 Spacing, radius, sizing

**Spacing — `Design.md` scale verbatim.** Token names keep the rev. 1 numeric convention (the number is the 4px multiple, so `--mc-sp-4` is 16px); three rungs are **removed** and one is **added**.

```css
--mc-sp-05: 2px;   /* Design.md xxs */   --mc-sp-1: 4px;   /* xs   */
--mc-sp-2:  8px;   /* sm            */   --mc-sp-3: 12px;  /* md   */
--mc-sp-4:  16px;  /* lg            */   --mc-sp-6: 24px;  /* xl   */
--mc-sp-8:  32px;  /* xxl           */   --mc-sp-16: 64px; /* huge */
```

Removed: `--mc-sp-5` (20px), `--mc-sp-10` (40px), `--mc-sp-12` (48px). Added: `--mc-sp-16` (64px). Migration for existing WS4 usage: 20 → 16, 40 → 32, 48 → 32 or 64 depending on whether the gap was sectioning or page-level. The scale is no longer a uniform 4px ladder above 32px, and that is intentional — `Design.md` jumps straight to 64 for page-level rhythm, which is the only place a gap that large belongs.

**Radii — `Design.md` scale verbatim.** The four rev. 1 names are retained with new values; `xs` and `xl` are added. No name is removed, but **three names change value**, so WS4 must re-check every consumer (§8.1).

```css
--mc-radius-xs:   4px;     /* NEW name — badges, chips, inline code, state pills   */
--mc-radius-sm:   6px;     /* was 4px  — buttons, inputs, selects, small controls  */
--mc-radius-md:   8px;     /* was 6px  — cards, widgets, panels, table container   */
--mc-radius-lg:   12px;    /* was 10px — modals, toasts, popovers, command palette */
--mc-radius-xl:   16px;    /* NEW      — login card, full-bleed mobile sheets      */
--mc-radius-full: 9999px;  /* was 999px — status dots, avatar, count chips         */
```

Component remapping caused by the revalue: badges and chips move from `--mc-radius-sm` to `--mc-radius-xs` (still 4px, so no visual change); buttons/inputs stay on `--mc-radius-sm` and grow 4 → 6px; cards stay on `--mc-radius-md` and grow 6 → 8px; modals and toasts stay on `--mc-radius-lg` and grow 10 → 12px.

**Sizing — unchanged from rev. 1.** These are layout constants, not part of the `Design.md` token set, and the type-scale shift does not disturb them: a 14/20 cell still fits `--mc-row-dense` with 8px of vertical padding.

```css
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
| **Button** | primary (solid `--mc-accent`), secondary (surface + `--mc-border-control`), ghost (borderless), danger (solid `--mc-danger`), icon-only | default, hover, active, disabled, **loading** (inline spinner replaces label, width preserved) | Heights `--mc-control-sm/md/lg`; `--mc-radius-sm` (6px); `button` style (14/500); padding `--mc-sp-2 --mc-sp-4`. Primary: `--mc-on-accent` `#171717` label (8.98:1), hover `--mc-accent-hover`, pressed `--mc-accent-active`. Danger: `--mc-text-inverse` label on `--mc-danger` (6.41:1). **Primary and danger fills never share an action row** (§2.1.6) |
| **Input** | text, number, password, textarea, **path** (mono font + trailing validity hint), **secret** (see §4.4), select, search (leading icon, `/` shortcut) | default, focus, disabled, invalid (border `--mc-danger` + `caption` message below) | `--mc-bg-inset` fill, **1px `--mc-border-control`** (≥3:1, §2.1.2 — *not* `--mc-border`), `--mc-radius-sm`; hover `--mc-border-control-hover`; `body-md` value text; placeholder `--mc-text-muted` |
| **Toggle** | default, with inline label | on, off, disabled | On = `--mc-accent` track with `--mc-on-accent` knob (selection = operator intent, permitted by §2.1.4); off-track border `--mc-border-control` |
| **Badge** | state badge (F7 states, §2.1.6), neutral tag, count, **phase tag** (`P3`/`P4`) | — | `micro` style (12px) at 500 wt, **`--mc-radius-xs`** (4px), padding `--mc-sp-05 --mc-sp-2`, subtle bg + full-strength text, always includes label text. Count/unread chips use `--mc-radius-full` |
| **StatusDot** | 10px dot carrying the F7 **state glyph** (`○ ▶ ‖ ✓ ✕ ▣`, §2.1.6); health dot (`● ▲ ✕ ◌ ⟳`) | `running` pulses; **reduced-emphasis** when the connection chip is not `live` (§3.3) | Glyph is mandatory — the dot may appear without an adjacent text label, but never without its glyph + `aria-label`/`title` carrying the verbatim F7 state name. `--mc-radius-full` |
| **ConnectionChip** | shell-level transport indicator | `live`, `reconnecting`, `offline` | §3.3; persistent in the desktop top bar and mobile header. `live` dot is `--mc-success` (cyan), **never the accent** (§2.1.4) |
| **OpenSessionsStrip** | sidebar footer (desktop), tab bar (Live Session view), chip scroller (mobile) | per-entry: F7 state glyph, title, unread-activity dot with count | §3.4 — one shared data source, three renderings; max 6 entries. Unread dot is `--mc-accent` (navigational attention, not state) |
| **CommandPalette** | `Ctrl+K` overlay | idle, filtering, empty | §4.7; the primary keyboard surface. `--mc-bg-raised`, `--mc-radius-lg`, 1px `--mc-border` |
| **FindBar** | scoped find within the Conversation region | idle, matching (`n/m`), no-match | §5.5; virtualizer-aware |
| **BudgetMeter** | dashboard stat (numeral + rule), top-bar chip | under threshold (`--mc-success`), at/over threshold (`--mc-warning`), over budget (`--mc-danger`) | §5.2 / §3.1. Numeral uses `display-md` mono. **The under-threshold fill is `--mc-success`, not the accent** — a meter fill encodes a system condition (§2.1.4) |
| **AttentionRow** | row inside the Needs Attention widget | failed session, unhealthy service, sync failure, budget breach | §5.2; every row deep-links |
| **Table** | dense (default), selectable rows | loading (skeleton rows), empty (EmptyState inside body), row hover, row selected | `--mc-row-dense`; cells `body-sm` (14/20); header `micro` uppercase `--mc-text-secondary`; rules `--mc-border`; hover `--mc-bg-hover`; selected `--mc-bg-selected`; sticky header on scroll |
| **Card / Widget** | dashboard widget (title + action link + body), stat card (metric numeral) | loading (skeleton), empty, error (inline ErrorBanner) | `--mc-bg-surface`, 1px `--mc-border`, `--mc-radius-md` (8px), padding `--mc-sp-4`; title `heading-md` (18/500) |
| **Tabs** | page-level (underline style), panel-level (contained), **session tabs** (closable, with StatusDot — §5.5) | active, hover, **phase-gated** (full-contrast label + muted `P3`/`P4` Badge — *never* `disabled`, see below) | Active = `--mc-text-primary` + 2px `--mc-accent` underline (position, permitted by §2.1.4) |
| **Toast** | success, danger, info, warning | auto-dismiss (5s), sticky (danger persists until dismissed) | `--mc-bg-raised`, `--mc-radius-lg`, 1px `--mc-border`, left 3px status rule; body text `--mc-text-primary` (12.09:1 on raised); max 3 stacked; bottom-right desktop, top mobile; see §4.5 |
| **Modal** | sm (400px — confirms), md (560px — forms), lg (720px) | loading, error | `--mc-bg-raised`, `--mc-radius-lg`, scrim `--mc-bg-overlay`; focus-trapped; Esc closes; destructive confirms require explicit danger button |
| **ErrorBanner** | inline (panel/form scope), page-level | — | `--mc-danger-subtle` bg, `--mc-danger` rule, `--mc-danger` heading text (5.30:1 on its subtle ground); renders F5.4 envelope: message, `code` (mono chip), `requestId` (mono + copy button); see §4.3 |
| **EmptyState** | with primary CTA, plain | — | Centered, `--mc-text-muted` (≥5.03:1 on every layer), one-line hint + one action max |
| **Skeleton** | text line, table row, widget block | — | `--mc-bg-hover` blocks on the host layer; shimmer disabled under reduced motion (static blocks) |
| **KeyValueList** | two-column label/value, dense | — | Labels `--mc-text-secondary`, values often mono; used in detail headers, Services health |
| **MessageBlock** (chat) | user, assistant, system, tool (F4 Message roles) | streaming (assistant: animated cursor + pill), error | See §5.5. Body `body-md` (16/24) |
| **ToolCallBlock** | collapsed (default), expanded | running, ok, error | See §5.5. Expanded I/O on `--mc-bg-inset` in `code` style |
| **SecretField** | unset, set (masked), replacing | saved (with timestamp), pending-save | See §4.4 — actions are `[Replace]` and `[Clear]`; the field has **no** save button of its own |
| **HealthRow** | service row in Services panel | ok, degraded, down, not-configured, checking | See §5.7.12. `ok` = `--mc-success` cyan, not green |

**Phase-gated navigation treatment (canonical, applies to nav items, tabs, and Settings categories alike).** A Phase 3/4 destination renders with a **full-contrast label**, **normal hover and focus styling**, and a **muted `P3`/`P4` Badge**; activating it navigates to the placeholder shell (§6) which explains the phase. It is **never** `disabled`, never `aria-disabled`, never dimmed to `--mc-text-disabled`. Rationale: these targets are focusable and they *do* something (they route), so `disabled` would be a lie to both the pointer user and the screen-reader user, and `--mc-text-disabled` is deliberately exempt from the AA contrast floor — using it on a reachable target puts unreadable text in the navigation. The Badge, not the contrast, communicates "later phase".

### 2.6 Brand provenance — what came from `Design.md`, and what did not

Rev. 2 re-bases this design system onto **`Design.md`**, the brand direction supplied by the product owner: a Supabase-inspired token set describing a near-monochrome system with a single emerald CTA, a humanist display tier, and a light canvas. This subsection records what was taken, what was refused, and why, so that neither half is quietly re-litigated later.

#### 2.6.1 Adopted

| From `Design.md` | Taken as | Where |
|---|---|---|
| `canvas-night` `#1c1c1c`, `canvas-night-soft` `#202020` | `--mc-bg-app`, `--mc-bg-surface` — replacing rev. 1's cool blue-blacks | §2.1.1 |
| `primary` `#3ecf8e`, `primary-deep` `#24b47e`, `primary-soft` `#4ade80`, `on-primary` `#171717` | `--mc-accent`, `--mc-accent-active`, `--mc-accent-hover`, `--mc-on-accent` — replacing `#4D9FFF` | §2.1.4 |
| `ink-mute-2` `#9a9a9a`, `ink-faint` `#b2b2b2`, `ink` `#171717` | `--mc-text-muted`, `--mc-text-secondary`, `--mc-text-inverse` | §2.1.3 |
| `accent-tomato` `#ff2201`, `accent-yellow` `#ffdb13` | Hue *sources* for `--mc-danger` and `--mc-warning`, re-valued for contrast and calm (§2.1.6) | §2.1.5 |
| `rounded` 4 / 6 / 8 / 12 / 16 / 9999px | Radius scale, verbatim | §2.3 |
| `spacing` 2 / 4 / 8 / 12 / 16 / 24 / 32 / 64px | Spacing scale, verbatim | §2.3 |
| Type ladder 64 / 48 / 36 / 28 / 22 / 18 / 16 / 14 / 13 / 12, weights 400 & 500, display tracking −1.92 / −1.44 / −0.72 / −0.42px | Type scale, weights and tracking, verbatim (one declared interpolation) | §2.2.3 |
| **The restraint principle** — the green as the only chromatic event on the page | The accent-discipline rule (§2.1.4) plus a deliberately low-chroma signal ramp | §2.1.4, §2.1.6 |

**How the restraint principle is enforced here, since a product UI cannot simply have one colour.** An operator console must signal six session states and four health conditions; `Design.md`'s landing page has to signal nothing. The principle is carried across as a rule about **area and chroma**, not about hue count: the emerald is the only colour permitted to *fill* a region (buttons, active rules, selection washes, toggle tracks), while every signal hue is confined to small marks — 10px dots, glyphs, 1px rules, 3px toast rules, and text on its own subtle ground. The result reads as a grey product with one green control surface and a scatter of quiet indicators, which is the same impression `Design.md` produces by different means.

#### 2.6.2 Rejected

1. **Circular (the typeface) — rejected on licensing and offline delivery.** `Design.md` specifies Circular for every text style. It is a commercial retail face from Lineto with per-domain, pageview-metered webfont licensing, and §2.2.2 requires every face to be a self-hosted `woff2` inside `apps/frontend` with no CDN, because this product runs on an offline LAN server. Self-hosting a metered commercial face on an un-domained air-gapped host is outside what that licence contemplates. **Inter is retained** — already chosen, already self-hosted, SIL OFL, same genre — and is set at *Circular's metrics*: the weight-500 display tier and the negative tracking, which is what actually produces the character (§2.2.1). **JetBrains Mono is retained** for code and identifiers. Recorded here so Circular is not re-added on the assumption that it was simply overlooked.
2. **The light palette as the product UI — rejected on PRD §14.** `Design.md` is a light-first system (`canvas: #ffffff`, `ink: #171717`, hairlines at `#dfdfdf`). PRD §14 mandates **dark mode first**, and the arithmetic strongly agrees: the emerald measures **2.00:1 on white** — failing even the 3:1 non-text floor, usable there only as a button fill — against **8.54:1 on `#1c1c1c`**, where it works as foreground, rule, ring *and* fill. `Design.md`'s hairlines are likewise decoration, not control boundaries (`#dfdfdf` on `#ffffff` is **1.33:1**), and would not survive §2.1.2's 3:1 rule. A light theme remains a **post-V1 concern**: WS4 §9.1 already structures it as a `[data-theme="light"]` override of these same semantic tokens, and PRD §4.4.1 defaults the setting to dark. **No light-mode values are designed in this revision** and none should be invented from `Design.md`'s light values without re-running §7.1 against them.
3. **The marketing component vocabulary — rejected as out of domain.** `Design.md`'s component list is a landing page: `card-pricing`, `card-pricing-featured`, `card-feature-light`, `card-feature-dark`, `nav-bar-light`, `footer-light`, `link-on-light`, `pill-tag-*`. Mission Control needs dense operator components — `DataTable`, `StatusDot`, `ToolCallBlock`, `SecretField`, `HealthRow`, `ConnectionChip`, `OpenSessionsStrip`, `BudgetMeter`, `AttentionRow`. The rev. 1 inventory in §2.5 is **kept in full and restyled onto the new tokens**; nothing was replaced. `Design.md`'s button, input and code-block specs *were* absorbed, since those three are genuine product primitives (radius `sm`, 8×16 padding, `button` style at 14/500).

#### 2.6.3 Changed against `Design.md` on measured grounds

Three supplied values could not be used as given, each for a computed reason:

| Supplied | Measured on `#1c1c1c` | Disposition |
|---|---|---|
| `ink-mute` `#707070` (used in `Design.md` for footer body copy) | **3.44:1** — fails AA for text | Demoted to `--mc-text-disabled`, non-text and disabled affordances only. Muted text is `ink-mute-2` `#9a9a9a` at 6.06:1 |
| `accent-tomato` `#ff2201` | **4.45:1** — marginally under AA | Lightened to `#f47460` (**6.10:1**) for `--mc-danger` / `--mc-state-failed` |
| `accent-yellow` `#ffdb13` | **12.49:1** — passes easily, but visually the loudest possible mark | Desaturated to `#e5b64a` (**9.03:1**) for `--mc-warning` / `--mc-state-paused`; `paused` is the calmest state in the ramp and should not shout |

`Design.md`'s remaining accents (`accent-purple`, `accent-violet`, `accent-pink`, `accent-indigo`, `accent-crimson`, `accent-purple-soft`) are **unused**. They are landing-page decoration; admitting them would directly contradict the restraint principle this document just adopted from the same file.

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

- **Wordmark:** text-only `MISSION CONTROL` at `--mc-fs-sm` (14px) weight **500** + a 16px glyph. (Rev. 1 specified 600; weight 600 no longer exists in the system — §2.2.2.) No further branding (non-goal).
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
- **In-place refresh:** subtle top-of-region 2px `--mc-accent` progress bar; existing data stays visible (no content flash). *(Permitted under §2.1.4: an indeterminate activity bar means "the app is doing what you asked" — an interface statement, not a system condition. A **determinate** meter whose fill encodes a threshold is not permitted the accent; see BudgetMeter, §5.2.)*
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

Single local account (F5.5). Centered card (`--mc-bg-surface`, `--mc-radius-xl`, 1px `--mc-border`) on `--mc-bg-app`, controls at `--mc-control-lg`. The wordmark above the card is the one Phase 1–2 use of the `display-lg` style (36/500, tracking −0.72px, §2.2.3) — the login screen is the only surface with room for the display tier, and it is where the brand should register.

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
- **Spend widget (PRD §4.4.2 cost budget):** today's accumulated cost as a mono `display-md` numeral (`--mc-fs-2xl`, 28px/500, tracking −0.42px), `of ‹$budget›` beneath, and a **thin progress rule** (4px, `--mc-radius-full`) that renders **`--mc-success`** under the alert threshold, `--mc-warning` at/over it, and `--mc-danger` over 100%. *(Rev. 1 used `--mc-accent` for the under-threshold fill; that is now forbidden — a meter fill whose colour encodes a threshold is reporting a system condition, which §2.1.4 reserves away from the accent.)* Secondary line: month-to-date. Costs are SDK-canonical for managed sessions (F1.5); observed sessions contribute nothing and a footnote says so on hover ("Observed sessions report no cost"). If cost-budget alerts are disabled in Settings the widget still shows spend, with `no budget set` in place of the rule — spend is never invisible just because no limit was configured, which was the whole gap: the budget was configurable but the number it constrained appeared nowhere in the UI.
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
- **Session tabs = the shell's open-session set (§3.4), rendered horizontally.** One tab per open Session with F7 **state glyph** dot + **title** + unread-activity dot with count; closable (`✕` removes it from the open set — it never ends the Session, and the same removal is reflected in the sidebar strip). `[+]` opens the Launch modal or an "attach/observe" picker. `Alt+1…9` selects, `Alt+[`/`Alt+]` step (§4.6). Tab dot and count update live on `session.state_changed` / channel activity — a background tab flipping to `failed` recolours to `--mc-state-failed`, its glyph becomes `✕`, and a danger toast fires (§4.5). The tab bar and the sidebar strip are the same list by construction, so they cannot disagree about what is open.
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
| `paused` | Disabled, hint "Session paused — resume to continue" | `[Resume]` primary, `[End]` | `--mc-state-paused`-ruled banner strip "Paused by user at 14:20"; prompts pending at pause time redisplay in the composer for explicit re-send (WS1 §5.1 — never auto-replayed) |
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
- **Observed-session fidelity degradation:** when transcript tailing fails and ingest falls back to hook-events-only (WS1 §6.3), the header gains a `--mc-warning` `⚠ Degraded fidelity` chip. **Data binding:** the chip renders from `Session.observation.degraded` on load (WS2 §6.1 — so it is correct on a cold page load, not only for a client that happened to be connected) and is raised live by the **`session.observation_degraded`** event on `session:{id}` (WS2 §6.9). Its popover reads: *"Live transcript unavailable — showing tool and lifecycle events only. Message text may be incomplete."* **The chip does not clear for the life of the Session** (WS7 arbitration A11): the tailer does not re-attach, because re-attaching cannot recover the lines already skipped — the transcript keeps its holes, so a "recovered" chip would overstate what the operator is looking at. The popover therefore states a durable fact, not a transient one. In this mode the conversation renders known tool/lifecycle events normally and shows a muted `--mc-bg-inset` strip where message bodies are unavailable — never a blank conversation, which would read as "nothing is happening" when the session is in fact active.
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

- "Paused" sync mode shows a `--mc-warning` card-header status. Conflict count links to inbox entries for `sync.failed` / conflict notifications.

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

### 7.1 Contrast — the WS6 test contract (computed, not asserted)

**Rewritten in full for rev. 2.** Every row below carries a ratio computed from the §2.1 hex values under the WCAG 2.1 relative-luminance formula, against the actual background each token is used on. **No row states a floor it has not been measured against.** Rev. 1 of this section shipped three pairs that were claimed passing and were not; the discipline that prevents a repeat is that a ratio may not appear here unless it was calculated from the two hex values in the same row — never inherited, never rounded up from a neighbouring pair, never expressed only as `≥ n`.

**This table is binding on WS6.** The design-token suite asserts these pairs directly — token-pair assertions computed from the emitted CSS custom properties, not per-component screenshots — so a palette change fails the build with a number rather than a visual diff nobody reviews.

#### 7.1.1 Text on background layers (4.5:1 floor)

| # | Foreground | Background | Floor | **Measured** |
|---|---|---|---|---|
| 1 | `--mc-text-primary` `#ededed` | `--mc-bg-app` `#1c1c1c` | 4.5:1 | **14.56:1** |
| 2 | `--mc-text-primary` `#ededed` | `--mc-bg-surface` `#202020` | 4.5:1 | **13.92:1** |
| 3 | `--mc-text-primary` `#ededed` | `--mc-bg-raised` `#2b2b2b` | 4.5:1 | **12.09:1** |
| 4 | `--mc-text-primary` `#ededed` | `--mc-bg-inset` `#141414` | 4.5:1 | **15.74:1** |
| 5 | `--mc-text-secondary` `#b2b2b2` | `--mc-bg-app` `#1c1c1c` | 4.5:1 | **8.04:1** |
| 6 | `--mc-text-secondary` `#b2b2b2` | `--mc-bg-surface` `#202020` | 4.5:1 | **7.68:1** |
| 7 | `--mc-text-secondary` `#b2b2b2` | `--mc-bg-raised` `#2b2b2b` | 4.5:1 | **6.68:1** |
| 8 | `--mc-text-secondary` `#b2b2b2` | `--mc-bg-inset` `#141414` | 4.5:1 | **8.69:1** |
| 9 | `--mc-text-muted` `#9a9a9a` | `--mc-bg-app` `#1c1c1c` | 4.5:1 | **6.06:1** |
| 10 | `--mc-text-muted` `#9a9a9a` | `--mc-bg-surface` `#202020` | 4.5:1 | **5.79:1** |
| 11 | **`--mc-text-muted` `#9a9a9a`** | **`--mc-bg-raised` `#2b2b2b`** | **4.5:1** | **5.03:1** |
| 12 | `--mc-text-muted` `#9a9a9a` | `--mc-bg-inset` `#141414` | 4.5:1 | **6.55:1** |

Row 11 is the binding case for muted text — `--mc-bg-raised` is the lightest layer and therefore the worst for a light foreground. It is the pair a future canvas tweak is most likely to break silently, because raised surfaces (toasts, modals, popovers, the command palette) are where muted hints, timestamps and empty-state copy actually live. Rev. 1's deleted "muted is never used on layer 2" restriction stays deleted: it was violated by this document's own wireframes in four places, and the correct fix is a token that passes everywhere.

#### 7.1.2 Accent and on-accent (4.5:1 floor for text, 3:1 for marks)

| # | Foreground | Background | Floor | **Measured** |
|---|---|---|---|---|
| 13 | **`--mc-on-accent` `#171717`** | **`--mc-accent` `#3ecf8e`** | **4.5:1** | **8.98:1** |
| 14 | `--mc-on-accent` `#171717` | `--mc-accent-hover` `#4ade80` | 4.5:1 | **10.29:1** |
| 15 | `--mc-on-accent` `#171717` | `--mc-accent-active` `#24b47e` | 4.5:1 | **6.75:1** |
| 16 | `--mc-accent` `#3ecf8e` (link/text) | `--mc-bg-app` `#1c1c1c` | 4.5:1 | **8.54:1** |
| 17 | `--mc-accent` `#3ecf8e` (link/text) | `--mc-bg-surface` `#202020` | 4.5:1 | **8.16:1** |
| 18 | `--mc-accent` `#3ecf8e` (link/text) | `--mc-bg-raised` `#2b2b2b` | 4.5:1 | **7.09:1** |
| 19 | `--mc-accent` `#3ecf8e` | `--mc-accent-subtle` `#1e3329` | 4.5:1 | **6.74:1** |
| 20 | `--mc-text-primary` `#ededed` | `--mc-accent-subtle` `#1e3329` | 4.5:1 | **11.49:1** |

Rows 16–18 matter because the emerald is used as *foreground* on this canvas (links, active nav labels, the `▶ n running` count), which `Design.md` never does — there it is a fill only, since `#3ecf8e` on `#ffffff` measures **2.00:1** and fails even the 3:1 non-text floor. The dark canvas is what makes emerald-as-foreground legal at all (§2.6.2).

#### 7.1.3 Control boundaries and focus (3:1 non-text floor, SC 1.4.11)

| # | Foreground | Background | Floor | **Measured** |
|---|---|---|---|---|
| 21 | **`--mc-border-control` `#7a7a7a`** | **`--mc-bg-app` `#1c1c1c`** | **3:1** | **3.97:1** |
| 22 | **`--mc-border-control` `#7a7a7a`** | **`--mc-bg-surface` `#202020`** | **3:1** | **3.80:1** |
| 23 | **`--mc-border-control` `#7a7a7a`** | **`--mc-bg-raised` `#2b2b2b`** | **3:1** | **3.30:1** |
| 24 | `--mc-border-control` `#7a7a7a` | `--mc-bg-inset` `#141414` (field fill) | 3:1 | **4.29:1** |
| 25 | `--mc-border-control-hover` `#a3a3a3` | `--mc-bg-surface` `#202020` | 3:1 | **6.46:1** |
| 26 | `--mc-border-focus` = `--mc-accent` `#3ecf8e` | `--mc-bg-app` `#1c1c1c` | 3:1 | **8.54:1** |
| 27 | `--mc-border-focus` = `--mc-accent` `#3ecf8e` | `--mc-bg-surface` `#202020` | 3:1 | **8.16:1** |
| 28 | `--mc-border-focus` = `--mc-accent` `#3ecf8e` | `--mc-bg-raised` `#2b2b2b` | 3:1 | **7.09:1** |
| 29 | `--mc-border-focus` ring vs its 1px `--mc-bg-app` gap on an accent-filled button (§7.2) | `#1c1c1c` | 3:1 | **8.54:1** |

Row 23 is the binding case and the reason `--mc-border-control` exists at all (§2.1.2). **`--mc-border` `#333333` is deliberately absent from this table**: it is a decorative hairline that identifies nothing, it measures 1.29:1 on `--mc-bg-surface`, and asserting a floor it was never intended to meet would be exactly the kind of false claim this rewrite exists to remove. Row 29 records why the focus ring on an emerald button needs a gap — ring-against-fill would be 1:1.

#### 7.1.4 F7 session-state ramp — as badge text on its own ground (4.5:1 floor)

| # | Foreground | Background | Floor | **Measured** |
|---|---|---|---|---|
| 30 | `--mc-state-created` `#b2b2b2` | `--mc-state-created-subtle` `#2c2c2c` | 4.5:1 | **6.59:1** |
| 31 | `--mc-state-running` `#4fa8bd` | `--mc-state-running-subtle` `#212a2c` | 4.5:1 | **5.35:1** |
| 32 | `--mc-state-paused` `#e5b64a` | `--mc-state-paused-subtle` `#302b21` | 4.5:1 | **7.45:1** |
| 33 | `--mc-state-completed` `#a9bdfa` | `--mc-state-completed-subtle` `#2a2c32` | 4.5:1 | **7.54:1** |
| 34 | `--mc-state-failed` `#f47460` | `--mc-state-failed-subtle` `#322523` | 4.5:1 | **5.27:1** |
| 35 | **`--mc-state-archived` `#8f8f8f`** | **`--mc-state-archived-subtle` `#232323`** | **4.5:1** | **4.86:1** |

Row 35 has the least headroom in the ramp and is the reason `archived`'s subtle ground is mixed darker (≈7%) than the other five (≈10%). One recipe, six states — no muted-label exception.

#### 7.1.5 F7 session-state ramp — as glyph dots on background layers (3:1 non-text floor)

| # | Foreground | `--mc-bg-app` | `--mc-bg-surface` | `--mc-bg-raised` | Floor |
|---|---|---|---|---|---|
| 36 | `--mc-state-created` `#b2b2b2` | **8.04:1** | **7.68:1** | **6.68:1** | 3:1 |
| 37 | `--mc-state-running` `#4fa8bd` | **6.22:1** | **5.95:1** | **5.17:1** | 3:1 |
| 38 | `--mc-state-paused` `#e5b64a` | **9.03:1** | **8.63:1** | **7.50:1** | 3:1 |
| 39 | `--mc-state-completed` `#a9bdfa` | **9.21:1** | **8.80:1** | **7.65:1** | 3:1 |
| 40 | `--mc-state-failed` `#f47460` | **6.10:1** | **5.83:1** | **5.07:1** | 3:1 |
| 41 | **`--mc-state-archived` `#8f8f8f`** | **5.27:1** | **5.04:1** | **4.38:1** | 3:1 |

Every state clears **4.38:1 or better on every layer** — well above the 3:1 non-text floor, and in fact above the 4.5:1 *text* floor too. That headroom is deliberate: these values are also used as bare label text in a handful of places (the connection chip's `offline` label, Needs Attention row glyphs, the `⏸ stream interrupted` strip) where there is no subtle ground behind them.

#### 7.1.6 Semantic status ramp (used as text on layers — 4.5:1 floor)

| # | Foreground | `--mc-bg-app` | `--mc-bg-surface` | `--mc-bg-raised` | On its own `-subtle` |
|---|---|---|---|---|---|
| 42 | `--mc-success` `#4fa8bd` | **6.22:1** | **5.95:1** | **5.17:1** | **5.35:1** on `#212a2c` |
| 43 | `--mc-warning` `#e5b64a` | **9.03:1** | **8.63:1** | **7.50:1** | **7.45:1** on `#302b21` |
| 44 | `--mc-danger` `#f47460` | **6.10:1** | **5.83:1** | **5.07:1** | **5.27:1** on `#322523` |
| 45 | `--mc-info` `#a9bdfa` | **9.21:1** | **8.80:1** | **7.65:1** | **7.54:1** on `#2a2c32` |

Row 44's `--mc-bg-raised` column (5.07:1) is the toast case — a sticky danger toast renders `--mc-danger` text on layer 2 and must hold AA there. Rev. 1's danger token would have been checked only against layer 0.

#### 7.1.7 Dark-on-colour fills (4.5:1 floor)

| # | Foreground | Background | Floor | **Measured** |
|---|---|---|---|---|
| 46 | `--mc-text-inverse` `#171717` | `--mc-danger` `#f47460` (destructive button) | 4.5:1 | **6.41:1** |
| 47 | `--mc-text-inverse` `#171717` | `--mc-warning` `#e5b64a` (warning chip) | 4.5:1 | **9.49:1** |

#### 7.1.8 Deliberate exclusions, stated

- **`--mc-text-disabled` `#707070`** measures **3.44:1** on `--mc-bg-app`, **3.29:1** on `--mc-bg-surface` and **2.86:1** on `--mc-bg-raised` — it fails AA as text and is excluded because WCAG 1.4.3 exempts disabled controls. It is admitted to the system for that purpose only. This is also precisely why §2.5 forbids it on phase-gated navigation, which is reachable and therefore *not* disabled.
- **`--mc-border` `#333333`** (1.35 / 1.29 / 1.12:1 across the layers) is decorative separation and is asserted against no floor — see §7.1.3.
- **Layer-to-layer elevation deltas** (`surface`↔`app` 1.05:1, `raised`↔`surface` 1.15:1, `inset`↔`surface` 1.13:1) are informational. On a near-black canvas they cannot be made to meet 3:1, which is why §2.1.1 requires a 1px border on every raised surface rather than relying on fill delta.

#### 7.1.9 Non-colour channels (unchanged, and load-bearing)

Colour is never the sole carrier of meaning: state badges include the verbatim F7 state name, **every StatusDot carries its state glyph** (§2.1.6), health rows include status words, the streaming pill includes the word "Streaming", Needs Attention rows are glyph-prefixed, and required-field/error states pair colour with icon + text. §2.1.6 additionally records the measured colour-vision-deficiency separations for the ramp and the one accepted residual (tritanopic `running`/accent, ΔE 10.1), which these channels cover.

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

- Token names and values in §2 are the canonical contract; WS4 maps them into the Tailwind 4 theme (mechanism is WS4's call). Both font families are **self-hosted `woff2` in `apps/frontend`, `font-display: swap`, no CDN** (§2.2.2) — this is a hard requirement of a LAN-only product, not a preference. **Circular is rejected and must not be introduced** (§2.6.2).

#### 8.1.1 Rev. 2 token migration (WS4 must absorb)

The brand rebase (§2.6) keeps most `--mc-*` names stable, but not all. Everything WS4 has to change is listed here; nothing else in the token contract moved.

**Renamed or added — action required**

| Change | Old | New | Note |
|---|---|---|---|
| **Added** | — | `--mc-border-control` `#7a7a7a` | Boundary of any control the edge identifies (inputs, selects, textareas, checkboxes, radios, toggle off-track, secondary buttons). **≥3:1, SC 1.4.11** — §2.1.2. Previously these used `--mc-border`, which does not meet the floor |
| **Added** | — | `--mc-border-control-hover` `#a3a3a3` | Hover/active on a control boundary |
| **Added** | — | `--mc-radius-xs` `4px` | Badges, chips, inline code — the role rev. 1's `--mc-radius-sm` served |
| **Added** | — | `--mc-radius-xl` `16px` | Login card, mobile sheets |
| **Added** | — | `--mc-fs-3xl/4xl/5xl` `36/48/64px` | `Design.md` display tier; `4xl`/`5xl` reserved, unused in Phase 1–2 |
| **Added** | — | `--mc-lh-*` (8 tokens), `--mc-fw-regular/medium`, `--mc-track-*` (5 tokens) | Line-height, weight and tracking split out of the size tokens — §2.2.3 |
| **Added** | — | `--mc-sp-16` `64px` | `Design.md` `huge` |
| **Removed** | `--mc-sp-5` `20px` | — | Migrate to `--mc-sp-4` (16px) |
| **Removed** | `--mc-sp-10` `40px` | — | Migrate to `--mc-sp-8` (32px) |
| **Removed** | `--mc-sp-12` `48px` | — | Migrate to `--mc-sp-8` (32px) or `--mc-sp-16` (64px) by intent |

**Revalued in place — name unchanged, value changed.** These are the dangerous ones: nothing breaks at build time, the UI just shifts.

| Token | Rev. 1 | Rev. 2 |
|---|---|---|
| `--mc-bg-app` / `-surface` / `-raised` / `-inset` | `#0D1117` / `#151B23` / `#1C232D` / `#0A0E14` | `#1c1c1c` / `#202020` / `#2b2b2b` / `#141414` |
| `--mc-bg-overlay` / `-hover` / `-selected` | blue-tinted rgba | `rgba(0,0,0,.72)` / `rgba(255,255,255,.055)` / `rgba(62,207,142,.12)` |
| `--mc-border` / `-strong` | `#2B3340` / `#3D4654` | `#333333` / `#4a4a4a` |
| `--mc-text-primary` / `-secondary` / `-muted` / `-disabled` / `-inverse` | `#E6EDF3` / `#A0ABBB` / `#838D9C` / `#4D5560` / `#0D1117` | `#ededed` / `#b2b2b2` / `#9a9a9a` / `#707070` / `#171717` |
| `--mc-accent` / `-hover` / `-active` / `-subtle` / `--mc-on-accent` | `#4D9FFF` / `#6FB2FF` / `#3B8BEB` / `#10243E` / `#06101F` | `#3ecf8e` / `#4ade80` / `#24b47e` / `#1e3329` / `#171717` |
| `--mc-success` / `-warning` / `-danger` / `-info` (+ `-subtle`) | `#3FB950` / `#D29922` / `#F85149` / `#58A6FF` | `#4fa8bd` / `#e5b64a` / `#f47460` / `#a9bdfa` |
| `--mc-state-*` (all six + subtles) | see rev. 1 | see §2.1.6 |
| `--mc-fs-2xs` … `--mc-fs-2xl` | 11 / 12 / 13 / 14 / 16 / 20 / 26 px | **12 / 13 / 14 / 16 / 18 / 22 / 28 px** |
| `--mc-radius-sm` / `-md` / `-lg` / `-full` | 4 / 6 / 10 / 999 px | **6 / 8 / 12 / 9999 px** |

**Consequences WS4 should plan for beyond a find-and-replace**

1. **`--mc-radius-sm` changed meaning.** It was 4px (badges); it is now 6px (buttons/inputs). Every badge and chip must be repointed to `--mc-radius-xs` or it grows. This is the one rename most likely to slip through, because both names still exist and both still compile.
2. **Every input, select, textarea and secondary button changes border token** from `--mc-border` to `--mc-border-control`. This is an accessibility fix (§2.1.2), not a style preference — the old value measured 1.29:1 against a 3:1 requirement.
3. **Weight 600 is retired.** WS4 §9.1 ships "UI 400/500/600"; drop the 600 face. Card, page and modal titles move to 500 with the `Design.md` tracking (§2.2.3).
4. **The type scale shifted up one rung**, so vertical rhythm, truncation points and any hard-coded `max-height` on dense rows need a pass. `--mc-row-dense` (36px) is unchanged and still fits a 14/20 cell.
5. **`StatusBadge`'s state→colour mapping is unchanged in shape** (WS4 §9.1 maps F7 state strings to `--color-state-<state>`), but every value behind it moved. The mapping code needs no edit; the theme file does.
6. **The `--mc-lh-*` / `--mc-track-*` split is new.** Rev. 1 fused size and line-height into one token; `Design.md` needs 18px at two different line-heights (`heading-md` 1.4 and `body-lg` 1.55), which a fused token cannot express.
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

### 8.3 Design critique record (rev. 1, 2026-08-11)

The `ui-ux-designer` structured critique pass required by project plan §3 (WS5 row) was performed and **fully incorporated on 2026-08-11**. Twelve must-fix findings and eight secondary findings were accepted and applied. Summary of what changed:

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

### 8.4 Revision record — rev. 2, brand rebase (2026-08-12)

The product owner supplied `Design.md`, a Supabase-inspired brand direction, as a new input. Rev. 2 re-bases the design system onto it. **The direction was accepted as dark-first with the emerald accent** — `Design.md` is authored light-first, but PRD §14 mandates dark mode first and the emerald measures **2.00:1 on white** against **8.54:1 on `#1c1c1c`**, so the dark reading is both mandated and the one the accent survives. Scope of the revision:

| # | Change | Sections |
|---|---|---|
| R1 | **Canvas family re-based from cool blue-black to neutral near-black.** `#0D1117`/`#151B23`/`#1C232D` → `#1c1c1c`/`#202020`/`#2b2b2b` (`Design.md` `canvas-night` / `canvas-night-soft` + a WS5-chosen raised layer). The largest visual change: the product now reads as quietly technical rather than blue-tinted, and it frees the blue region of the spectrum for signalling | §2.1.1 |
| R2 | **Accent re-based from blue `#4D9FFF` to emerald `#3ecf8e`,** with `#24b47e` pressed, `#4ade80` hover, `#171717` on-accent (8.98:1) | §2.1.4 |
| R3 | **Accent-discipline rule established.** The emerald marks operator intent and position — actionable, selected, focused, current — and **never reports a system condition.** This is the rule the rest of the revision hangs on | §2.1.4 |
| R4 | **F7 state ramp re-hued to a family the accent does not occupy,** resolving the collision R2 created (rev. 1's `running` `#3FB950` sat only ΔE 23.0 from the new accent — a running badge would have read as a primary button). `running` → cyan `#4fa8bd`; `created` → achromatic; `paused` → desaturated amber; `completed` → periwinkle; `failed` → lightened tomato; `archived` → neutral dim. Verified under deuteranopia, protanopia and tritanopia by simulation, not assertion | §2.1.6 |
| R5 | **`--mc-success` moved from green to cyan** for the same reason — a green `● live` chip beside an emerald CTA is exactly the ambiguity R3 forbids, and an exception for "healthy" would be the case operators meet on every screen | §2.1.5 |
| R6 | **Two accent-as-state usages removed:** the Spend meter's under-threshold fill (now `--mc-success`) and the `live` connection dot (now `--mc-success`). Accent usages that survive are all intent/position: focus ring, active nav and tab rules, selection washes, toggle-on track, unread-activity dots, the Settings dirty-field rule, indeterminate activity bars | §5.2, §3.3, §2.1.4 |
| R7 | **Circular rejected**; Inter retained and set at Circular's metrics (weight-500 display tier + negative tracking). Reason recorded so it is not re-added: commercial Lineto licence vs. the self-hosted-`woff2`-no-CDN requirement of an offline LAN product | §2.2.1, §2.6.2 |
| R8 | **Type scale, weights and tracking adopted from `Design.md` verbatim** (one declared interpolation: `body-sm` 14/20). Token names held stable; values shifted up one rung. **Weight 600 retired** | §2.2.3 |
| R9 | **Spacing and radii adopted verbatim.** Three spacing rungs removed, one added; radii gained `xs` and `xl` and revalued `sm`/`md`/`lg` | §2.3 |
| R10 | **`--mc-border-control` introduced.** Rev. 1 used one border token for card edges and input outlines and stated a floor for neither; SC 1.4.11 requires 3:1 for control boundaries, and on a near-black canvas *no darker fill can reach it* (black on `#202020` tops out at 1.29:1), so the border must carry identification | §2.1.2, §7.1.3 |
| R11 | **§7.1 rewritten in full as a 47-row computed assertion table.** Rev. 1 shipped three pairs claimed passing that were not; every row now carries a ratio calculated from the two hex values in that row, and tokens with no floor (`--mc-border`, `--mc-text-disabled`) are excluded explicitly rather than silently | §7.1 |
| R12 | **Component inventory kept in full and restyled.** `Design.md`'s marketing vocabulary (pricing cards, feature cards, hero nav, footer) was rejected as out of domain; its button, input and code-block primitives were absorbed | §2.5, §2.6.2 |
| R13 | **Provenance recorded** — adopted, rejected, and the three supplied values changed on measured grounds (`ink-mute` 3.44:1 fails as text; `accent-tomato` 4.45:1 marginally under AA; `accent-yellow` too loud for the calmest state) | §2.6 |

**Two findings worth carrying forward, because both were counter-intuitive and both were settled by measurement rather than judgement:**

1. **A rose-red `failed` state is worse for colour-blind operators than a coral one, not better.** The intuition — "add blue, deuteranopes retain the blue axis" — is wrong at this specific pairing: rose `#f5707f` simulates to near-identical khaki against the emerald under deuteranopia (**ΔE 7.4**) and against `archived` under protanopia (**ΔE 5.4**). The warmer coral `#f47460` scores **23.5** and **23.7** on those same pairs. Recorded in §2.1.6 so the value is not "corrected" back.
2. **On a near-black canvas, a control boundary cannot be carried by the field's fill.** No colour darker than the surrounding surface can reach 3:1 against it — the ceiling is 1.29:1. This is a hard consequence of the neutral canvas that only appeared once the palette was re-based, and it is why R10 exists.

**Open items unchanged by this revision.** §8.2's flags stand as written; the rebase touched no behaviour, no F7 vocabulary, no entity name and no API surface. The one WS7 arbitration still open (Upcoming Tasks, §8.2 item 1) is unaffected.
