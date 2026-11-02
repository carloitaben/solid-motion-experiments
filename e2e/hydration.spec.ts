import { expect, test } from '@playwright/test';

import {
  collectProblems,
  expectNoBrowserProblems,
  holdScriptsUntilServerPaint,
  installHydrationRecorder,
  isProjection,
  readRecorder,
  readStyleWrites,
  recordStyleWrites,
  refrowGeometry,
  refsReport,
  trackedServerPaint,
} from './support';

// Runs against the Vite dev server on port 4399 (see playwright.config.ts):
// streaming SSR and the dev build of solid-js, which reports hydration
// mismatches that a production build strips.
const ROUTE = '/motion';

// What the server writes for the three [data-ssr-probe] boxes in
// src/routes/motion.tsx: `initial={{ x: -12, opacity: 0.5 }}`,
// `initial={false}` with `animate={{ x: [0, 24] }}`, whose keyframe array
// resolves to its last frame before the markup is written, and a borrowed
// `values={{ x }}` with no animate target.
const INITIAL_FRAME = {
  inlineTransform: 'translateX(-12px)',
  inlineOpacity: '0.5',
  transform: 'matrix(1, 0, 0, 1, -12, 0)',
  opacity: '0.5',
};
const INSTANT_FRAME = {
  inlineTransform: 'translateX(24px)',
  inlineOpacity: '',
  transform: 'matrix(1, 0, 0, 1, 24, 0)',
  opacity: '1',
};
const BORROWED_FRAME = {
  inlineTransform: 'translateX(40px)',
  inlineOpacity: '',
  transform: 'matrix(1, 0, 0, 1, 40, 0)',
  opacity: '1',
};
// `initial` only: the SSR inline frame; `initial={false}`: the last keyframe,
// shipped instead of a mount animation; values only: the frame the borrowed
// MotionValue is already on.
const SSR_INLINE = [
  { transform: 'translateX(-12px)', opacity: '0.5' },
  { transform: 'translateX(24px)', opacity: '' },
  { transform: 'translateX(40px)', opacity: '' },
];

test.describe('server paint without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('the response and the no-JS paint carry every probe frame', async ({ page, request }) => {
    const response = await request.get(ROUTE);
    expect(response.ok()).toBe(true);
    const html = await response.text();
    const tags = html.match(/<div[^>]*data-ssr-probe[^>]*>/g) ?? [];
    expect(tags).toHaveLength(3);
    expect(tags[0]).toContain('translateX(-12px)');
    expect(tags[0]).toContain('opacity:0.5');
    expect(tags[1]).toContain('translateX(24px)');
    expect(tags[2]).toContain('translateX(40px)');

    await page.goto(ROUTE);
    const probes = page.locator('[data-ssr-probe]');
    await expect(probes).toHaveCount(3);

    // Inline style is the server frame; computed style is the paint it produces.
    const painted = await probes.evaluateAll((elements) =>
      elements.map((element) => {
        const node = element as HTMLElement;
        const computed = getComputedStyle(node);
        return {
          inlineTransform: node.style.transform,
          inlineOpacity: node.style.opacity,
          transform: computed.transform,
          opacity: computed.opacity,
        };
      }),
    );
    expect(painted).toEqual([INITIAL_FRAME, INSTANT_FRAME, BORROWED_FRAME]);

    // Nothing ran: the refs report is client-only and is still empty.
    await expect(refsReport(page)).toHaveText('');

    const boxes = await refrowGeometry(page);
    expect(boxes).toHaveLength(3);
    for (const [width, height] of boxes) {
      expect(width).toBeGreaterThan(0);
      expect(height).toBeGreaterThan(0);
    }
    // A two-column grid that wrapped: the two initial boxes share a row and
    // equal columns, the third starts a new row in the first column.
    expect(boxes[0][0]).toBe(boxes[1][0]);
    expect(boxes[0][3]).toBe(boxes[1][3]);
    expect(boxes[2][3]).toBeGreaterThan(boxes[0][3]);
    expect(boxes[2][2]).toBe(boxes[0][2]);
  });
});

