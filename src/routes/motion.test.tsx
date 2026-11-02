import { fireEvent, render } from '@solidjs/testing-library';
import { createSignal, flush, Show } from 'solid-js';
import { getValueTransition, type TargetAndTransition } from 'motion';
import type { JSX } from '@solidjs/web';
import { beforeEach, describe, expect, test, vi, type Mock } from 'vitest';

// The route builds its own motion component out of three engine primitives:
//
//   1. `new HTMLVisualElement()` + `mount()`, the renderer a motion element
//      owns. The mock records the instance, the element it mounted, its own
//      `getValue()`/`unmount()`, and the `setStaticValue()`/`render()` pair a
//      `initial={false}` mount frame is written through.
//   2. `animateElement(element, keyframes, transition, visualElement)`, the
//      vanilla animation entry that animates through that renderer. The mock
//      records every call, so a test can assert both the target and that the
//      route handed it the element's own visual element.
//   3. `animateLayout(scope, updateDom, transition)`, which still queues the
//      builder and runs `updateDom` on a microtask (the scheduling the explicit
//      boundary exists to align with).
//
// `hover()` and `press()` are gestures the route wires as features; the mock
// records the registrations and their cleanups. Everything else in `motion`
// (notably `buildHTMLStyles()`) stays real, so the `initial` assertions are
// against Motion's own serialisation rather than a re-implementation.
type TestAnimation = {
  animations: Array<{ state: 'idle' | 'running' }>;
  finished: Promise<never[]>;
  stop: Mock<() => void>;
};

type AnimateCall = {
  element: HTMLElement;
  keyframes: Record<string, unknown>;
  transition: Record<string, unknown> | undefined;
  visualElement: TestVisualElement | undefined;
};

type Gesture = {
  kind: 'hover' | 'press';
  element: Element;
  start: () => void | (() => void);
};

type TestVisualElement = {
  element?: HTMLElement;
  unmounted: boolean;
  values: Map<string, unknown>;
  latestValues: Record<string, unknown>;
  /** `initial={false}` writes its mount frame through these two. */
  staticWrites: Array<[string, unknown]>;
  renders: number;
  mount(element: HTMLElement): void;
  unmount(): void;
  getValue(key: string): unknown;
  readValue(key: string): unknown;
  setStaticValue(key: string, value: unknown): void;
  render(): void;
};

const engine = vi.hoisted(() => ({
  animateElement: vi.fn(),
  animateLayout: vi.fn(),
  hover: vi.fn(),
  press: vi.fn(),
  motionValue: vi.fn(),
  instances: [] as TestVisualElement[],
  store: new WeakMap<Element, TestVisualElement>(),
  calls: [] as AnimateCall[],
  gestures: [] as Gesture[],
  commits: [] as Array<string | undefined>,
}));

vi.mock('motion', async (importOriginal) => {
  // The engine is faked, the pure style builder stays real: `initial` is
  // serialised by `buildHTMLStyles()`, so the test asserts Motion's own output.
  const actual = await importOriginal<typeof import('motion')>();

  class HTMLVisualElement implements TestVisualElement {
    element?: HTMLElement;
    unmounted = false;
    values = new Map<string, unknown>();
    latestValues: Record<string, unknown>;
    staticWrites: Array<[string, unknown]> = [];
    renders = 0;

    constructor(options?: { visualState?: { latestValues?: Record<string, unknown> } }) {
      engine.instances.push(this);
      this.latestValues = { ...options?.visualState?.latestValues };
    }

    mount(element: HTMLElement) {
      this.element = element;
      engine.store.set(element, this);
    }

    unmount() {
      this.unmounted = true;
      this.element = undefined;
    }

    getValue(key: string) {
      return this.values.get(key);
    }

    readValue(key: string) {
      // What the element is rendering, or the default a browser would report
      // for a key it has never animated: identity for scale and opacity, zero
      // for translation and rotation.
      const identity = key.includes('scale') || key === 'opacity' ? 1 : 0;
      return this.latestValues[key] ?? identity;
    }

    setStaticValue(key: string, value: unknown) {
      this.staticWrites.push([key, value]);
      this.latestValues[key] = value;
    }

    render() {
      this.renders += 1;
    }
  }

  return {
    ...actual,
    HTMLVisualElement,
    visualElementStore: engine.store,
    animateLayout: engine.animateLayout,
    animateElement: engine.animateElement,
    hover: engine.hover,
    press: engine.press,
    motionValue: engine.motionValue,
  };
});

import MotionApiLab, {
  animateFeature,
  createLayoutBoundary,
  createMotionElement,
  hoverFeature,
  pressFeature,
} from './motion';

