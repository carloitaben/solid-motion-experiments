import type { Page } from '@playwright/test';

// Support for the browser specs (`hydration.spec.ts`, `layout-text.spec.ts`).
// Everything here is about observing the page from before its first frame: the
// recorder is installed with `addInitScript()`, so it runs at document-start,
// before any app code.

export type RecorderMark = {
  id: number;
  /** `[data-ssr-probe]`: the route's deliberate SSR hooks. */
  probe: boolean;
  tag: string;
  inlineTransform: string;
  inlineOpacity: string;
  /** True when the route's client-only refs report already had text. */
  hydrated: boolean;
  /** `document.readyState` when the node was first seen. */
  readyState: string;
};

export type RecorderNode = {
  id: number;
  connected: boolean;
  inlineTransform: string;
  inlineOpacity: string;
  transform: string;
  opacity: string;
  width: number;
  height: number;
};

export type RecorderFrame = {
  hydrated: boolean;
  nodes: RecorderNode[];
  /**
   * The three `.motion-api-lab-refrow` children as
   * `[width, height, left - first.left, top - first.top]`, from `offset*`
   * (transform-free). Relative values survive the page-level shift the route's
   * readout causes when it fills in after hydration.
   */
  refrow: number[][];
};

/**
 * One tracked node as the server painted it, before any client script ran.
 * `x`/`y` are document coordinates: `offsetLeft`/`offsetTop` are relative to
 * different offset parents, so they are not comparable across nodes.
 */
export type ServerPaintNode = {
  id: number;
  inlineTransform: string;
  inlineOpacity: string;
  transform: string;
  opacity: string;
  width: number;
  height: number;
  x: number;
  y: number;
};

export type RecorderMutation = { id: number; old: string | null; now: string | null };

export type RecorderState = {
  marks: RecorderMark[];
  frames: RecorderFrame[];
  mutations: RecorderMutation[];
  /**
   * Frozen at the first frame where the document was fully parsed and no
   * client script had run (`holdScriptsUntilServerPaint()` guarantees that
   * ordering). This is the paint the no-JS page can be compared against;
   * nothing the client writes can leak into it.
   */
  serverPaint?: ServerPaintNode[];
};

declare global {
  interface Window {
    __hydrationRecorder: RecorderState;
    /** Inline `transform` samples taken by `recordStyleWrites()`. */
    __motionStyleSamples: string[];
    /** Frames taken by `startTextGeometrySample()`. */
    __textGeometry?: TextGeometryFrame[];
    __textGeometryActive?: boolean;
  }
}

/** An inline `transform` as `DOMMatrix` reads it, `[a, b, c, d, e, f]`. */
export type Matrix = [number, number, number, number, number, number];

/** One inline `transform` observed during a layout run, with its numbers. */
export type StyleSample = {
  transform: string;
  matrix: Matrix;
};

/**
 * One text node in one sampled frame. `width`/`height` come from
 * `getBoundingClientRect()` — after every ancestor projection transform — and
 * `layoutWidth`/`layoutHeight` from `offsetWidth`/`offsetHeight` — the same box
 * with no transform. A counter-scaled nested layout node keeps the two equal
 * while its parent is projected; a text node painted straight into a scaled
 * box does not.
 */
export type TextGeometryNode = {
  text: string;
  width: number;
  height: number;
  layoutWidth: number;
  layoutHeight: number;
  /** Deviation from 1 of the nearest layout ancestor's computed transform scale. */
  parentScale: number;
};

export type TextGeometryFrame = { ms: number; nodes: TextGeometryNode[] };

const IDENTITY_MATRIX: Matrix = [1, 0, 0, 1, 0, 0];
// `a`-`d` are scale/skew ratios, `e`/`f` translation in px. The tolerances keep
// an identity written in transform syntax (`scale(1, 1)`,
// `translate3d(0px, 0px, 0px)`) out of the projected set: a sub-pixel shift or
// a sub-percent scale is not a projection anyone could see.
const IDENTITY_TOLERANCE: Matrix = [0.005, 0.005, 0.005, 0.005, 0.5, 0.5];

/**
 * Whether the matrix actually moves, scales or skews the element — a numeric
 * test, not a check that the value looks like a transform.
 */
