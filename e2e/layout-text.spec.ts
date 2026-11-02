import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  refsReport,
  startTextGeometrySample,
  stopTextGeometrySample,
  type TextGeometryFrame,
} from './support';

// The nested position-only correction, measured in a real browser. A layout
// node animates size with a scale transform, so text painted straight into its
// box is stretched by that scale. Motion counter-scales only descendants that
// are layout nodes of their own (`data-layout="position"`), which keeps a text
// node's painted box equal to its layout box while the ancestor is projected.
//
// Every assertion below samples `getBoundingClientRect()` (painted, after every
// ancestor transform) against `offsetWidth`/`offsetHeight` (layout, before
// them) once per frame, across the whole run. A ratio that stays at 1 is the
// property; `parentScale` proves at least one frame really was projected, so a
// missing animation cannot pass the check by leaving every box untransformed —
// and each label the branch renders has to be seen in one of those projected
// frames, not just while it sat still before the click.
const RATIO_TOLERANCE = 0.03;

// The scale deviation that counts as "this frame was projected". It is the
// same number `expectUnstretchedText()` uses, so the waits cannot treat a
// frame as projected that the assertions then call vacuous.
const PROJECTED_SCALE = 0.02;

// Consecutive quiet frames that mean the run has finished: ~100ms at 60fps, so
// one frame passing through identity mid-spring cannot end the trace.
const SETTLED_FRAMES = 6;

const FRAME_TIMEOUT_MS = 15_000;

type Sample = {
  ms: number;
  text: string;
  widthRatio: number;
  heightRatio: number;
  parentScale: number;
};

const samplesOf = (frames: TextGeometryFrame[]): Sample[] =>
  frames.flatMap((frame) =>
    frame.nodes
      .filter(
        (node) =>
          node.width > 0 &&
          node.height > 0 &&
          node.layoutWidth > 0 &&
          node.layoutHeight > 0,
      )
      .map((node) => ({
        ms: frame.ms,
        text: node.text,
        widthRatio: node.width / node.layoutWidth,
        heightRatio: node.height / node.layoutHeight,
        parentScale: node.parentScale,
      })),
  );

const isProjected = (sample: Sample) => sample.parentScale > PROJECTED_SCALE;

const expectUnstretchedText = (
  frames: TextGeometryFrame[],
  label: string,
  expectedLabels: readonly string[],
) => {
  const samples = samplesOf(frames);
  expect(samples.length, `${label}: no visible text node was sampled`).toBeGreaterThan(0);

  // A frame with a projected ancestor is what would stretch an uncorrected
  // text node. Without one the whole comparison is vacuous.
  expect(samples.some(isProjected), `${label}: no frame had a projected layout ancestor`).toBe(
    true,
  );

  // Being on screen at all proves nothing: a label sampled only before the
  // first click, or after the run settled, was never painted into a scaled
  // box. Every label the run renders has to appear in a projected frame.
  for (const text of expectedLabels) {
    expect(
      samples.some((sample) => sample.text === text && isProjected(sample)),
      `${label}: "${text}" was never sampled while its layout ancestor was projected`,
    ).toBe(true);
  }

  const worst = samples.reduce((most, sample) =>
    Math.max(Math.abs(sample.widthRatio - 1), Math.abs(sample.heightRatio - 1)) >
    Math.max(Math.abs(most.widthRatio - 1), Math.abs(most.heightRatio - 1))
      ? sample
      : most,
  );
  expect(
    Math.max(Math.abs(worst.widthRatio - 1), Math.abs(worst.heightRatio - 1)),
    `${label}: text "${worst.text}" at ${worst.ms}ms painted ${worst.widthRatio.toFixed(3)}×` +
      `${worst.heightRatio.toFixed(3)} its layout box`,
  ).toBeLessThan(RATIO_TOLERANCE);
};

// Start the sampler before the first click and stop it once the last run has
// settled (see `waitForSettledFrames`), so both the run and the interruption
// that replaces it are covered by the same trace.
async function sampleRun(
  page: Page,
  selector: string,
  action: () => Promise<void>,
): Promise<TextGeometryFrame[]> {
  await startTextGeometrySample(page, selector);
  await action();
  return stopTextGeometrySample(page);
}

// Wait until the sampler has a frame whose layout ancestor is projected, i.e.
// Motion is really mid-run. Polling the trace is what keeps the interruption
// honest without a guessed sleep: the second click cannot land before the
// first run was projected, and it does not wait longer than that run lasts.
async function waitForProjectedFrame(page: Page) {
  await page.waitForFunction(
    (threshold) =>
      (window.__textGeometry?.at(-1)?.nodes ?? []).some(
        (node) => node.parentScale > threshold,
      ),
    PROJECTED_SCALE,
    { timeout: FRAME_TIMEOUT_MS },
  );
}

// Wait for the trace to end on quiet frames. Motion leaves an identity
// transform between runs, so this is the settle signal the fixed timeouts were
// standing in for.
async function waitForSettledFrames(page: Page) {
  await page.waitForFunction(
    ({ threshold, quiet }) => {
      const frames = window.__textGeometry ?? [];
      return (
        frames.length >= quiet &&
        frames
          .slice(-quiet)
          .every((frame) => frame.nodes.every((node) => node.parentScale <= threshold))
      );
    },
    { threshold: PROJECTED_SCALE, quiet: SETTLED_FRAMES },
    { timeout: FRAME_TIMEOUT_MS },
  );
}

