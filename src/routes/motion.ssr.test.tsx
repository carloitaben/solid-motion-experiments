import { isServer, renderToString } from '@solidjs/web';
import { motionValue } from 'motion';
import { createRoot } from 'solid-js';
import { describe, expect, test } from 'vitest';

import MotionApiLab, {
  animateFeature,
  createLayoutBoundary,
  createMotionElement,
} from './motion';

// This file runs only in the `server` Vitest project (see vite.config.ts):
// Node environment and the server build of @solidjs/web, so `renderToString()`
// is the real one and `isServer` is true. Nothing is mocked. What is asserted
// here is the markup the route ships before any client code, ref or Motion
// renderer runs — the frame the browser paints first.
//
// Node has no DOMParser, and the server project deliberately has no jsdom
// dependency, so the helpers below read tags out of the string directly.
const tags = (html: string, pattern: RegExp) => [...html.matchAll(pattern)].map(([tag]) => tag);

const styleOf = (tag: string | undefined) => tag?.match(/\sstyle="([^"]*)"/)?.[1];

const renderRoute = () => renderToString(() => <MotionApiLab />);

const Box = createMotionElement('div', [animateFeature]);

describe('the motion route on the server', () => {
  test('this project runs the server build of @solidjs/web', () => {
    // The same import in the `client` project resolves to the browser build,
    // where this is false. It is what makes `renderToString()` real here
    // rather than the client stub.
    expect(isServer).toBe(true);
  });

  test('initial frames are inline styles in the server markup', () => {
    const html = renderRoute();
    const probes = tags(html, /<div\b[^>]*\bdata-ssr-probe\b[^>]*>/g);

    expect(probes).toHaveLength(3);
    // The `initial` object is the first paint: the element does not wait for
    // the client to create its renderer before it has a transform.
    expect(styleOf(probes[0])).toContain('opacity:0.5');
    expect(styleOf(probes[0])).toContain('transform:translateX(-12px)');

    // `initial={false}` ships its first `animate` target, and the keyframe
    // array resolves to its last frame — where the skipped animation would
    // have ended — not to its first one.
    expect(styleOf(probes[1])).toBe('transform:translateX(24px)');

    // The values-only probe ships the frame its borrowed value is on, with no
    // renderer and no mount frame to write it.
    expect(styleOf(probes[2])).toBe('transform:translateX(40px)');
  });

  test('a nonzero borrowed value is the first frame with no animate target', () => {
    const x = motionValue(40);
    const html = renderToString(() => <Box values={{ x }} />);
    const element = tags(html, /<div\b[^>]*>/g)[0];

    // There is no renderer on the server and mount renders nothing on the
    // client, so the frame has to come from the value itself. Before this,
    // the response shipped no transform and the first client paint started
    // from the renderer's default until something animated it.
    expect(styleOf(element)).toBe('transform:translateX(40px)');
    // Reading the value for the frame is not a write: the server never owns it.
    expect(x.get()).toBe(40);
    expect(html).not.toMatch(/\svalues=/i);
    x.destroy();
  });

  test('initial wins over a borrowed value; the animate target wins under initial={false}', () => {
    const x = motionValue(40);
    const y = motionValue(20);
    const html = renderToString(() => (
      <>
        <Box values={{ x }} initial={{ x: 10 }} />
        <Box values={{ y }} initial={false} animate={{ y: 100 }} />
      </>
    ));
    const [withInitial, instant] = tags(html, /<div\b[^>]*>/g);

    expect(styleOf(withInitial)).toBe('transform:translateX(10px)');
    expect(styleOf(instant)).toBe('transform:translateY(100px)');
    // The precedence is applied to the frame only; the borrowed values keep
    // the frame their owner left them on during SSR.
    expect(x.get()).toBe(40);
    expect(y.get()).toBe(20);
    x.destroy();
    y.destroy();
  });

  test('initial={false} resolves keyframe arrays from the real engine on the server', () => {
    const html = renderToString(() => (
      <Box initial={false} animate={{ x: ['0%', '100%'], opacity: [0.2, 0.6] }} />
    ));
    const element = tags(html, /<div\b[^>]*>/g)[0];

    // The last frame of each array, serialised by Motion's own style builder:
    // strings keep their unit and the numeric opacity is the target's end.
    expect(styleOf(element)).toContain('transform:translateX(100%)');
    expect(styleOf(element)).toContain('opacity:0.6');
  });

  test('layout renders data-layout attributes and nothing else', () => {
    const html = renderRoute();
    // Four tiles, each tile's position-only label, the ref scope and its
    // label, and the two radius heroes with two labels each. Prose in the page
    // mentions data-layout too, so match attributes inside tags only.
    const layoutTags = tags(html, /<[a-z][^>]*\sdata-layout(?=[\s=>])[^>]*>/gi);

    expect(layoutTags).toHaveLength(16);
    expect(layoutTags.filter((tag) => tag.includes('class="motion-api-lab-tile"'))).toHaveLength(
      4,
    );
    // Every text node inside a layout node ships as its own position-only node,
    // from the server markup on: the counter-scale is part of the first frame
    // the client hydrates, not something added after mount. `motion.span` is
    // the factory's layout-only element, so all nine labels are spans.
    const labelTags = layoutTags.filter((tag) => /^<span\b/i.test(tag));
    expect(labelTags).toHaveLength(9);
    expect(labelTags.every((tag) => tag.includes('data-layout="position"'))).toBe(true);
    expect(html).not.toContain('data-layout-id=');
  });

  test('the helper preserves layout attribute values in server markup', () => {
    const html = renderToString(() => (
      <>
        <Box layout />
        <Box layout="position" layoutId="hero" />
      </>
    ));
    const [bare, positioned] = tags(html, /<div\b[^>]*>/g);

    expect(bare).toMatch(/\sdata-layout(?=[\s=>])/);
    expect(positioned).toContain('data-layout="position"');
    expect(positioned).toContain('data-layout-id="hero"');
    // `layout` itself is reserved and stripped; only the data attribute ships.
    expect(bare).not.toMatch(/\slayout(?=[\s=>])/i);
    expect(positioned).not.toMatch(/\slayout(?=[\s=>])/i);
  });

  test('no renderer or ref runs before the first paint', () => {
    const html = renderRoute();

    // Animation targets are not written on the server: `bind()` only runs in
    // the client ref, so the gesture button ships without a style attribute
    // and the first paint is the static frame only. The puck does ship one,
    // because its borrowed value is at 0 and that frame is equivalent to no
    // transform (`transform:none`); it is the value's frame, not an animation.
    const puck = tags(html, /<div\b[^>]*class="motion-api-lab-puck"[^>]*>/g)[0];
    const press = tags(html, /<button\b[^>]*class="motion-api-lab-press"[^>]*>/g)[0];
    expect(puck).toBeDefined();
    expect(press).toBeDefined();
    expect(styleOf(puck)).toBe('transform:none');
    expect(press).not.toMatch(/\sstyle=/);

    // The refs experiment reports what the probe saw when it ran; on the
    // server it has not run, and rendering must not pretend otherwise.
    expect(html).not.toContain('probe calls');

    // The values record handed to the puck's renderer is not a DOM prop, and
    // no other reserved prop may be serialised into the response either.
    expect(html).not.toMatch(
      /\s(?:animate|initial|transition|layout|layoutId|whileHover|whilePress|values|ref)=/i,
    );
  });

  test('reserved motion props never reach server markup as attributes', () => {
    // A JS caller can hand a reserved prop to an element that has no feature
    // for it. Server rendering serialises the spread as attributes, so a leak
    // here would be visible in the response rather than only in the DOM.
    const unsupported = { whilePress: { scale: 0.9 } } as Record<string, unknown>;
    const html = renderToString(() => (
      <Box initial={{ y: 5 }} animate={{ x: 10 }} {...unsupported} />
    ));
    const element = tags(html, /<div\b[^>]*>/g)[0];

    expect(element).toMatch(/\sstyle="transform:translateY\(5px\)"/);
    expect(element).not.toMatch(
      /\s(?:animate|initial|transition|layout|layoutId|whileHover|whilePress|values|ref)=/i,
    );
    expect(html).not.toContain('[object Object]');
  });

  test('a string style is merged with the initial frame once', () => {
    const cssText = 'opacity: 0.7';
    const html = renderToString(() => (
      <Box style={cssText} initial={{ x: '50%', rotate: 45 }} />
    ));
    const element = tags(html, /<div\b[^>]*>/g)[0];

    // The cssText is kept as written and the frame is appended, in the order
    // and units Motion's style builder produces. There is no second write on
    // the server to replace it.
    expect(styleOf(element)).toBe('opacity: 0.7;transform:translateX(50%) rotate(45deg)');
  });

  test('the layout boundary mutates without measuring on the server', () => {
    const runs: unknown[] = [];
    const failures: unknown[] = [];
    let mutated = false;

    createRoot((dispose) => {
      const boundary = createLayoutBoundary({
        onRun: (run) => runs.push(run),
        onError: (failure) => failures.push(failure),
      });

      // No ref has run, so there is no scope to snapshot or animate. The
      // mutation is still Solid's and must run.
      expect(boundary.element()).toBeUndefined();
      boundary.update(() => {
        mutated = true;
      }, 'Server → update');

      dispose();
    });

    expect(mutated).toBe(true);
    expect(runs).toHaveLength(0);
    expect(failures).toHaveLength(0);
  });
});
