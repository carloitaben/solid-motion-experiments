import { render } from '@solidjs/testing-library';
import { visualElementStore, motionValue } from 'motion';
import { createSignal, flush } from 'solid-js';
import { describe, expect, test, vi } from 'vitest';

import { animateFeature, createMotionElement } from './motion';

// Deliberately no `vi.mock('motion')`: this file runs the real engine, which is
// the only way to see what an element's own renderer does with `initial`. The
// mocked harness covers the component contract; this covers the frame.
const Box = createMotionElement('div', [animateFeature]);

describe('initial and the element renderer', () => {
  test('seeds latestValues, and a later frame for another key keeps them', () => {
    const { container } = render(() => <Box initial={{ x: -12, scale: 0.9 }} />);
    const element = container.firstElementChild as HTMLElement;

    // The inline style is the server/first-paint frame.
    expect(element.style.transform).toBe('translateX(-12px) scale(0.9)');

    const visualElement = visualElementStore.get(element);
    expect(visualElement).toBeDefined();
    // The renderer starts from the same values, not from an empty frame.
    expect(visualElement!.getStaticValue('x')).toBe(-12);
    expect(visualElement!.getStaticValue('scale')).toBe(0.9);

    // What a later animation of another key renders: buildHTMLStyles() rebuilds
    // the transform string out of latestValues, so `scale` — present only in
    // `initial` — is still in it rather than being dropped by the `x` frame.
    visualElement!.setStaticValue('x', 220);
    visualElement!.setStaticValue('opacity', 0.4);
    visualElement!.render();

    expect(element.style.transform).toBe('translateX(220px) scale(0.9)');
    expect(element.style.opacity).toBe('0.4');
  });

  test('initial={false} renders the animate target as the first frame', () => {
    const { container } = render(() => (
      <Box initial={false} animate={{ x: 100, opacity: 0.6 }} />
    ));
    const element = container.firstElementChild as HTMLElement;

    // The frame the first paint ships is the target, not motionless defaults.
    expect(element.style.transform).toBe('translateX(100px)');
    expect(element.style.opacity).toBe('0.6');

    const visualElement = visualElementStore.get(element)!;
    expect(visualElement.getStaticValue('x')).toBe(100);
    // No animation was started for the mount: an animated key would have a
    // MotionValue created for it, and the frame path writes static values.
    expect(visualElement.getValue('x')).toBeUndefined();
    expect(visualElement.getValue('opacity')).toBeUndefined();
  });

  test('initial={false} resolves a keyframe array to the frame it would have ended on', () => {
    const { container } = render(() => (
      <Box initial={false} animate={{ x: [0, 40, 120], opacity: [0.2, 0.6] }} />
    ));
    const element = container.firstElementChild as HTMLElement;
    const visualElement = visualElementStore.get(element)!;

    // A React motion component takes the last keyframe of a blocked mount
    // animation: the element starts where that animation would have ended, and
    // nothing springs out of the renderer's defaults on the first frame.
    expect(element.style.transform).toBe('translateX(120px)');
    expect(element.style.opacity).toBe('0.6');
    expect(visualElement.getStaticValue('x')).toBe(120);
    expect(visualElement.getStaticValue('opacity')).toBe(0.6);
    expect(visualElement.getValue('x')).toBeUndefined();
    expect(visualElement.getValue('opacity')).toBeUndefined();

    // The resolved frame seeds the renderer, so a later frame for another key
    // rebuilds the transform from it instead of dropping it.
    visualElement.setStaticValue('scale', 0.9);
    visualElement.render();
    expect(element.style.transform).toBe('translateX(120px) scale(0.9)');
  });

  test('initial={false} resolves a keyframe array of strings the same way', () => {
    const { container } = render(() => (
      <Box initial={false} animate={{ x: ['0%', '100%'] }} />
    ));
    const element = container.firstElementChild as HTMLElement;

    // The last keyframe is the frame whatever its unit, so the first paint
    // already sits where the blocked animation would have ended.
    expect(element.style.transform).toBe('translateX(100%)');
    expect(visualElementStore.get(element)!.getValue('x')).toBeUndefined();
  });

  test('initial={false} keeps a value the route owns in step with the frame', () => {
    const x = motionValue(0);
    const { container } = render(() => (
      <Box initial={false} values={{ x }} animate={{ x: 40 }} />
    ));

    // The frame is written on the value, so a readout that subscribes to it
    // shows the frame the element is rendering.
    expect(x.get()).toBe(40);
    expect((container.firstElementChild as HTMLElement).style.transform).toBe(
      'translateX(40px)',
    );
  });

  test('a later target after initial={false} still animates', () => {
    const [target, setTarget] = createSignal(40);
    const { container } = render(() => <Box initial={false} animate={{ x: target() }} />);
    const element = container.firstElementChild as HTMLElement;
    const visualElement = visualElementStore.get(element)!;

    setTarget(200);
    flush();

    // The mount was skipped, not animation itself: the renderer now has a
    // MotionValue for `x`, which is what an animation runs on.
    expect(visualElement.getValue('x')).toBeDefined();
  });

  test('a string style cannot rewrite the transform the renderer owns', () => {
    const [style, setStyle] = createSignal('opacity: 0.85');
    const { container } = render(() => <Box style={style()} initial={{ y: 5 }} />);
    const element = container.firstElementChild as HTMLElement;

    expect(element.style.opacity).toBe('0.85');
    expect(element.style.transform).toBe('translateY(5px)');

    // A frame the renderer writes, as an animation of `x` would.
    const visualElement = visualElementStore.get(element)!;
    visualElement.setStaticValue('x', 42);
    visualElement.render();
    expect(element.style.transform).toBe('translateX(42px) translateY(5px)');

    // A string style is a cssText, so Solid would assign all of it at once and
    // drop the animated transform. The mount frame is kept instead, and the
    // change is reported.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setStyle('opacity: 0.4');
    flush();

    expect(element.style.opacity).toBe('0.85');
    expect(element.style.transform).toBe('translateX(42px) translateY(5px)');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  test('an object style that turns into a string cannot rewrite the transform', () => {
    const [style, setStyle] = createSignal<string | Record<string, string>>({
      opacity: '0.85',
    });
    const { container } = render(() => <Box style={style()} initial={{ y: 5 }} />);
    const element = container.firstElementChild as HTMLElement;
    const visualElement = visualElementStore.get(element)!;

    visualElement.setStaticValue('x', 42);
    visualElement.render();
    expect(element.style.transform).toBe('translateX(42px) translateY(5px)');

    // The style's shape is fixed at mount: an object stays an object. Solid
    // would otherwise assign the cssText in one write, replacing the transform.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setStyle('opacity: 0.2');
    flush();

    expect(element.style.opacity).toBe('0.85');
    expect(element.style.transform).toBe('translateX(42px) translateY(5px)');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  test('a style that starts absent and turns into a string is not applied', () => {
    const [style, setStyle] = createSignal<string | undefined>();
    const { container } = render(() => <Box style={style()} initial={{ y: 5 }} />);
    const element = container.firstElementChild as HTMLElement;
    const visualElement = visualElementStore.get(element)!;

    visualElement.setStaticValue('x', 42);
    visualElement.render();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setStyle('opacity: 0.2;transform:translateX(0px)');
    flush();

    // Nothing was written: not the cssText, and not the whole style attribute
    // Solid assigns for it, so the animated frame is still the one on screen.
    expect(element.style.opacity).toBe('');
    expect(element.style.transform).toBe('translateX(42px) translateY(5px)');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  test('a string style that turns into an object keeps the cssText it shipped', () => {
    const [style, setStyle] = createSignal<string | Record<string, string>>('opacity: 0.85');
    const { container } = render(() => <Box style={style()} initial={{ y: 5 }} />);
    const element = container.firstElementChild as HTMLElement;
    const shipped = element.getAttribute('style');

    // A string is never re-read, not even as an object, because Solid would
    // write the object's keys over a cssText it cannot see the rest of.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setStyle({ opacity: '0.2' });
    flush();

    expect(element.getAttribute('style')).toBe(shipped);
    expect(element.style.opacity).toBe('0.85');
    expect(element.style.transform).toBe('translateY(5px)');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  test('an object style is reactive and leaves the transform alone', () => {
    const [style, setStyle] = createSignal({ opacity: '0.85' });
    const { container } = render(() => <Box style={style()} initial={{ y: 5 }} />);
    const element = container.firstElementChild as HTMLElement;

    const visualElement = visualElementStore.get(element)!;
    visualElement.setStaticValue('x', 42);
    visualElement.render();

    setStyle({ opacity: '0.4' });
    flush();

    expect(element.style.opacity).toBe('0.4');
    expect(element.style.transform).toBe('translateX(42px) translateY(5px)');
  });
});