// One run, interrupted once it has visibly started: click, wait for the
// projection, click again, then wait for the trace to settle.
async function interruptRun(page: Page, first: Locator, second: Locator) {
  await first.click();
  await waitForProjectedFrame(page);
  await second.click();
  // One more projected frame after the second click: the update is accepted
  // from the projection the first run had reached, so the settle check below
  // cannot pass on the gap before Motion writes its first frame.
  await waitForProjectedFrame(page);
  await waitForSettledFrames(page);
}

test.describe('nested position-only layout nodes', () => {
  test('the layout toggle keeps tile labels unscaled through an interruption', async ({
    page,
  }) => {
    await page.goto('/');

    const frames = await sampleRun(
      page,
      '.motion-lab-tile > [data-layout="position"]',
      () =>
        interruptRun(
          page,
          page.getByRole('button', { name: 'Switch to grid' }),
          page.getByRole('button', { name: 'Switch to row' }),
        ),
    );

    const labels = ['one', 'two', 'three', 'four'];
    expect(new Set(samplesOf(frames).map((sample) => sample.text))).toEqual(new Set(labels));
    expectUnstretchedText(frames, 'layout toggle', labels);
  });

  test('the shared hero keeps both labels unscaled through an interrupted swap', async ({
    page,
  }) => {
    await page.goto('/');

    const frames = await sampleRun(
      page,
      '.motion-lab-hero > [data-layout="position"]',
      () =>
        interruptRun(
          page,
          page.getByRole('button', { name: 'Expand' }),
          page.getByRole('button', { name: 'Collapse' }),
        ),
    );

    // Each branch brings its own caption. "Hero" is in both; the expanded
    // caption is on screen while the expand run is projected, and the collapsed
    // one while the collapse run that interrupts it is projected.
    const labels = ['Hero', 'shared element', 'shared element, expanded'];
    const sampled = new Set(samplesOf(frames).map((sample) => sample.text));
    for (const text of labels) expect(sampled).toContain(text);
    expectUnstretchedText(frames, 'shared hero', labels);
  });

  test('the motion tile row/grid toggle keeps every tile label unscaled through an interruption', async ({
    page,
  }) => {
    await page.goto('/motion');
    // Client-only report: hydration has run, so the controls are live.
    await expect(refsReport(page)).toContainText('probe calls: 1');

    const frames = await sampleRun(
      page,
      '.motion-api-lab-tile > [data-layout="position"]',
      () =>
        interruptRun(
          page,
          page.getByRole('button', { name: 'Switch to grid' }),
          page.getByRole('button', { name: 'Switch to row' }),
        ),
    );

    const labels = ['alpha', 'bravo', 'charlie', 'delta'];
    expect(new Set(samplesOf(frames).map((sample) => sample.text))).toEqual(new Set(labels));
    expectUnstretchedText(frames, 'motion tiles', labels);
  });

  test('the motion ref box and radius card keep their labels unscaled', async ({ page }) => {
    await page.goto('/motion');
    // Client-only report: hydration has run, so the controls are live.
    await expect(refsReport(page)).toContainText('probe calls: 1');

    const refbox = await sampleRun(
      page,
      '.motion-api-lab-refbox > [data-layout="position"]',
      () =>
        interruptRun(
          page,
          page.getByRole('button', { name: 'Widen' }),
          page.getByRole('button', { name: 'Narrow' }),
        ),
    );
    expectUnstretchedText(refbox, 'ref box', ['scope + probe']);

    // Both radius cards render the same hero markup. The sampler is scoped to
    // the card whose button is clicked: samples from the idle card would
    // otherwise stand in for the activated one with a `parentScale` of 0.
    const card = page.locator('.motion-api-lab-hero-card').first();
    const heroes = await sampleRun(
      page,
      '.motion-api-lab-hero-card:nth-of-type(1) .motion-api-lab-hero > [data-layout="position"]',
      () =>
        interruptRun(
          page,
          card.getByRole('button', { name: 'Expand' }),
          card.getByRole('button', { name: 'Collapse' }),
        ),
    );
    expectUnstretchedText(heroes, 'radius card', ['Hero', 'borderRadius: 9.6']);
  });

  test('the refs shared hero keeps both labels unscaled through an interrupted swap', async ({
    page,
  }) => {
    await page.goto('/refs');
    // The px card: the only one whose shared blend parses its radius as a
    // number, so its readout is also the handoff check below.
    const card = page.locator('.refs-hero-card').nth(1);

    const frames = await sampleRun(
      page,
      '.refs-hero-card:nth-of-type(2) .refs-hero > [data-layout="position"]',
      () =>
        interruptRun(
          page,
          card.getByRole('button', { name: 'Expand' }),
          card.getByRole('button', { name: 'Collapse' }),
        ),
    );

    expectUnstretchedText(frames, 'refs shared hero', ['Hero', 'borderRadius: 9.6']);

    // The shared-element handoff itself still works with the nested nodes: the
    // px card's radius readout proves the projection corrector ran during the
    // run (see the README's border-radius section).
    await expect(card.locator('.refs-readout')).toContainText('corrected: yes');
  });
});