export function isProjection(matrix: Matrix): boolean {
  return matrix.some(
    (value, index) => Math.abs(value - IDENTITY_MATRIX[index]) > IDENTITY_TOLERANCE[index],
  );
}

/** Installed with `addInitScript()`; must not close over anything. */
export function installHydrationRecorder() {
  const state: RecorderState = { marks: [], frames: [], mutations: [] };
  window.__hydrationRecorder = state;

  // The refs report is rendered empty on the server and written by the route's
  // `onSettled(readRefs)` on the client, so non-empty means the tree hydrated
  // and its refs ran on the server nodes.
  const hydrated = () => {
    const section = document.getElementById('motion-api-refs')?.closest('section');
    const output = section?.querySelector('output.motion-api-lab-readout');
    return (output?.textContent ?? '').trim().length > 0;
  };

  const ids = new WeakMap<Element, number>();
  const tracked: HTMLElement[] = [];

  const scan = () => {
    for (const element of document.querySelectorAll<HTMLElement>(
      '[data-layout], [data-ssr-probe]',
    )) {
      if (ids.has(element)) continue;
      const id = tracked.length;
      ids.set(element, id);
      tracked.push(element);
      const probe = element.hasAttribute('data-ssr-probe');
      state.marks.push({
        id,
        probe,
        tag: element.tagName.toLowerCase(),
        inlineTransform: element.style.transform,
        inlineOpacity: element.style.opacity,
        hydrated: hydrated(),
        readyState: document.readyState,
      });
      if (!probe) continue;
      // The inline frame on a probe is the thing under test: record every
      // rewrite, including one that writes the same value back. A batch holds
      // one record per write, but `oldValue` is read at delivery, so the value
      // a write left behind is the next record's `oldValue` (or the live
      // attribute, for the last write in the batch).
      new MutationObserver((records) => {
        for (const [index, record] of records.entries()) {
          state.mutations.push({
            id,
            old: record.oldValue,
            now:
              records[index + 1]?.oldValue ??
              (record.target as HTMLElement).getAttribute('style'),
          });
        }
      }).observe(element, {
        attributes: true,
        attributeFilter: ['style'],
        attributeOldValue: true,
      });
    }
  };

  const refrow = () => {
    const row = document.querySelector<HTMLElement>('.motion-api-lab-refrow');
    const children = row ? ([...row.children] as HTMLElement[]) : [];
    const base = children[0];
    if (!base) return [];
    return children.map((element) => [
      element.offsetWidth,
      element.offsetHeight,
      element.offsetLeft - base.offsetLeft,
      element.offsetTop - base.offsetTop,
    ]);
  };

  // `trackedServerPaint()` in this module reads the same eight fields from a
  // page that never hydrates. The recorder cannot share that function (an init
  // script is serialised on its own), so the shape is repeated on purpose.
  const serverPaintNode = (element: HTMLElement, id: number): ServerPaintNode => {
    const computed = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return {
      id,
      inlineTransform: element.style.transform,
      inlineOpacity: element.style.opacity,
      transform: computed.transform,
      opacity: computed.opacity,
      width: element.offsetWidth,
      height: element.offsetHeight,
      x: box.left + window.scrollX,
      y: box.top + window.scrollY,
    };
  };

  const sample = () => {
    const isHydrated = hydrated();
    // The server paint is frozen at the first frame that sees a fully parsed
    // document while no client script has run. The spec holds every module
    // script until this exists, so the snapshot is server markup by
    // construction rather than a frame that won a race with hydration.
    if (!isHydrated && !state.serverPaint && document.readyState !== 'loading') {
      // MutationObserver callbacks are microtasks; make sure a node shipped in
      // the last streamed chunk is in `tracked` before freezing.
      scan();
      state.serverPaint = tracked.map((element, id) => serverPaintNode(element, id));
    }
    state.frames.push({
      hydrated: isHydrated,
      nodes: tracked.map((element, id) => {
        const computed = getComputedStyle(element);
        return {
          id,
          connected: element.isConnected,
          inlineTransform: element.style.transform,
          inlineOpacity: element.style.opacity,
          transform: computed.transform,
          opacity: computed.opacity,
          width: element.offsetWidth,
          height: element.offsetHeight,
        };
      }),
      refrow: refrow(),
    });
    // ~20s at 60fps; a run finishes long before the cap, which only stops an
    // accidentally long-lived page from growing the trace without bound.
    if (state.frames.length < 1200) requestAnimationFrame(sample);
  };

  new MutationObserver(scan).observe(document, { childList: true, subtree: true });
  scan();
  requestAnimationFrame(sample);
}