const installEngine = () => {
  const stops: Mock<() => void>[] = [];
  const finished: Array<() => void> = [];
  const byScope = new Map<Element, TestAnimation[]>();

  engine.motionValue.mockImplementation((initial: number) => {
    let current = initial;
    const listeners = new Set<(value: number) => void>();
    return {
      get: () => current,
      getVelocity: () => 0,
      set: (next: number) => {
        current = next;
        listeners.forEach((listener) => listener(next));
      },
      on: (_event: 'change', listener: (value: number) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      // `createMotionValue()` destroys an owned value with its Solid owner.
      // Clearing the listeners is what `MotionValue.destroy()` does, and the
      // frame stays readable, as it does in the engine.
      destroy: vi.fn(() => listeners.clear()),
    };
  });

  engine.animateElement.mockImplementation(
    (
      element: HTMLElement,
      keyframes: Record<string, unknown>,
      transition: Record<string, unknown> | undefined,
      visualElement: TestVisualElement | undefined,
    ) => {
      engine.calls.push({ element, keyframes, transition, visualElement });
      // The renderer keeps the last value it was given, which is what a gesture
      // reads before it takes a key over.
      for (const key in keyframes) {
        if (visualElement) visualElement.latestValues[key] = keyframes[key];
      }
      const child: { state: 'idle' | 'running' } = { state: 'running' };
      const stop = vi.fn(() => {
        child.state = 'idle';
      });
      stops.push(stop);
      return [
        {
          state: 'running',
          stop,
          finished: new Promise<never[]>((resolve) => {
            finished.push(() => resolve([]));
          }),
        },
      ];
    },
  );

  engine.hover.mockImplementation((element: Element, start: () => void | (() => void)) => {
    engine.gestures.push({ kind: 'hover', element, start });
    const stop = vi.fn();
    stops.push(stop);
    return stop;
  });
  engine.press.mockImplementation((element: Element, start: () => void | (() => void)) => {
    engine.gestures.push({ kind: 'press', element, start });
    const stop = vi.fn();
    stops.push(stop);
    return stop;
  });

  engine.animateLayout.mockImplementation(
    (scope: Element, updateDom: () => void | Promise<void>) =>
      new Promise<TestAnimation>((resolve, reject) => {
        queueMicrotask(() => {
          try {
            updateDom();
          } catch (error) {
            reject(error);
            return;
          }
          // What Motion would have measured/reconciled: the scope as Solid
          // committed it inside updateDom.
          engine.commits.push(
            scope instanceof HTMLElement ? scope.dataset.mode : undefined,
          );
          const running = byScope.get(scope) ?? [];
          running.forEach((animation) => {
            if (animation.animations[0]?.state === 'running') animation.stop();
          });
          const child: { state: 'idle' | 'running' } = { state: 'running' };
          const stop = vi.fn(() => {
            child.state = 'idle';
          });
          stops.push(stop);
          const animation: TestAnimation = {
            animations: [child],
            finished: new Promise<never[]>((resolveFinished) => {
              finished.push(() => resolveFinished([]));
            }),
            stop,
          };
          byScope.set(scope, [...running, animation]);
          resolve(animation);
        });
      }),
  );

  return {
    stops,
    resolveAnimations: () => finished.splice(0).forEach((finish) => finish()),
  };
};

// The click, the deferred update, the reconcile, the promise hop and the log
// write all land on microtasks. flush() lets Solid commit in between.
const settle = async () => {
  for (let turn = 0; turn < 12; turn += 1) {
    await Promise.resolve();
    flush();
  }
};

const button = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll('button')].find(
    (element) => element.textContent === label,
  )!;

const lastCall = (element: Element) =>
  engine.calls.filter((call) => call.element === element).at(-1);

// What Motion itself would use for a key, so the assertions describe the
// resolved animation rather than how the route packs the transition object.
const transitionFor = (element: Element, key: string) =>
  getValueTransition(lastCall(element)?.transition, key);

const gesture = (kind: 'hover' | 'press', element: Element) =>
  engine.gestures.find((candidate) => candidate.kind === kind && candidate.element === element)!;

beforeEach(() => {
  engine.animateElement.mockReset();
  engine.animateLayout.mockReset();
  engine.hover.mockReset();
  engine.press.mockReset();
  engine.motionValue.mockReset();
  engine.instances.length = 0;
  engine.calls.length = 0;
  engine.gestures.length = 0;
  engine.commits.length = 0;
});