test('hydration adopts the server nodes and keeps their first frames', async ({
  page,
  browser,
  baseURL,
}) => {
  const problems = collectProblems(page);
  await page.addInitScript(installHydrationRecorder);
  // Hold module scripts until the recorder has frozen a fully parsed paint of
  // the server markup. Everything below can then call that paint "server
  // paint" on evidence instead of on the assumption that hydration is slow.
  await holdScriptsUntilServerPaint(page);
  await page.goto(ROUTE);

  // The refs report is client-only: it is the route's own proof that the tree
  // hydrated and that the probe ref ran on the node the scope received.
  await expect(refsReport(page)).toContainText('probe calls: 1');
  await expect(refsReport(page)).toContainText('same element as the scope: yes');

  // Wait for a frame sampled after that point, so the comparison covers
  // hydration and not only the parse-time frames.
  await page.waitForFunction(() =>
    window.__hydrationRecorder.frames.some((frame) => frame.hydrated),
  );

  const state = await readRecorder(page);
  expect(state.frames.length).toBeGreaterThan(0);
  expect(state.frames.some((frame) => !frame.hydrated)).toBe(true);
  expect(state.frames.some((frame) => frame.hydrated)).toBe(true);

  // Every probe was first seen while the document was still parsing, i.e. as
  // server markup, before the client report existed.
  const probes = state.marks.filter((mark) => mark.probe);
  expect(probes).toHaveLength(3);
  expect(probes.map((mark) => ({ transform: mark.inlineTransform, opacity: mark.inlineOpacity })))
    .toEqual(SSR_INLINE);

  // Every tracked node — the layout nodes included, not only the probes — was
  // first seen as unhydrated server markup while the document parsed. The
  // script gate is what makes the readyState claim deterministic.
  expect(state.marks.every((mark) => mark.hydrated === false)).toBe(true);
  expect(state.marks.every((mark) => mark.readyState === 'loading')).toBe(true);

  // Hydration must not have replaced any node it found: every element the
  // recorder marked is still in the document, and the client added none beyond
  // what the server shipped.
  expect(state.marks.length).toBe(
    await page.locator('[data-layout], [data-ssr-probe]').count(),
  );
  // Layout nodes are part of the same observation, not only the probes.
  expect(state.marks.filter((mark) => !mark.probe).length).toBeGreaterThan(0);

  // Every frame from the first paint through hydration renders each node at the
  // same box, inline transform, computed transform and opacity. Frames sampled
  // before the node was parsed do not count for it (streaming SSR may paint the
  // shell first). Each node also has to appear on both sides of hydration:
  // otherwise the "nothing changed" claim below only covers one paint, and a
  // node whose server frame was never sampled would pass vacuously.
  for (const mark of state.marks) {
    const samples = state.frames.flatMap((frame) => {
      const node = frame.nodes.find((candidate) => candidate.id === mark.id);
      return node ? [{ frame, node }] : [];
    });
    expect(samples.length).toBeGreaterThan(0);
    expect(
      samples.some(({ frame }) => !frame.hydrated),
      `node ${mark.id} (${mark.tag}) has no unhydrated frame: the server paint was not captured`,
    ).toBe(true);
    expect(
      samples.some(({ frame }) => frame.hydrated),
      `node ${mark.id} (${mark.tag}) has no hydrated frame`,
    ).toBe(true);
    const seen = new Set(samples.map(({ node }) => JSON.stringify(node)));
    expect(
      seen.size,
      `node ${mark.id} (${mark.tag}) changed during hydration: ${[...seen].join(' -> ')}`,
    ).toBe(1);
  }

  // The probes specifically still carry the server's frames, the borrowed
  // value's frame included, and `initial={false}` never replays the mount
  // animation it skipped.
  for (const [index, expected] of [INITIAL_FRAME, INSTANT_FRAME, BORROWED_FRAME].entries()) {
    const samples = state.frames.flatMap((frame) => {
      const node = frame.nodes.find((candidate) => candidate.id === probes[index].id);
      return node
        ? [
            JSON.stringify({
              inlineTransform: node.inlineTransform,
              inlineOpacity: node.inlineOpacity,
              transform: node.transform,
              opacity: node.opacity,
            }),
          ]
        : [];
    });
    expect(samples.length).toBeGreaterThan(0);
    const seen = [...new Set(samples)];
    expect(seen).toHaveLength(1);
    expect(JSON.parse(seen[0])).toEqual(expected);
  }

  // Hydration did not rewrite the probe frame. A rewrite that writes the same
  // value back is tolerated; any visible change is not.
  for (const mutation of state.mutations) {
    expect(
      mutation.now,
      `probe style rewritten from ${mutation.old} to ${mutation.now}`,
    ).toBe(mutation.old);
  }

  // The refrow laid out identically on the server and after hydration. Frames
  // before the row was parsed are skipped.
  const refrowFrames = state.frames.filter((frame) => frame.refrow.length > 0);
  expect(refrowFrames.length).toBeGreaterThan(0);
  const geometries = new Set(refrowFrames.map((frame) => JSON.stringify(frame.refrow)));
  expect(geometries.size).toBe(1);
  const hydratedBoxes = refrowFrames[0].refrow;
  expect(hydratedBoxes).toHaveLength(3);

  // The frozen server paint: one entry per tracked node, sampled after the
  // document finished parsing and before any client script ran.
  const serverPaint = state.serverPaint;
  if (!serverPaint) throw new Error('the recorder never froze a server paint');
  expect(serverPaint).toHaveLength(state.marks.length);
  expect(serverPaint.every((node) => node !== undefined)).toBe(true);

  // Compare against a page that cannot hydrate. That page is the oracle: if
  // the server paint and the no-JS paint differ, the difference is a real
  // server/client mismatch, not a frame that happened to be sampled late.
  const noJsContext = await browser.newContext({
    javaScriptEnabled: false,
    baseURL,
    viewport: page.viewportSize() ?? undefined,
  });
  const noJsPage = await noJsContext.newPage();
  await noJsPage.goto(ROUTE);
  const ssrBoxes = await refrowGeometry(noJsPage);
  const ssrPaint = await trackedServerPaint(noJsPage);
  await noJsContext.close();
  expect(hydratedBoxes).toEqual(ssrBoxes);
  expect(serverPaint).toEqual(ssrPaint);

  expectNoBrowserProblems(problems);
});