/**
 * Holds every module script until the recorder has frozen the server paint.
 * Hydration is the client entry running, so this makes the frames the spec
 * calls "server paint" pre-hydration by construction instead of by hoping a
 * frame fits in Vite's module loading time. Inline scripts still run (they only
 * register hydration plumbing), and the request for the document, styles and
 * assets is never delayed.
 */
export async function holdScriptsUntilServerPaint(page: Page) {
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() !== 'script') {
      await route.continue();
      return;
    }
    try {
      await page.waitForFunction(
        () => Boolean(window.__hydrationRecorder?.serverPaint),
        undefined,
        { timeout: 10_000 },
      );
    } catch {
      // Release anyway and let the spec's own assertion report the missing
      // server paint, rather than hanging the navigation on a broken gate.
    }
    await route.continue();
  });
}

export async function readRecorder(page: Page): Promise<RecorderState> {
  return page.evaluate(() => ({
    marks: window.__hydrationRecorder.marks,
    frames: window.__hydrationRecorder.frames,
    mutations: window.__hydrationRecorder.mutations,
    serverPaint: window.__hydrationRecorder.serverPaint,
  }));
}

export type BrowserProblem = { kind: 'console' | 'pageerror'; type: string; text: string };

/** Collects console errors/warnings and uncaught page errors for one page. */
export function collectProblems(page: Page): BrowserProblem[] {
  const problems: BrowserProblem[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      problems.push({ kind: 'console', type: message.type(), text: message.text() });
    }
  });
  page.on('pageerror', (error) => {
    problems.push({ kind: 'pageerror', type: 'pageerror', text: String(error) });
  });
  return problems;
}

/** Throws unless the browser reported no errors and no hydration mismatch. */
export function expectNoBrowserProblems(problems: BrowserProblem[]) {
  const errors = problems.filter(
    (problem) => problem.kind === 'pageerror' || problem.type === 'error',
  );
  if (errors.length) {
    throw new Error(`browser errors:\n${errors.map((e) => `- ${e.text}`).join('\n')}`);
  }
  const hydration = problems.filter((problem) =>
    /hydrat|mismatch|did not match|expected server/i.test(problem.text),
  );
  if (hydration.length) {
    throw new Error(
      `hydration warnings:\n${hydration.map((p) => `- ${p.text}`).join('\n')}`,
    );
  }
}

/** The refs section's client-only report; empty until hydration. */
export const refsReport = (page: Page) =>
  page.locator('section[aria-labelledby="motion-api-refs"] output.motion-api-lab-readout');

/** Refrow geometry in the same `[width, height, left, top]` shape the recorder uses. */
export async function refrowGeometry(page: Page): Promise<number[][]> {
  return page.evaluate(() => {
    const row = document.querySelector('.motion-api-lab-refrow');
    const children = row ? [...row.children] : [];
    const base = children[0] as HTMLElement | undefined;
    if (!base) return [];
    return children.map((child) => {
      const element = child as HTMLElement;
      return [
        element.offsetWidth,
        element.offsetHeight,
        element.offsetLeft - base.offsetLeft,
        element.offsetTop - base.offsetTop,
      ];
    });
  });
}

/**
 * The no-JS page's paint of every tracked node, in document order and in the
 * shape `serverPaintNode()` freezes in the recorder — so the hydrated page's
 * server paint and this baseline compare directly. Run it on a page where
 * JavaScript is disabled: nothing can hydrate, animate or re-render, which
 * makes it the oracle for "the server paint".
 */
export async function trackedServerPaint(page: Page): Promise<ServerPaintNode[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-layout], [data-ssr-probe]')].map(
      (element, id) => {
        const computed = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return {
          id,
          inlineTransform: element.style.transform,
          inlineOpacity: element.style.opacity,
          transform: computed.transform,
          opacity: computed.opacity,
          width: element.offsetWidth,
          height: element.offsetHeight,
          x: box.left + window.scrollX,
          y: box.top + window.scrollY,
        };
      },
    ),
  );
}