describe('<MotionApiLab />', () => {
  test('renders the four experiments and one visual element per motion node', () => {
    installEngine();
    const { getByRole, container } = render(() => <MotionApiLab />);

    expect(
      getByRole('heading', { name: '1. motion.div, features composed per element' }),
    ).toBeInTheDocument();
    expect(getByRole('heading', { name: '2. Explicit layout boundary' })).toBeInTheDocument();
    expect(
      getByRole('heading', { name: '3. Refs and server-rendered initial styles' }),
    ).toBeInTheDocument();
    expect(getByRole('heading', { name: '4. Border radius: px only' })).toBeInTheDocument();

    // Four tiles, each tile's position-only label, the ref box and its label,
    // and the two radius heroes with two labels each opt into layout with
    // attributes only; no run happens until the boundary is asked.
    expect(container.querySelectorAll('[data-layout]')).toHaveLength(16);
    expect(engine.animateLayout).not.toHaveBeenCalled();
    // puck + press button + 4 tiles + 4 tile labels + ref box + ref box label +
    // initial box + initial={false} box + values-only box + 2 heroes + 4 hero
    // labels
    expect(engine.instances).toHaveLength(21);
  });

  test('tile labels are nested position-only layout nodes', () => {
    installEngine();
    const { container } = render(() => <MotionApiLab />);

    const labels = container.querySelectorAll<HTMLElement>('.motion-api-lab-tile > span');
    expect(labels).toHaveLength(4);
    expect([...labels].map((label) => label.textContent)).toEqual([
      'alpha',
      'bravo',
      'charlie',
      'delta',
    ]);
    // `layout="position"` is a data attribute, not the prop; the nested node is
    // what counter-scales the tile's projection so the text keeps its size.
    for (const label of labels) {
      expect(label).toHaveAttribute('data-layout', 'position');
      expect(label).not.toHaveAttribute('layout');
    }
    // The tile itself still animates size and position.
    const tile = labels[0]!.parentElement!;
    expect(tile).toHaveAttribute('data-layout');
    expect(tile).not.toHaveAttribute('data-layout', 'position');
  });

  test('the ref box and radius heroes nest their text as position nodes', () => {
    installEngine();
    const { container } = render(() => <MotionApiLab />);

    const refbox = container.querySelector('.motion-api-lab-refbox')!;
    expect(refbox).toHaveAttribute('data-layout');
    expect(refbox).not.toHaveAttribute('data-layout', 'position');
    expect(refbox.children).toHaveLength(1);
    expect(refbox.firstElementChild).toHaveAttribute('data-layout', 'position');
    expect(refbox.firstElementChild?.textContent).toBe('scope + probe');

    const heroes = [...container.querySelectorAll('.motion-api-lab-hero')];
    expect(heroes).toHaveLength(2);
    heroes.forEach((hero) => {
      expect(hero).toHaveAttribute('data-layout');
      expect(hero).not.toHaveAttribute('data-layout', 'position');
      expect(hero.children).toHaveLength(2);
      expect(
        [...hero.children].every(
          (node) => node.getAttribute('data-layout') === 'position',
        ),
      ).toBe(true);
    });
    // The caption keeps its semantic <small> inside the position node.
    expect(heroes[0]!.querySelector('small')).toHaveTextContent('borderRadius: 9.6');
  });

  test('DOM props pass through and motion props never reach the element', () => {
    installEngine();
    const { container } = render(() => <MotionApiLab />);

    const tile = container.querySelector('.motion-api-lab-tile')!;
    expect(tile).toHaveAttribute('data-layout');
    expect(tile).not.toHaveAttribute('animate');
    expect(tile).not.toHaveAttribute('layout');
    expect(tile).not.toHaveAttribute('transition');

    const press = container.querySelector('.motion-api-lab-press')!;
    expect(press.tagName).toBe('BUTTON');
    expect(press).toHaveAttribute('type', 'button');
    expect(press).toHaveClass('motion-api-lab-press');

    expect(container.querySelector('[whileHover]')).toBeNull();
    expect(container.querySelector('[whilePress]')).toBeNull();
    // `values` are handed to the renderer, never to the element: a MotionValue
    // record would otherwise serialise as the string "[object Object]".
    expect(container.querySelector('[values]')).toBeNull();
    expect(container.querySelector('.motion-api-lab-puck')).not.toHaveAttribute('values');
  });

  test('a prop the element does not install is rejected, and stripped if passed anyway', () => {
    installEngine();
    const Box = createMotionElement('div', [animateFeature]);

    // `whilePress` belongs to `pressFeature`, which this element does not
    // install: the factory does not accept the prop at all.
    const { container: typed } = render(() => (
      // @ts-expect-error only props of the installed features are accepted
      <Box whilePress={{ scale: 0.9 }} />
    ));
    expect(typed.firstElementChild).not.toHaveAttribute('whilepress');

    // A JS caller (or a spread) can still hand a reserved prop to a feature
    // this element does not have. Nothing reads it, so nothing may write it:
    // the strip is the reserved names, not the installed features.
    const unsupported = { whilePress: { scale: 0.9 } } as Record<string, unknown>;
    const { container } = render(() => <Box {...unsupported} />);
    expect(container.firstElementChild?.outerHTML).toBe('<div></div>');
  });

  test('initial renders as hyphenated inline style before any animation', () => {
    installEngine();
    const { container } = render(() => <MotionApiLab />);

    const probes = container.querySelectorAll<HTMLElement>('[data-ssr-probe]');
    expect(probes[0]?.style.opacity).toBe('0.5');
    expect(probes[0]?.style.transform).toBe('translateX(-12px)');

    // `initial={false}` ships its first animate target, and a keyframe array in
    // it resolves to the frame the skipped animation would have ended on. That
    // is also what the server writes, so the first client frame matches it.
    expect(probes[1]?.style.transform).toBe('translateX(24px)');
    expect(engine.calls.filter((call) => call.element === probes[1])).toHaveLength(0);

    // A borrowed value with no `initial` and no `animate`: the first paint is
    // the frame the value is already on, not the renderer's default.
    expect(probes[2]?.style.transform).toBe('translateX(40px)');
    expect(probes[2]?.style.opacity).toBe('');
    expect(engine.calls.filter((call) => call.element === probes[2])).toHaveLength(0);
  });

  test('initial seeds the renderer, so its keys are part of the first frame', () => {
    installEngine();
    const { container } = render(() => <MotionApiLab />);

    const probe = container.querySelector<HTMLElement>('[data-ssr-probe]')!;
    expect(engine.store.get(probe)?.latestValues).toEqual({ x: -12, opacity: 0.5 });
  });

  test('initial serialises Motion transform shorthands with units', () => {
    installEngine();
    const Box = createMotionElement('div', [animateFeature]);
    const { container } = render(() => (
      <Box initial={{ x: '50%', rotate: 45, scaleX: 2, opacity: 0.25 }} />
    ));

    const element = container.firstElementChild as HTMLElement;
    // Motion's own transform order and units, which is what the renderer builds.
    expect(element.style.transform).toBe('translateX(50%) scaleX(2) rotate(45deg)');
    expect(element.style.opacity).toBe('0.25');
    expect(engine.store.get(element)?.latestValues).toEqual({
      x: '50%',
      rotate: 45,
      scaleX: 2,
      opacity: 0.25,
    });
  });

  test('initial ignores values that are not a static frame', () => {
    installEngine();
    const Box = createMotionElement('div', [animateFeature]);
    // A JS caller can pass what the narrowed type rejects; none of it should
    // reach the renderer or serialise into the inline style.
    const initial = { x: 10, frames: [0, 1], variant: { opacity: 0 } } as unknown as Parameters<
      typeof Box
    >[0]['initial'];
    const { container } = render(() => <Box initial={initial} />);

    const element = container.firstElementChild as HTMLElement;
    expect(element.style.transform).toBe('translateX(10px)');
    expect(element.getAttribute('style')).not.toContain('object');
    expect(engine.store.get(element)?.latestValues).toEqual({ x: 10 });
  });

  test('initial={false} skips the mount animation and starts at the animate target', () => {
    installEngine();
    const [target, setTarget] = createSignal<TargetAndTransition>({ x: 100, opacity: 0.5 });
    const Box = createMotionElement('div', [animateFeature]);
    const { container } = render(() => <Box initial={false} animate={target()} />);
    const element = container.firstElementChild as HTMLElement;

    // The mount frame is the target, so the first paint already carries it
    // instead of the element springing out of the renderer's defaults.
    expect(element.style.transform).toBe('translateX(100px)');
    expect(element.style.opacity).toBe('0.5');

    // Written through the renderer, and nothing was animated on mount.
    const renderer = engine.store.get(element)!;
    expect(renderer.staticWrites).toEqual([
      ['x', 100],
      ['opacity', 0.5],
    ]);
    expect(renderer.renders).toBe(1);
    expect(engine.calls.filter((call) => call.element === element)).toHaveLength(0);

    // Only the mount is skipped: a later target animates as usual.
    setTarget({ x: 200 });
    flush();
    const calls = engine.calls.filter((call) => call.element === element);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.keyframes).toEqual({ x: 200 });
    expect(calls[0]?.visualElement).toBe(renderer);
  });

  test('initial={false} resolves a keyframe array to its final frame instead of animating', () => {
    installEngine();
    const [target, setTarget] = createSignal<TargetAndTransition>({ x: [0, 40, 100], opacity: 0.5 });
    const Box = createMotionElement('div', [animateFeature]);
    const { container } = render(() => <Box initial={false} animate={target()} />);
    const element = container.firstElementChild as HTMLElement;

    // The skipped mount animation would have ended on `100`, so that — not the
    // renderer's defaults and not the array — is the frame the element starts
    // on. A React motion component resolves it the same way.
    const renderer = engine.store.get(element)!;
    expect(renderer.staticWrites).toEqual([
      ['x', 100],
      ['opacity', 0.5],
    ]);
    expect(renderer.renders).toBe(1);
    // Nothing was handed to Motion: the mount frame is written, not played.
    expect(engine.calls.filter((call) => call.element === element)).toHaveLength(0);

    // Only the mount is skipped: the next target animates as usual.
    setTarget({ x: 200 });
    flush();
    const calls = engine.calls.filter((call) => call.element === element);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.keyframes).toEqual({ x: 200 });
  });

  test('initial={false} on an element with no mount target does not make later frames instant', () => {
    installEngine();
    const HoverOnly = createMotionElement('div', [hoverFeature]);
    const { container } = render(() => (
      <HoverOnly initial={false} whileHover={{ scale: 1.1 }} />
    ));
    const element = container.firstElementChild as HTMLElement;

    // No target was written at mount, so the flag is spent: the gesture
    // animates rather than jumping to its value.
    expect(engine.store.get(element)?.staticWrites).toEqual([]);
    const endHover = gesture('hover', element).start();
    expect(engine.calls.filter((call) => call.element === element)).toHaveLength(1);
    expect(lastCall(element)?.keyframes).toEqual({ scale: 1.1 });
    endHover?.();
  });

  test('a string style is applied once, so a change cannot rewrite the transform', () => {
    installEngine();
    const [style, setStyle] = createSignal('opacity: 0.85');
    const Box = createMotionElement('div', [animateFeature]);
    const { container } = render(() => <Box style={style()} initial={{ y: 5 }} />);
    const element = container.firstElementChild as HTMLElement;

    // The initial frame is appended to the cssText of the first paint.
    expect(element.style.opacity).toBe('0.85');
    expect(element.style.transform).toBe('translateY(5px)');

    // A string style is a whole cssText: Solid writes it in one assignment,
    // which would replace the transform the element animates. The mount frame
    // is therefore kept and the change is reported instead.
    const shipped = element.getAttribute('style');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setStyle('opacity: 0.4');
    flush();

    expect(element.getAttribute('style')).toBe(shipped);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/`style` is fixed when the element is created/);
    warn.mockRestore();
  });

  test('an object style that turns into a string is not applied, so the transform survives', () => {
    installEngine();
    const [style, setStyle] = createSignal<JSX.CSSProperties | string>({ opacity: '0.85' });
    const Box = createMotionElement('div', [animateFeature]);
    const { container } = render(() => <Box style={style()} initial={{ y: 5 }} />);
    const element = container.firstElementChild as HTMLElement;
    const shipped = element.getAttribute('style');

    // The object shape was fixed at mount, so the cssText is not written: the
    // frame's transform and the object's keys are what the element keeps.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setStyle('opacity: 0.4');
    flush();

    expect(element.style.opacity).toBe('0.85');
    expect(element.style.transform).toBe('translateY(5px)');
    expect(element.getAttribute('style')).toBe(shipped);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/`style` is fixed when the element is created/);
    warn.mockRestore();
  });

  test('a style that starts absent and turns into a string is not applied', () => {
    installEngine();
    const [style, setStyle] = createSignal<string | undefined>();
    const Box = createMotionElement('div', [animateFeature]);
    const { container } = render(() => <Box style={style()} initial={{ y: 5 }} />);
    const element = container.firstElementChild as HTMLElement;

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setStyle('opacity: 0.4');
    flush();

    // No object style was ever rendered, so the accessor keeps returning that,
    // and the cssText never reaches the element.
    expect(element.style.opacity).toBe('');
    expect(element.style.transform).toBe('translateY(5px)');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  test('a string style that turns into an object stays the cssText it shipped', () => {
    installEngine();
    const [style, setStyle] = createSignal<string | JSX.CSSProperties>('opacity: 0.85');
    const Box = createMotionElement('div', [animateFeature]);
    const { container } = render(() => <Box style={style()} initial={{ y: 5 }} />);
    const element = container.firstElementChild as HTMLElement;
    const shipped = element.getAttribute('style');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setStyle({ opacity: '0.4' });
    flush();

    expect(element.getAttribute('style')).toBe(shipped);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  test('an object style stays reactive without touching the animated transform', () => {
    installEngine();
    const [style, setStyle] = createSignal<JSX.CSSProperties>({ opacity: '0.85' });
    const Box = createMotionElement('div', [animateFeature]);
    const { container } = render(() => <Box style={style()} initial={{ y: 5 }} />);
    const element = container.firstElementChild as HTMLElement;

    expect(element.style.opacity).toBe('0.85');
    expect(element.style.transform).toBe('translateY(5px)');

    // Solid writes object keys one at a time, so a change is picked up and the
    // transform it was not given is left alone.
    setStyle({ opacity: '0.4' });
    flush();
    expect(element.style.opacity).toBe('0.4');
    expect(element.style.transform).toBe('translateY(5px)');
  });

  test('animate runs through the element’s own visual element on the spring', () => {
    installEngine();
    const { container } = render(() => <MotionApiLab />);

    // The first target plays when the element binds, not from a render pass.
    const puck = container.querySelector('.motion-api-lab-puck') as HTMLElement;
    expect(engine.calls.filter((call) => call.element === puck)).toHaveLength(1);
    const initial = engine.calls.find((call) => call.element === puck);
    expect(initial).toBeDefined();
    expect(initial?.keyframes).toEqual({ x: 0 });
    expect(initial?.transition).toMatchObject({ type: 'spring' });
    // The fourth argument is the renderer the component created for this node,
    // which is what makes values shared with layout projection.
    expect(initial?.visualElement).toBe(engine.store.get(puck));

    fireEvent.click(button(container, 'Right'));
    flush();

    const retarget = engine.calls.filter((call) => call.element === puck).at(-1);
    expect(retarget?.keyframes).toEqual({ x: 220 });
    expect(retarget?.visualElement).toBe(initial?.visualElement);
  });

  test('a target that only appears after mount still starts', () => {
    installEngine();
    const [target, setTarget] = createSignal<TargetAndTransition | undefined>();
    const Box = createMotionElement('div', [animateFeature]);
    const { container } = render(() => <Box animate={target()} />);
    const element = container.firstElementChild as HTMLElement;

    // Bound with no target: there was nothing to play.
    expect(engine.calls.filter((call) => call.element === element)).toHaveLength(0);

    setTarget({ x: 40 });
    flush();

    const calls = engine.calls.filter((call) => call.element === element);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.keyframes).toEqual({ x: 40 });
    expect(calls[0]?.visualElement).toBe(engine.store.get(element));
  });

  test('an interruption reads the value and velocity the target changed at', async () => {
    installEngine();
    const { container } = render(() => <MotionApiLab />);

    fireEvent.click(button(container, 'Right'));
    await settle();
    fireEvent.click(button(container, 'Left'));
    await settle();

    const readout = container.querySelector('.motion-api-lab-readout')!;
    expect(readout).toHaveTextContent('target changed at x=0.0px, v=0px/s');
    expect(readout).toHaveTextContent('x: 0px');
  });

  test('a value the route owns is the one the element animates', () => {
    installEngine();
    const { container } = render(() => <MotionApiLab />);

    const value = engine.motionValue.mock.results[0]?.value as {
      set: (next: number) => void;
    };
    value.set(137);
    flush();

    expect(container.querySelector('.motion-api-lab-readout')).toHaveTextContent('x: 137px');
  });

  test('the boundary is the only place Motion snapshots, and Solid commits inside it', async () => {
    installEngine();
    const { container } = render(() => <MotionApiLab />);
    const tiles = container.querySelector<HTMLElement>('.motion-api-lab-tiles')!;

    expect(engine.animateLayout).not.toHaveBeenCalled();

    fireEvent.click(button(container, 'Switch to grid'));
    // Motion has only queued the builder: Solid has not committed either.
    expect(engine.animateLayout).toHaveBeenCalledTimes(1);
    expect(tiles.dataset.mode).toBe('row');

    await settle();

    // `flush()` ran inside updateDom, so the scope Motion reconciled is the
    // committed one and the log has the run.
    expect(engine.commits).toEqual(['grid']);
    expect(tiles.dataset.mode).toBe('grid');
    expect(container.querySelector('.motion-api-lab-log li')).toHaveTextContent(
      'Tiles → row/grid',
    );
  });

  test('a second update during a run is accepted and reports the group in flight', async () => {
    installEngine();
    const { container } = render(() => <MotionApiLab />);

    fireEvent.click(button(container, 'Switch to grid'));
    await settle();
    fireEvent.click(button(container, 'Rotate'));
    await settle();

    expect(engine.animateLayout).toHaveBeenCalledTimes(2);
    const entries = container.querySelectorAll('.motion-api-lab-log li');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toHaveTextContent('Tiles → rotate');
    expect(entries[0]).toHaveTextContent('in flight at update: 1');
  });

  test('the ref array is composed by the component and both entries see the bound element', async () => {
    installEngine();
    const { container } = render(() => <MotionApiLab />);
    await settle();

    const report = container.querySelectorAll('.motion-api-lab-readout')[1]!;
    expect(report).toHaveTextContent('probe calls: 1');
    expect(report).toHaveTextContent('same element as the scope: yes');
    expect(report).toHaveTextContent('visual element already bound when the probe ran: yes');
  });

  test('layout targets animate only when the boundary is asked', async () => {
    installEngine();
    const { container } = render(() => <MotionApiLab />);

    fireEvent.click(button(container, 'Widen'));
    await settle();

    const scope = container.querySelector('.motion-api-lab-refbox')!;
    expect(engine.animateLayout.mock.calls[0]?.[0]).toBe(scope);
    expect(scope).toHaveAttribute('data-wide');
  });

  test('a released gesture returns its keys to the base target and nothing else', () => {
    installEngine();
    const { container } = render(() => <MotionApiLab />);
    const puck = container.querySelector('.motion-api-lab-puck')!;
    const pressButton = container.querySelector('.motion-api-lab-press')!;

    const endHover = gesture('hover', puck).start();
    expect(lastCall(puck)?.keyframes).toEqual({ scale: 1.08 });

    // Only `scale` was raised. `x` is the base target's and stays in flight:
    // the release re-sends the keys it moved, not the whole element.
    endHover?.();
    expect(lastCall(puck)?.keyframes).toEqual({ scale: 1 });

    const endPress = gesture('press', pressButton).start();
    expect(lastCall(pressButton)?.keyframes).toEqual({ scale: 0.92 });
    endPress?.();
    expect(lastCall(pressButton)?.keyframes).toEqual({ scale: 1 });
  });

  test('hover and press compose per property, press winning the keys they share', () => {
    installEngine();
    const Button = createMotionElement('button', [
      animateFeature,
      hoverFeature,
      pressFeature,
    ]);
    const { container } = render(() => (
      <Button
        animate={{ scale: 1, x: 0 }}
        whileHover={{ scale: 1.08, opacity: 0.9 }}
        whilePress={{ scale: 0.92 }}
      />
    ));
    const element = container.firstElementChild as HTMLElement;

    const endHover = gesture('hover', element).start();
    expect(lastCall(element)?.keyframes).toEqual({ scale: 1.08, opacity: 0.9 });

    // Press beats hover on `scale` and says nothing about the other keys, so
    // they are left where they are instead of being resent.
    const endPress = gesture('press', element).start();
    expect(lastCall(element)?.keyframes).toEqual({ scale: 0.92 });

    // Letting go of press falls back to hover, which is still active.
    endPress?.();
    expect(lastCall(element)?.keyframes).toEqual({ scale: 1.08 });

    // A second deactivation (pointerup and pointercancel both firing, say) is
    // a no-op: the keys are already at their resolved target.
    const calls = engine.calls.length;
    endPress?.();
    expect(engine.calls).toHaveLength(calls);

    // Leaving hover falls back to the base target for `scale`, and to the
    // frame the element had when hover took `opacity` for `opacity`.
    endHover?.();
    expect(lastCall(element)?.keyframes).toEqual({ scale: 1, opacity: 1 });
  });

  test('a base update during a gesture only retargets the keys the gesture is not holding', () => {
    installEngine();
    const [base, setBase] = createSignal<TargetAndTransition>({ scale: 1, x: 0 });
    const Button = createMotionElement('button', [
      animateFeature,
      hoverFeature,
      pressFeature,
    ]);
    const { container } = render(() => (
      <Button animate={base()} whileHover={{ scale: 1.08, opacity: 0.9 }} />
    ));
    const element = container.firstElementChild as HTMLElement;

    const endHover = gesture('hover', element).start();
    expect(lastCall(element)?.keyframes).toEqual({ scale: 1.08, opacity: 0.9 });

    setBase({ scale: 1.2, x: 50 });
    flush();

    // `scale` is hover's, so the new base does not yank it. `x` is the base's
    // and retargets immediately.
    expect(lastCall(element)?.keyframes).toEqual({ x: 50 });

    // The release resolves against the base as it is now, not the snapshot
    // taken when hover began.
    endHover?.();
    expect(lastCall(element)?.keyframes).toEqual({ scale: 1.2, opacity: 1 });
  });

  test('a released key falls back per key: base value or the frame it had', () => {
    installEngine();
    const Box = createMotionElement('div', [animateFeature, hoverFeature]);
    const { container } = render(() => (
      <Box initial={{ scale: 0.8 }} animate={{ x: 0 }} whileHover={{ scale: 1.1, rotate: 5 }} />
    ));
    const element = container.firstElementChild as HTMLElement;

    const endHover = gesture('hover', element).start();
    expect(lastCall(element)?.keyframes).toEqual({ scale: 1.1, rotate: 5 });

    // `scale` was in the initial frame; `rotate` had never been set, so its
    // fallback is what a browser reports for it.
    endHover?.();
    expect(lastCall(element)?.keyframes).toEqual({ scale: 0.8, rotate: 0 });
  });

  test('a restored key uses the transition of the layer it resolves to', () => {
    installEngine();
    const propTransition = {
      type: 'spring',
      visualDuration: 0.45,
      bounce: 0.22,
    } as const;
    const Button = createMotionElement('button', [
      animateFeature,
      hoverFeature,
      pressFeature,
    ]);
    const { container } = render(() => (
      <Button
        animate={{ scale: 1, x: 0, transition: { scale: { duration: 2 } } }}
        transition={propTransition}
        whileHover={{ scale: 1.08, transition: { scale: { duration: 1 } } }}
        whilePress={{ scale: 0.92 }}
      />
    ));
    const element = container.firstElementChild as HTMLElement;

    // The base layer owns `scale` at mount and declares its own transition.
    expect(transitionFor(element, 'scale')).toEqual({ duration: 2 });

    const endHover = gesture('hover', element).start();
    // Hover owns `scale` while it is active, so its nested transition wins over
    // the element's `transition` prop.
    expect(transitionFor(element, 'scale')).toEqual({ duration: 1 });

    const endPress = gesture('press', element).start();
    // Press names no transition of its own: the trigger transition is what it
    // animates with.
    expect(transitionFor(element, 'scale')).toEqual(propTransition);

    // Letting go resolves `scale` back to hover. The restore is hover's value,
    // so it uses hover's transition — not press's release trigger.
    endPress?.();
    expect(lastCall(element)?.keyframes).toEqual({ scale: 1.08 });
    expect(transitionFor(element, 'scale')).toEqual({ duration: 1 });

    // Letting go of hover resolves back to the base target and its transition.
    endHover?.();
    expect(lastCall(element)?.keyframes).toEqual({ scale: 1 });
    expect(transitionFor(element, 'scale')).toEqual({ duration: 2 });
  });

  test('transitionEnd is rejected instead of bypassing the priority layers', () => {
    installEngine();
    const Box = createMotionElement('div', [animateFeature, hoverFeature]);

    // Compile-time: the prop type omits the option, so a typed caller cannot
    // hand it over.
    const typed: Parameters<typeof Box>[0]['animate'] = {
      scale: 1,
      // @ts-expect-error transitionEnd is not a supported motion target key
      transitionEnd: { scale: 0 },
    };
    void typed;

    // Runtime: a JS caller can still pass it. Motion applies transitionEnd when
    // the animation settles, after the priority layers have moved on, so it
    // would overwrite a gesture that owns the same key. Reject it explicitly
    // rather than forward a target this element cannot resolve.
    const [base, setBase] = createSignal<Parameters<typeof Box>[0]['animate']>({
      scale: 1,
    });
    const { container } = render(() => (
      <Box animate={base()} whileHover={{ scale: 1.08 }} />
    ));
    const element = container.firstElementChild as HTMLElement;
    const endHover = gesture('hover', element).start();
    expect(lastCall(element)?.keyframes).toEqual({ scale: 1.08 });

    expect(() => {
      setBase({
        scale: 1,
        transitionEnd: { scale: 0 },
      } as unknown as Parameters<typeof Box>[0]['animate']);
      flush();
    }).toThrow(/transitionEnd is not supported/);

    // The rejected target never reached Motion, and hover still owns `scale`.
    expect(lastCall(element)?.keyframes).toEqual({ scale: 1.08 });
    endHover?.();
    expect(lastCall(element)?.keyframes).toEqual({ scale: 1 });
  });

  test('a gesture element works without the animate feature', () => {
    installEngine();
    const HoverOnly = createMotionElement('div', [hoverFeature]);
    const { container } = render(() => <HoverOnly whileHover={{ opacity: 0.5 }} />);
    const element = container.firstElementChild as HTMLElement;

    // No base layer: the gesture still raises and restores its own key.
    expect(lastCall(element)).toBeUndefined();
    const endHover = gesture('hover', element).start();
    expect(lastCall(element)?.keyframes).toEqual({ opacity: 0.5 });
    endHover?.();
    expect(lastCall(element)?.keyframes).toEqual({ opacity: 1 });
  });

  test('a mutation that throws is reported, not swallowed', async () => {
    installEngine();
    const failures: Array<{ label: string; error: unknown }> = [];
    const runs: unknown[] = [];
    let boundary!: ReturnType<typeof createLayoutBoundary>;
    const Harness = () => {
      boundary = createLayoutBoundary({
        onRun: (run) => runs.push(run),
        onError: (failure) => failures.push(failure),
      });
      return <div ref={boundary.ref} />;
    };
    render(() => <Harness />);

    boundary.update(() => {
      throw new Error('mutation threw');
    }, 'Test → throw');
    await settle();

    expect(failures).toHaveLength(1);
    const [failure] = failures;
    expect(failure!.label).toBe('Test → throw');
    expect((failure!.error as Error).message).toBe('mutation threw');
    // A failed run is not a completed one.
    expect(runs).toHaveLength(0);
  });

  test('an update after the owner is disposed is reported and animates nothing', async () => {
    installEngine();
    const failures: Array<{ label: string; error: unknown }> = [];
    const runs: unknown[] = [];
    let boundary!: ReturnType<typeof createLayoutBoundary>;
    const Harness = () => {
      boundary = createLayoutBoundary({
        onRun: (run) => runs.push(run),
        onError: (failure) => failures.push(failure),
      });
      return <div ref={boundary.ref} />;
    };
    const { unmount } = render(() => <Harness />);
    unmount();

    let mutated = false;
    boundary.update(() => {
      mutated = true;
    }, 'Test → after dispose');
    await settle();

    // There is no scope left to measure, so neither the mutation nor a run
    // happens; the drop is reported rather than swallowed.
    expect(mutated).toBe(false);
    expect(engine.animateLayout).not.toHaveBeenCalled();
    expect(runs).toHaveLength(0);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.label).toBe('Test → after dispose');
    expect((failures[0]!.error as Error).message).toMatch(/disposed/);
  });

  test('a run finalised after unmount is stopped instead of tracked', async () => {
    const { stops } = installEngine();
    const runs: unknown[] = [];
    let boundary!: ReturnType<typeof createLayoutBoundary>;
    const Harness = () => {
      boundary = createLayoutBoundary({ onRun: (run) => runs.push(run) });
      return <div ref={boundary.ref} />;
    };
    const { unmount } = render(() => <Harness />);

    let mutated = false;
    boundary.update(() => {
      mutated = true;
    }, 'Test → pending unmount');
    // Motion only queued the builder: the page is gone before it finalises.
    expect(engine.animateLayout).toHaveBeenCalledTimes(1);
    unmount();
    await settle();

    // Solid still owns the mutation, but the group is stopped rather than
    // written through a scope the page no longer owns.
    expect(mutated).toBe(true);
    expect(runs).toHaveLength(0);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toHaveBeenCalledTimes(1);
  });

  test('a run whose scope was replaced before it finalised is stopped', async () => {
    const { stops } = installEngine();
    const runs: unknown[] = [];
    const [first, setFirst] = createSignal(true);
    let boundary!: ReturnType<typeof createLayoutBoundary>;
    const Harness = () => {
      boundary = createLayoutBoundary({ onRun: (run) => runs.push(run) });
      return (
        <Show when={first()} fallback={<div ref={boundary.ref} />}>
          <div ref={boundary.ref} />
        </Show>
      );
    };
    render(() => <Harness />);
    const bound = boundary.element();

    boundary.update(() => {}, 'Test → stale scope');
    setFirst(false);
    flush();
    // The ref has been handed a different element while the builder is queued.
    expect(boundary.element()).not.toBe(bound);
    await settle();

    expect(runs).toHaveLength(0);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toHaveBeenCalledTimes(1);
  });

  test('the page reports a throwing mutation and keeps taking updates', async () => {
    installEngine();
    const { container } = render(() => <MotionApiLab />);

    fireEvent.click(button(container, 'Throw in update'));
    await settle();

    const entry = container.querySelector('.motion-api-lab-log li')!;
    expect(entry).toHaveTextContent('Tiles → throwing update');
    expect(entry).toHaveTextContent('failed: deliberate: the mutation threw');

    // The failed mutation never reached setGrid, and the boundary still works.
    fireEvent.click(button(container, 'Switch to grid'));
    await settle();

    expect(container.querySelectorAll('.motion-api-lab-log li')).toHaveLength(2);
    expect(container.querySelector('.motion-api-lab-log li')).toHaveTextContent('Tiles → row/grid');
    expect(container.querySelector('.motion-api-lab-tiles')).toHaveAttribute('data-mode', 'grid');
  });

  test('borderRadius is animated through the visual element for both units', async () => {
    installEngine();
    const { container } = render(() => <MotionApiLab />);

    const heroes = [...container.querySelectorAll<HTMLElement>('.motion-api-lab-hero')];
    expect(heroes).toHaveLength(2);

    const px = engine.calls.filter((call) => call.element === heroes[0]).at(-1);
    const rem = engine.calls.filter((call) => call.element === heroes[1]).at(-1);
    expect(px?.keyframes).toEqual({ borderRadius: 9.6 });
    expect(rem?.keyframes).toEqual({ borderRadius: '0.6rem' });
    expect(px?.visualElement).toBe(engine.store.get(heroes[0]!));
    expect(rem?.visualElement).toBe(engine.store.get(heroes[1]!));
  });

  test('unmount stops what is still writing and releases every renderer', async () => {
    const { stops } = installEngine();
    const { container, unmount } = render(() => <MotionApiLab />);

    fireEvent.click(button(container, 'Right'));
    await settle();

    expect(engine.instances.every((instance) => !instance.unmounted)).toBe(true);
    const running = stops.filter((stop) => stop.mock.calls.length === 0);
    expect(running.length).toBeGreaterThan(0);

    unmount();

    // The animations started for the target, the gesture registrations (hover
    // on the puck and on the button, press on the button) and nothing else
    // were released.
    expect(engine.hover).toHaveBeenCalledTimes(2);
    expect(engine.press).toHaveBeenCalledTimes(1);
    expect(engine.instances.every((instance) => instance.unmounted)).toBe(true);
    expect(stops.every((stop) => stop.mock.calls.length === 1)).toBe(true);

    // The route's own value goes with the component: `createMotionValue()`
    // registered its destruction with the same owner.
    const value = engine.motionValue.mock.results[0]?.value as {
      destroy: Mock<() => void>;
    };
    expect(value.destroy).toHaveBeenCalledTimes(1);
  });
});
