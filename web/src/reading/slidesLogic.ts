// Slide splitting of the presentation mode (SPEC §13.3), on the top-level blocks of a page.

export interface SlideBlock {
  type: string;
  props?: { level?: unknown } | Record<string, unknown>;
}

export interface Slide {
  /** Index of the first top-level block, inclusive. */
  start: number;
  /** Index of the last top-level block, inclusive. */
  end: number;
}

const levelOf = (b: SlideBlock): number => {
  const l = (b.props as { level?: unknown } | undefined)?.level;
  return typeof l === 'number' ? l : typeof l === 'string' ? Number(l) || 0 : 0;
};

/**
 * Dividers split first (they are removed from the slides); without any, every level-1 heading starts a
 * slide; without level-1 headings, every level-2 heading; otherwise the page is one slide.
 * Empty slides are dropped. A page without blocks yields one empty slide (the title slide).
 */
export function computeSlides(blocks: SlideBlock[]): Slide[] {
  const n = blocks.length;
  if (n === 0) return [{ start: 0, end: -1 }];
  const slides: Slide[] = [];
  const hasDivider = blocks.some((b) => b.type === 'divider');
  if (hasDivider) {
    let start = 0;
    for (let i = 0; i <= n; i++) {
      if (i === n || blocks[i]!.type === 'divider') {
        if (i - 1 >= start) slides.push({ start, end: i - 1 });
        start = i + 1;
      }
    }
  } else {
    const headingLevel = [1, 2].find((lvl) => blocks.some((b) => b.type === 'heading' && levelOf(b) === lvl));
    if (headingLevel === undefined) return [{ start: 0, end: n - 1 }];
    let start = 0;
    for (let i = 1; i <= n; i++) {
      if (i === n || (blocks[i]!.type === 'heading' && levelOf(blocks[i]!) === headingLevel)) {
        slides.push({ start, end: i - 1 });
        start = i;
      }
    }
  }
  return slides.length ? slides : [{ start: 0, end: n - 1 }];
}

/** CSS (selector → rules) showing only the top-level blocks of `slide`; `root` selects the block group. */
export function slideCss(root: string, slide: Slide | undefined): string {
  if (!slide || slide.end < slide.start) return `${root} > .bn-block-outer { display: none !important; }`;
  const a = slide.start + 1;
  const b = slide.end + 1;
  return (
    `${root} > .bn-block-outer { display: none !important; }\n` +
    `${root} > .bn-block-outer:nth-child(n+${a}):nth-child(-n+${b}) { display: block !important; }`
  );
}