/**
 * Samples one element's inline `transform` from now on, including its current
 * value. Installed before a click; read the samples with `readStyleWrites()`.
 *
 * These are samples, not writes: a `MutationObserver` callback runs once per
 * microtask with every record from that task, so a value written and
 * overwritten in the same task is seen only once, as the value the element
 * holds when the callback runs. Motion writes one transform per animation
 * frame, so a layout run shows up frame by frame; a run that finished inside a
 * single task would contribute only its final value.
 */
export async function recordStyleWrites(page: Page, selector: string) {
  await page.evaluate((target) => {
    const element = document.querySelector<HTMLElement>(target);
    if (!element) throw new Error(`recordStyleWrites: no element matches ${target}`);
    const samples = [element.style.transform];
    window.__motionStyleSamples = samples;
    new MutationObserver(() => {
      samples.push(element.style.transform);
    }).observe(element, { attributes: true, attributeFilter: ['style'] });
  }, selector);
}

/** The samples `recordStyleWrites()` has taken, each parsed by `DOMMatrix`. */
export async function readStyleWrites(page: Page): Promise<StyleSample[]> {
  return page.evaluate(() => {
    const parse = (transform: string): Matrix => {
      if (!transform || transform === 'none') return [1, 0, 0, 1, 0, 0];
      const matrix = new DOMMatrixReadOnly(transform);
      return [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f];
    };
    return (window.__motionStyleSamples ?? []).map((transform) => ({
      transform,
      matrix: parse(transform),
    }));
  });
}

/**
 * Samples `getBoundingClientRect()` against `offsetWidth`/`offsetHeight` for
 * every node matching `selector`, once per animation frame, from now until
 * `stopTextGeometrySample()`. Start it before the click and stop it after the
 * run has settled, so the interruption path is covered too.
 *
 * A nested `data-layout="position"` node is counter-scaled by Motion while its
 * layout ancestor is projected; if that correction is missing (a text node
 * painted straight into a scaled box, or a transform that does not apply), the
 * ratio between the two boxes moves with the ancestor's scale instead of
 * staying at 1. `parentScale` is sampled from the nearest layout ancestor so a
 * test can prove the frame was actually projected rather than vacuously flat.
 * Hidden nodes (Motion keeps a replaced shared branch connected but hidden) are
 * recorded with zero size and ignored by the assertions.
 */
export async function startTextGeometrySample(page: Page, selector: string) {
  await page.evaluate((target) => {
    const frames: TextGeometryFrame[] = [];
    window.__textGeometry = frames;
    window.__textGeometryActive = true;
    const started = performance.now();

    const scaleDeviation = (element: Element | null) => {
      if (!element) return 0;
      const transform = getComputedStyle(element).transform;
      if (!transform || transform === 'none') return 0;
      const matrix = new DOMMatrixReadOnly(transform);
      return Math.max(Math.abs(matrix.a - 1), Math.abs(matrix.d - 1));
    };

    const sample = () => {
      if (!window.__textGeometryActive) return;
      frames.push({
        ms: performance.now() - started,
        nodes: [...document.querySelectorAll<HTMLElement>(target)].map((node) => {
          const style = getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          const hidden = style.visibility === 'hidden' || style.display === 'none';
          const ancestor =
            node.parentElement?.closest('[data-layout], [data-layout-id]') ?? null;
          return {
            text: node.textContent ?? '',
            width: hidden ? 0 : rect.width,
            height: hidden ? 0 : rect.height,
            layoutWidth: node.offsetWidth,
            layoutHeight: node.offsetHeight,
            parentScale: hidden ? 0 : scaleDeviation(ancestor),
          };
        }),
      });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, selector);
}

/** Stops `startTextGeometrySample()` and returns every frame it took. */
export async function stopTextGeometrySample(page: Page): Promise<TextGeometryFrame[]> {
  return page.evaluate(() => {
    window.__textGeometryActive = false;
    return window.__textGeometry ?? [];
  });
}
