import { render } from '@solidjs/testing-library';
import { motionValue, visualElementStore, type MotionValue } from 'motion';
import { Show, createSignal, flush } from 'solid-js';
import { describe, expect, test, vi } from 'vitest';

import { createMotionValue } from '../lib/motion-value';
import { animateFeature, createMotionElement } from './motion';

// Deliberately no `vi.mock('motion')`: these tests run the real renderer. They
// are about who owns a value and who merely borrows it — the contract between
// `values={{ x }}` and `HTMLVisualElement` — so the assertions are about the
// real `getValue()`/subscription/unmount behaviour, not a stand-in.
//
// The value in the caller-owned cases is created outside any Solid owner, as a
// module-scope value or one handed in by a caller would be. That is what makes
// "the element did not destroy it" observable: disposal of the renderer must
// leave the value readable and its listeners intact.
const Box = createMotionElement('div', [animateFeature]);

describe('a caller-owned value', () => {
  test('is the value the element animates, and survives the element unmounting', () => {
    const x = motionValue(0);
    const changes = vi.fn();
    // Registered by the test, which owns the value; the element never sees this
    // listener and cannot remove it.
    x.on('change', changes);

    const { container, unmount } = render(() => (
      <Box initial={false} values={{ x }} animate={{ x: 40 }} />
    ));
    const element = container.firstElementChild as HTMLElement;
    const visualElement = visualElementStore.get(element)!;

    // The renderer took the value itself, not a copy of its current frame.
    expect(visualElement.getValue('x')).toBe(x);
    // The element's instant mount frame is written on the caller's value, which
    // is what a readout subscribed to it sees.
    expect(x.get()).toBe(40);

    const before = changes.mock.calls.length;
    x.set(55);
    // A change is the value's own event reaching the element's renderer.
    expect(visualElement.latestValues.x).toBe(55);
    expect(changes.mock.calls.length).toBe(before + 1);

    unmount();

    // Unmount removed the renderer's subscription only...
    x.set(70);
    expect(visualElement.latestValues.x).toBe(55);
    // ...so the value is alive for its owner: the test's listener still runs
    // and the last frame is readable.
    expect(changes.mock.calls.length).toBe(before + 2);
    expect(x.get()).toBe(70);

    x.destroy();
  });

  test('can be rebound to the next element after the first one unmounts', () => {
    const x = motionValue(0);
    const [show, setShow] = createSignal(true);

    const Harness = () => (
      <Box initial={false} values={{ x }} animate={{ x: 40 }} />
    );

    const { container } = render(() => (
      <Show when={show()} fallback={<Harness />}>
        <Harness />
      </Show>
    ));
    const first = container.firstElementChild as HTMLElement;

    // A branch swap is a new element, and the same caller-owned value binds to
    // it: the value is not tied to the renderer that borrowed it first.
    setShow(false);
    flush();

    const second = container.firstElementChild as HTMLElement;
    expect(second).not.toBe(first);
    expect(visualElementStore.get(second)!.getValue('x')).toBe(x);
    expect(x.get()).toBe(40);

    x.destroy();
  });
});

