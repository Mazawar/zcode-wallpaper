/**
 * Maps Material Design 3 scheme roles onto ZCode's Tailwind v4 `--color-*`
 * semantic tokens. ZCode defines light tokens in `:root` and dark overrides in
 * `.dark`; we override both blocks so the app's own dark-mode switch keeps
 * working. Surface-like tokens get alpha so the wallpaper layer shows through.
 *
 * material-color-utilities 0.3.0 schemes lack the newer surfaceContainer*
 * roles, so those are derived from the neutral tonal palette at the official
 * MD3 tones (light: 100/96/94/92/90, dark: 4/10/12/17/22).
 */

import { argbToCss } from "./monet.js";
import type { Theme } from "@material/material-color-utilities";

export interface ThemeOptions {
  /** Wallpaper dimming overlay strength, 0-100 (higher = darker). */
  dim: number;
  /** Whether surface tokens should be translucent (wallpaper visible). */
  wallpaperVisible: boolean;
}

const LIGHT_SURFACE_TONES = { lowest: 100, low: 96, container: 94, high: 92, highest: 90 };
const DARK_SURFACE_TONES = { lowest: 4, low: 10, container: 12, high: 17, highest: 22 };

export function buildVariableOverrides(theme: Theme, opts: ThemeOptions): string {
  return `${rootBlock(theme, opts)}\n.dark{${tokenRows(theme, "dark", opts).join("")}}`;
}

/**
 * Transparency-only overrides for `monet: false`: make the wallpaper show
 * through with neutral scrims while keeping ZCode's own colors untouched.
 * Only background/surface/input tokens are set; foregrounds, accents and
 * borders stay native.
 */
export function buildTransparencyOverrides(opts: { dim: number }): string {
  return `:root,:host{${transparencyRows("light", opts).join("")}}\n.dark{${transparencyRows("dark", opts).join("")}}`;
}

const LIGHT_SCRIM = "255,255,255";
const DARK_SCRIM = "18,18,22";

function transparencyRows(mode: "light" | "dark", opts: { dim: number }): string[] {
  const rgb = mode === "light" ? LIGHT_SCRIM : DARK_SCRIM;
  const baseAlpha = 0.72;
  const panelAlpha = 0.62;
  const inputAlpha = 0.5;
  const popoverAlpha = 0.92;
  return [
    `--color-background:transparent;`,
    `--color-background-alt:rgba(${rgb},${panelAlpha});`,
    `--color-background-win-alt:rgba(${rgb},${panelAlpha});`,
    `--color-panel:rgba(${rgb},${panelAlpha});`,
    `--color-sidebar:rgba(${rgb},${panelAlpha});`,
    `--color-surface:rgba(${rgb},${baseAlpha});`,
    `--color-surface-hover:rgba(${rgb},${baseAlpha});`,
    `--color-card:rgba(${rgb},${baseAlpha});`,
    `--color-card-selected:rgba(${rgb},${Math.min(1, baseAlpha + 0.15)});`,
    `--color-popover:rgba(${rgb},${popoverAlpha});`,
    `--color-input:rgba(${rgb},${inputAlpha});`,
    `--color-input-focused:rgba(${rgb},${Math.min(1, inputAlpha + 0.2)});`,
    opts.dim > 0 ? `--zcode-beautify-dim:${opts.dim / 100};` : "",
  ].filter(Boolean);
}

function rootBlock(theme: Theme, opts: ThemeOptions): string {
  return `:root,:host{${tokenRows(theme, "light", opts).join("")}}`;
}

function tokenRows(theme: Theme, mode: "light" | "dark", opts: ThemeOptions): string[] {
  const s = mode === "light" ? theme.schemes.light : theme.schemes.dark;
  const t = mode === "light" ? LIGHT_SURFACE_TONES : DARK_SURFACE_TONES;
  const n = theme.palettes.neutral;
  const A = (argb: number, alpha = 1) => argbToCss(argb, alpha);

  // Surface alpha: with a wallpaper we let it through; without one, opaque.
  const baseAlpha = opts.wallpaperVisible ? 0.72 : 1;
  const panelAlpha = opts.wallpaperVisible ? 0.62 : 1;
  const inputAlpha = opts.wallpaperVisible ? 0.5 : 1;
  const popoverAlpha = opts.wallpaperVisible ? 0.92 : 1;

  return [
    // Window & page backgrounds become transparent so the wallpaper layer shows.
    `--color-background:transparent;`,
    `--color-background-alt:${A(n.tone(t.high), panelAlpha)};`,
    `--color-background-win-alt:${A(n.tone(t.low), panelAlpha)};`,
    `--color-panel:${A(n.tone(t.low), panelAlpha)};`,
    `--color-sidebar:${A(n.tone(t.low), panelAlpha)};`,
    `--color-surface:${A(n.tone(t.lowest === 100 ? 98 : 6), baseAlpha)};`,
    `--color-surface-hover:${A(n.tone(t.high), baseAlpha)};`,
    `--color-card:${A(n.tone(t.container), baseAlpha)};`,
    `--color-card-selected:${A(n.tone(t.highest), Math.min(1, baseAlpha + 0.15))};`,
    `--color-card-border:${A(s.outlineVariant, 0.5)};`,
    `--color-popover:${A(n.tone(t.container), popoverAlpha)};`,
    `--color-input:${A(n.tone(t.highest), inputAlpha)};`,
    `--color-input-focused:${A(n.tone(t.highest), Math.min(1, inputAlpha + 0.2))};`,
    `--color-input-border:${A(s.outlineVariant, 0.6)};`,
    `--color-input-border-hover:${A(s.outline, 0.7)};`,
    `--color-input-border-focused:${A(s.primary, 0.9)};`,

    `--color-foreground:${A(s.onSurface)};`,
    `--color-foreground-subtle:${A(s.onSurfaceVariant)};`,
    `--color-foreground-subtlest:${A(s.onSurfaceVariant, 0.72)};`,
    `--color-foreground-inverse:${A(s.inverseOnSurface)};`,

    `--color-primary:${A(s.primary)};`,
    `--color-primary-foreground:${A(s.onPrimary)};`,
    `--color-secondary:${A(s.secondaryContainer)};`,
    `--color-accent:${A(s.tertiary)};`,
    `--color-brand:${A(s.primary)};`,

    `--color-border:${A(s.outlineVariant, 0.55)};`,
    `--color-border-hover:${A(s.outlineVariant, 0.9)};`,
    `--color-border-color-interactive:${A(s.outlineVariant, 0.7)};`,
    `--color-border-color-interactive-hover:${A(s.outlineVariant, 1)};`,
    `--color-border-color-interactive-active:${A(s.primary, 0.9)};`,
    `--color-find-highlight:${A(s.tertiaryContainer)};`,
    `--color-find-highlight-active:${A(s.secondaryContainer)};`,
    `--divider-color:${A(s.outlineVariant, 0.4)};`,
    opts.dim > 0 ? `--zcode-beautify-dim:${opts.dim / 100};` : "",
  ].filter(Boolean);
}
