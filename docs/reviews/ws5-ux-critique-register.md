# WS5 UX Critique — Findings Register

- **Date:** 2026-08-11
- **Reviewer:** ui-ux-designer (structured critique pass, project plan §3 WS5 row)
- **Under review:** `docs/tds/06-wireframes-and-design-system.md`, cross-checked against `docs/tds/05-frontend-architecture.md` and `Requirements.md` (PRD v2.1)
- **Verdict on PRD §4.4 Settings coverage:** COMPLETE — all seven categories, all six integrations, every named field present; Memory/Agents correctly phase-gated; Services correctly shows "Queue (PostgreSQL)" instead of Redis. Defects found were interaction-semantic, not coverage gaps.
- **Disposition:** all 12 must-fix accepted; 8 of 13 secondary findings accepted. Applied via parallel edit passes (ui-designer → WS5, frontend-developer → WS4) with conflict resolutions pre-arbitrated by the orchestrator.

## Must-fix

| ID | Finding | Resolution |
|----|---------|-----------|
| MF1 | UUIDv7 prefixes used as the primary human label; leading bits are a millisecond timestamp, so same-hour sessions are visually identical | Human title (derived from first prompt, editable) leads; `project · branch` secondary; full ID copy-on-click in detail header only; compact ID column uses the LAST 6 hex chars |
| MF2 | Dashboard cannot answer "what failed / what needs attention"; in Phase 1 a `session.failed` that happened while away leaves only a dead toast | New **Needs Attention** widget, first in grid and mobile stack (failed sessions 24h, unhealthy services, last `sync.failed`, budget breaches); collapses to "All clear"; Services strip added to Dashboard |
| MF3 | No connection-liveness indicator in the app shell, contradicting WS4 §5.1 — an operator on the Dashboard with a dead socket sees confidently-wrong frozen data | Persistent `live`/`reconnecting`/`offline` chip in top bar + mobile header; when not live, all live regions render reduced-emphasis with "last updated HH:MM"; ticking durations freeze |
| MF4 | `created`-state composer specified two incompatible ways (WS5 disabled + modal prompt field; WS4 enabled + start-with-prompt) | **WS4 wins** — composer enabled, submit = start-with-prompt, `[Start]` alternate; WS5 removes the modal's prompt field and `Create only` split action |
| MF5 | Two irreconcilable multi-session models; no background-activity signal in either | Switcher becomes **shell-level** (open-sessions strip on every page); Live view tab bar is a projection of the same set; **detail layout stays WS5's right panel** (WS4 absorbs); unread-activity dot + count on both surfaces; "(n new)" restored on jump-to-latest |
| MF6 | No way to stop a turn in flight — the highest-urgency action on the screen — and undefined behaviour for a prompt typed during streaming | `[Stop]` replaces `[Pause]` while a turn is in flight, bound to `Esc`, mapped to WS1 interrupt semantics; typing during stream allowed, prompt renders as pending and delivers on turn completion |
| MF7 | A mid-stream failure discards the partial assistant turn — the entire triage signal | Partial turn retained in place with terminating rule (`— stream ended here · session failed …`); WS4 §6.2's "committed wins" rule now applies only when a canonical Message exists |
| MF8 | Settings dirty-state ambiguous three ways, incl. the exact "did my secret save?" hazard (test a pasted token, see success, navigate away, nothing persisted) | **WS4 wins** — Test Connection always tests persisted state, disabled while dirty ("Save changes to test"); per-field secret `[Save]` removed (panel Save is the single commit path); unsaved-changes guard modal + `beforeunload`; Save bar names change count |
| MF9 | Three token pairs fail WCAG AA by computed contrast; one contrast claim overstated | `--mc-text-muted` → **#838D9C**, layer restriction deleted (own wireframes violated it); `--mc-state-archived` → **#818B96**; on-accent claim corrected to ≥6.5:1; all four pairs added to the WS6 test contract |
| MF10 | Streaming a11y spec incoherent (`aria-live="polite"` and "off" are mutually exclusive) and excludes screen-reader users from the product's core output | `role="log"` + `aria-live="off"` on transcript; separate polite region announces turn boundaries only; completed turns become focusable articles with a "Read latest response" control; ToolCallBlock accessible names; `aria-busy` while streaming |
| MF11 | `Ctrl+1…9` is reserved by Chrome/Edge and never reaches page JS — the headline multi-session shortcut is dead; single-key shortcuts had no input guard; `g a` collided between ADRs and Agents | → **`Alt+1…9`** plus `Alt+[`/`Alt+]`; shortcuts suppressed inside inputs except `Esc`/send; ADRs remapped to `g r` |
| MF12 | State legibility carried by colour alone in compact contexts; running/paused/failed are the classic deuteranope green/amber/red collision | Glyph added per F7 state (`▶ ‖ ✓ ✕ ○ ▣`) mandated wherever a dot lacks an adjacent label, each with `aria-label`/`title`; colloquial "1 active" replaced with verbatim F7 names |