// Scope: the check above and this one are hydration checks, not an animation
// suite. They assert that the server paint survives hydration and that the
// layout boundary still works on the adopted nodes. Motion's spring curves,
// duration and timing are not asserted anywhere here or in the jsdom harness:
// neither has a real animation clock. This only distinguishes a live Motion
// boundary from a Solid-only state change.
test('the hydrated layout boundary still commits and projects the change', async ({ page }) => {
  const problems = collectProblems(page);
  await page.goto(ROUTE);
  await expect(refsReport(page)).toContainText('probe calls: 1');

  const box = page.locator('.motion-api-lab-refbox');
  const before = await box.evaluate((element) => (element as HTMLElement).offsetHeight);
  await recordStyleWrites(page, '.motion-api-lab-refbox');

  await page.getByRole('button', { name: 'Widen' }).click();
  await expect(box).toHaveAttribute('data-wide', '');
  await expect(page.getByRole('button', { name: 'Narrow' })).toBeVisible();

  // The run report is Motion's own account of the update: `onRun` only fires
  // after the builder resolved against the hydrated scope. `data-wide` above
  // only proves Solid committed the mutation.
  const run = page.locator('.motion-api-lab-log li', { hasText: 'Refs → widen' });
  await expect(run).toBeVisible();
  await expect(run).toContainText('in flight at update: 0');
  await expect(run).toContainText(/finalised in \d+(?:\.\d+)?ms/);

  // The toggle changes the box's padding; Motion animates it, so poll for the
  // committed layout instead of sleeping.
  await expect
    .poll(() => box.evaluate((element) => (element as HTMLElement).offsetHeight))
    .toBeGreaterThan(before);

  // Sampling started before the click, so the settled value is ordered after
  // the frames it settles from rather than raced at the end.
  await expect
    .poll(async () => (await readStyleWrites(page)).at(-1)?.transform ?? '')
    .toMatch(/^(?:none|)$/);

  // Projection is what separates a Motion layout run from the CSS change: the
  // element is given a transform that restores its old box and springs back to
  // identity. Assert that numerically, through DOMMatrix, rather than by the
  // shape of the string: `isProjection` rejects identity written as
  // `translate3d(0px, 0px, 0px)` or `scale(1, 1)`.
  const writes = await readStyleWrites(page);
  const projected = writes.filter((write) => isProjection(write.matrix));
  expect(projected.length).toBeGreaterThan(0);
  // The last sample is the settled identity; the projection has to be ordered
  // before it, or "settles back to none" would describe a different sample.
  const settled = writes.length - 1;
  expect(isProjection(writes[settled].matrix)).toBe(false);
  expect(writes.findLastIndex((write) => isProjection(write.matrix))).toBeLessThan(settled);

  expectNoBrowserProblems(problems);
});
