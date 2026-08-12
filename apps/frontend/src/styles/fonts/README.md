# Self-hosted fonts

**Binding rule (TDS 05 §9.1, TDS 06 §2.2.2): no CDN link, no Google Fonts, no runtime font
fetch of any kind is permitted.** Mission Control is a self-hosted product that must render
correctly on an offline LAN server with no egress. An external font request would produce
invisible-then-shifting text — a CLS source — on exactly the machine the product targets,
and would leak instance usage to a third party.

The font binaries are **deliberately not committed by the scaffold**. Add them here.

## Files to add

| Filename | Family | Weight | Notes |
|---|---|---|---|
| `inter-400.woff2` | Inter | 400 | UI regular |
| `inter-500.woff2` | Inter | 500 | UI medium — also the whole display tier |
| `jetbrains-mono-400.woff2` | JetBrains Mono | 400 | code, IDs, paths, costs, tool I/O |
| `jetbrains-mono-500.woff2` | JetBrains Mono | 500 | emphasised mono |

Four files, no more. **Weight 600 is retired from the design system** (TDS 06 §2.2.2) — the
display tier gets its presence from size and negative tracking at weight 500, not from a
heavier face. Ship only Latin subsets; a full Unicode Inter is roughly ten times the size
for glyphs this UI never renders.

## Where to get them

- **Inter** — SIL Open Font License 1.1. https://github.com/rsms/inter (releases ship
  `.woff2`), or subset from the variable font with `fonttools`/`glyphhanger`.
- **JetBrains Mono** — SIL Open Font License 1.1. https://github.com/JetBrains/JetBrainsMono

Both licences permit redistribution inside this repository. Keep the upstream `OFL.txt`
alongside the binaries.

**Circular is rejected — do not re-add it.** The brand reference (`Design.md`) specifies
Circular, a commercial Lineto face whose licence is per-domain and per-pageview. Self-hosting
it on an unmetered, un-domained, air-gapped host is not something that licence contemplates,
and there is no open substitute that *is* Circular. Inter set at Circular's metrics — weight
500 display tier, tracking −1.92 / −1.44 / −0.72 / −0.42px — lands in the same visual
register, and those metrics are already in `../theme.css`.

## Wiring

`../theme.css` already contains the four `@font-face` rules, **commented out** because the
files are absent and Vite fails a build on a missing asset reference. Uncomment that block
once the files are here. Each rule sets `font-display: swap`, and `--font-ui` / `--font-mono`
always name a system fallback, so first paint is never blocked — the fallbacks exist for a
corrupted asset, not as the expected rendering path.

Vite bundles and fingerprints these files automatically; nothing else needs configuring.