## Secondary findings — accepted

| ID | Finding | Resolution |
|----|---------|-----------|
| WC1 | Cost budget configurable but current spend invisible anywhere | Spend-vs-budget stat on Dashboard + `$x.xx / $y.yy` chip in top bar |
| WC3 | No in-transcript search; Timeline/Commits don't navigate to the transcript | Scoped `Ctrl+F` find (virtualizer-aware) + click-to-scroll from Timeline and Commits entries |
| WC6 | No command palette for a single power user | `Ctrl+K` palette as primary keyboard surface; `g` chords retained as aliases (also mitigates MF1 and MF5) |
| WC8 | Fonts never specified as self-hosted — an offline LAN server would silently fall back to Segoe UI and lose the type system | Both families self-hosted as `woff2` in `apps/frontend`, `font-display: swap`, no CDN |
| WC9 | Phase-gated nav styled disabled but clickable — an affordance lie, and `disabled`/`aria-disabled` would make routes keyboard-unreachable | Standardised on full-contrast label + muted `P3`/`P4` badge; never `disabled` on a focusable nav target |
| WC10 | Vocabulary/action drift vs WS4 on secondary controls | `[Clear]` adopted for secret destroy; **WS5's `archived` action set wins** (F7 permits resume from archived, WS4 was wrong) |
| WC11 | Launch modal has no working-tree disclosure — launching could silently disrupt local work | Resolved absolute working directory + current branch + dirty-file count shown; branch-change warning chip requiring acknowledgement |
| WC13 | **PRD §4.3 Workflow Modes (Manual/Assisted) have no UI surface anywhere** — a Phase 1 functional requirement with no home | Added to Settings → Integrations → GitHub with a per-Project override on the Project detail header |

## Secondary findings — deferred to WS7 or later

| ID | Finding | Disposition |
|----|---------|-------------|
| WC2 | No density budget; right panel squeezes diffs at 1280px | Partially absorbed via MF5 collapse rules; full breakpoint/drag-resize spec deferred to implementation |
| WC4 | Mobile puts monitoring payload in the worst thumb position; Services health three taps deep | Deferred — revisit when mobile monitoring is built (Phase 1 UI is desktop-first) |
| WC5 | Mobile session launch contradicts WS4 (FAB vs resume/clone only) | **Closed — WS7 arbitration A12: WS4 wins, no `+` FAB on mobile in V1.** Resume-as-new and Clone remain (launches with working dir / repo / branch inherited from a desktop-vetted Session); composing a *new* launch target is what mobile omits, because the Launch modal's mandatory working-tree disclosure and branch-change acknowledgement (WC11) cannot be honestly reviewed on a phone, and a FAB would give the most consequential, least-verifiable action the highest-prominence slot on the smallest screen. PRD §14 scopes mobile to monitoring. Applied to WS5 §5.4; annotated in WS4 §9.2 |
| WC7 | `Ctrl+Enter` to send fights Slack/ChatGPT/Claude convention | Deferred — proposed as a General setting ("Send with: Enter / Ctrl+Enter"); not applied to avoid churn |
| WC12 | Session-state colours are byte-identical to the status colours they claim to be independent of; `paused` reads as a warning | Deferred — MF12's glyphs remove the accessibility risk; re-palette is a polish item |

## Items escalated to WS7 — both resolved

1. **"Upcoming Tasks" widget (PRD §8.1)** — **Closed, WS7 arbitration A1: WS5's schedule read model wins.** The widget renders next Obsidian sync, next repository poll, and next daily report from `GET /api/v1/schedule` (WS2 §7.7), computed at read time from Settings + last-run records. **No Task entity is created or implied** — which was the original objection, and the schedule model does not need one. WS4's empty-state placeholder is withdrawn: a permanently empty widget on the primary page is furniture, and it invites someone to later fill it with a fake to-do feature, whereas the schedule model answers a question the operator actually asks and has an actionable empty state ("no scheduled work — set sync intervals in Settings"). Applied to WS4 §2.2/§13.5.
2. **WC5 mobile session launch** — Closed, arbitration A12; see the deferred-findings table above.

Full reasoning for both, and the other eleven arbitrations made at the integration gate, is recorded in `docs/tds/00-overview.md` §5.