describe('the first paint of a borrowed value', () => {
  test('a nonzero value with no animate target is the first frame', () => {
    const x = motionValue(40);
    const { container } = render(() => <Box values={{ x }} />);
    const element = container.firstElementChild as HTMLElement;
    const visualElement = visualElementStore.get(element)!;

    // The element has no `initial` and no `animate`, so the only frame it can
    // paint is the one the borrowed value is already rendering. Mount renders
    // nothing on its own, which is why this has to be seeded before mount.
    expect(element.style.transform).toBe('translateX(40px)');
    expect(visualElement.getValue('x')).toBe(x);
    expect(visualElement.latestValues.x).toBe(40);
    expect(x.get()).toBe(40);

    // A later change still reaches the renderer through the subscription that
    // mount installed, without the element claiming the value.
    x.set(55);
    expect(visualElement.latestValues.x).toBe(55);

    x.destroy();
  });

  test('initial wins over a borrowed value for the keys it names', () => {
    const x = motionValue(40);
    const { container } = render(() => (
      <Box values={{ x }} initial={{ x: 10, opacity: 0.5 }} />
    ));
    const element = container.firstElementChild as HTMLElement;
    const visualElement = visualElementStore.get(element)!;

    // Same precedence as Motion's makeLatestValues(): values are read first,
    // then the explicit initial frame overwrites the keys it names.
    expect(element.style.transform).toBe('translateX(10px)');
    expect(element.style.opacity).toBe('0.5');
    expect(visualElement.latestValues.x).toBe(10);
    // The renderer sets the borrowed value to its initial frame, so a readout
    // starts on the same frame as the element; ownership has not changed.
    expect(x.get()).toBe(10);
    expect(visualElement.getValue('x')).toBe(x);

    x.destroy();
  });

  test('initial={false} lets the animate target win over a borrowed value', () => {
    const x = motionValue(40);
    const { container } = render(() => (
      <Box values={{ x }} initial={false} animate={{ x: 100, opacity: 0.6 }} />
    ));
    const element = container.firstElementChild as HTMLElement;
    const visualElement = visualElementStore.get(element)!;

    // The skipped mount animation would have ended on the target, so that is
    // the frame the first paint ships — over the value it was borrowed from.
    expect(element.style.transform).toBe('translateX(100px)');
    expect(element.style.opacity).toBe('0.6');
    expect(visualElement.latestValues.x).toBe(100);
    expect(x.get()).toBe(100);
    // No animation was played for the mount; the value was written in one pass.
    expect(visualElement.getValue('x')).toBe(x);

    x.destroy();
  });

  test('the explicit frame and the borrowed frame build one transform', () => {
    const x = motionValue(40);
    const { container } = render(() => (
      <Box values={{ x }} initial={{ scale: 0.5 }} />
    ));
    const element = container.firstElementChild as HTMLElement;

    // `initial` names a different transform key, so both contribute: merging
    // built style objects would have kept one transform string and dropped the
    // other, which is why the frame is rebuilt from the merged values.
    expect(element.style.transform).toBe('translateX(40px) scale(0.5)');
    expect(visualElementStore.get(element)!.latestValues).toEqual({ x: 40, scale: 0.5 });
    // `initial` does not name `x`, so the borrowed value is not overwritten.
    expect(x.get()).toBe(40);

    x.destroy();
  });

  test('initial={false} with no animate target still uses the borrowed frame', () => {
    const x = motionValue(40);
    const { container } = render(() => <Box values={{ x }} initial={false} />);
    const element = container.firstElementChild as HTMLElement;

    // Nothing overrides the value: `initial={false}` only skips a mount
    // animation, and there is none to skip.
    expect(element.style.transform).toBe('translateX(40px)');
    expect(visualElementStore.get(element)!.latestValues.x).toBe(40);
    expect(x.get()).toBe(40);

    x.destroy();
  });

  test('a borrowed value paints the first frame of the next element it binds to', () => {
    const x = motionValue(40);
    const [show, setShow] = createSignal(true);
    const Harness = () => <Box values={{ x }} />;

    const { container } = render(() => (
      <Show when={show()} fallback={<Harness />}>
        <Harness />
      </Show>
    ));
    const first = container.firstElementChild as HTMLElement;
    expect(first.style.transform).toBe('translateX(40px)');

    // The frame is read at bind time, so the replacement element paints from
    // the value as it is now rather than from the first element's frame.
    x.set(70);
    setShow(false);
    flush();

    const second = container.firstElementChild as HTMLElement;
    expect(second).not.toBe(first);
    expect(second.style.transform).toBe('translateX(70px)');
    expect(visualElementStore.get(second)!.getValue('x')).toBe(x);

    x.destroy();
  });
});

describe('values capture semantics', () => {
  test('a replacement record after mount does not rebind the element', () => {
    const first = motionValue(0);
    const second = motionValue(0);
    const [swap, setSwap] = createSignal(false);

    const { container } = render(() => (
      <Box values={{ x: swap() ? second : first }} />
    ));
    const element = container.firstElementChild as HTMLElement;
    const visualElement = visualElementStore.get(element)!;

    expect(visualElement.getValue('x')).toBe(first);

    // The prop is read once, when the element is created. This is current
    // capture-on-mount behaviour, not a reactive replacement contract.
    setSwap(true);
    flush();

    expect(visualElement.getValue('x')).toBe(first);

    // The value that arrived too late is not bound: its changes never reach the
    // element, and the original still does.
    const latest = visualElement.latestValues.x;
    second.set(30);
    expect(visualElement.latestValues.x).toBe(latest);
    first.set(12);
    expect(visualElement.latestValues.x).toBe(12);

    first.destroy();
    second.destroy();
  });
});

describe('an owned value', () => {
  test('is destroyed with its Solid owner, not by the element that borrowed it', () => {
    let x!: MotionValue<number>;
    const Harness = () => {
      x = createMotionValue(0);
      return <Box values={{ x }} />;
    };

    const { container, unmount } = render(() => <Harness />);
    const element = container.firstElementChild as HTMLElement;
    expect(visualElementStore.get(element)!.getValue('x')).toBe(x);

    // The test's listener outlives the owner on purpose: only destroying the
    // value clears it, while unmounting the element merely unsubscribes.
    const changes = vi.fn();
    x.on('change', changes);
    x.set(9);
    expect(changes).toHaveBeenCalledTimes(1);

    unmount();
    x.set(10);

    // `createMotionValue()` registered the destruction with the component
    // owner; the last frame stays readable, as it does for any destroyed value.
    expect(changes).toHaveBeenCalledTimes(1);
    expect(x.get()).toBe(10);
  });
});
