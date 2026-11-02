import { HTMLVisualElement, motionValue, type MotionNodeOptions, type MotionValue } from 'motion';
import { createEffect, createRoot, flush, type Accessor } from 'solid-js';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  createMotionValue,
  createMotionValues,
  createMotionValueAccessor,
  subscribeMotionValue,
} from './motion-value';

// These tests use the engine, not a stand-in. A `MotionValue` here is the one
// `motionValue()` builds, with its real single-subscriber fast path, its real
// `destroy()` and its real "only notify when the value changed" rule, and the
// renderer in the contract test is `HTMLVisualElement` itself. Nothing is
// replaced by a fake: the one instrumented call is a pass-through around
// `value.on()` that records the unsubscribe and delegates to the real method.
//
// What the primitives add is ownership, so that is what the assertions look
// at — who survives a disposal, and who does not. An owner is a `createRoot`,
// which is the same scope a component gives its cleanups: dispose it and
// everything created under it is disposed with it.

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createMotionValue()', () => {
  test('is a real MotionValue, at the frame it was created with', () => {
    const dispose = createRoot((dispose) => {
      const x = createMotionValue(0);

      expect(x.get()).toBe(0);
      expect(x.getVelocity()).toBe(0);
      expect(x.isAnimating()).toBe(false);

      x.set(12);

      expect(x.get()).toBe(12);
      return dispose;
    });

    dispose();
  });

  test('the owner destroys it, and the last frame stays readable', () => {
    let x!: MotionValue<number>;
    const dispose = createRoot((dispose) => {
      x = createMotionValue(0);
      return dispose;
    });

    // Registered outside the owner on purpose: this listener outlives every
    // Solid scope in the test, so it only goes quiet if the value itself was
    // destroyed (`destroy()` clears its listeners), not merely unsubscribed.
    const changes = vi.fn();
    x.on('change', changes);

    x.set(1);
    expect(changes).toHaveBeenCalledTimes(1);

    dispose();
    x.set(2);

    expect(changes).toHaveBeenCalledTimes(1);
    // Destroy is not a reset: the slot is what a farewell measurement reads.
    expect(x.get()).toBe(2);
  });

  test('a record is owned per key, and typing follows the initials', () => {
    let values!: {
      x: MotionValue<number>;
      opacity: MotionValue<number>;
    };
    const dispose = createRoot((dispose) => {
      values = createMotionValues({ x: 0, opacity: 1 });
      return dispose;
    });

    expect(values.x.get()).toBe(0);
    expect(values.opacity.get()).toBe(1);

    // The record is the shape a motion element's `values` prop takes, keyed and
    // typed per property. `@ts-expect-error` is the compile-time half.
    const x: MotionValue<number> = values.x;
    expect(x.get()).toBe(0);
    // @ts-expect-error each key keeps its own value type
    const wrong: MotionValue<string> = values.x;
    void wrong;

    const changes = vi.fn();
    values.x.on('change', changes);

    dispose();
    values.x.set(10);

    expect(changes).not.toHaveBeenCalled();
  });
});

describe('subscribeMotionValue()', () => {
  test('delivers each change, and only a change', () => {
    const seen: number[] = [];
    const dispose = createRoot((dispose) => {
      const x = createMotionValue(0);
      subscribeMotionValue(x, (next) => seen.push(next));

      x.set(1);
      x.set(2);
      // Motion notifies on a real change only, which is what keeps a readout
      // from re-running for a frame that repeats the value it already had.
      x.set(2);
      return dispose;
    });

    expect(seen).toEqual([1, 2]);
    dispose();
  });

  test('the unsubscribe is idempotent, so the owner may call it again', () => {
    const seen: number[] = [];
    let x!: MotionValue<number>;
    let stop!: () => void;

    const dispose = createRoot((dispose) => {
      x = createMotionValue(0);
      stop = subscribeMotionValue(x, (next) => seen.push(next));
      return dispose;
    });

    x.set(1);
    stop();
    x.set(2);

    expect(seen).toEqual([1]);
    expect(() => {
      stop();
      dispose();
    }).not.toThrow();
    expect(seen).toEqual([1]);
  });

  test('two owners on one value dispose independently', () => {
    let x!: MotionValue<number>;
    const owner = createRoot((dispose) => {
      x = createMotionValue(0);
      return dispose;
    });

    const first = vi.fn();
    const second = vi.fn();
    const disposeFirst = createRoot((dispose) => {
      subscribeMotionValue(x, first);
      return dispose;
    });
    const disposeSecond = createRoot((dispose) => {
      subscribeMotionValue(x, second);
      return dispose;
    });

    x.set(1);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    // A second listener moves the value off its single-subscriber fast path and
    // onto a manager, so this also covers the list path.
    disposeFirst();
    x.set(2);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);

    disposeSecond();
    x.set(3);
    expect(second).toHaveBeenCalledTimes(2);

    owner();
  });

  test('a value the caller owns is borrowed, never destroyed', () => {
    // Not created under a root: this value belongs to the test, as a value
    // created at module scope or handed in by a caller would.
    const x = motionValue(0);
    const external = vi.fn();
    const borrowed = vi.fn();
    x.on('change', external);

    const dispose = createRoot((dispose) => {
      subscribeMotionValue(x, borrowed);
      createMotionValueAccessor(x);
      return dispose;
    });

    dispose();
    x.set(5);

    // Both borrowers let go of it; the value kept running for its owner.
    expect(borrowed).not.toHaveBeenCalled();
    expect(external).toHaveBeenCalledTimes(1);
    expect(x.get()).toBe(5);

    x.destroy();
  });
});

describe('createMotionValueAccessor()', () => {
  test('starts at the current frame, not at a remembered initial', () => {
    const x = motionValue(0);
    x.set(7);

    const dispose = createRoot((dispose) => {
      const read = createMotionValueAccessor(x);
      expect(read()).toBe(7);
      return dispose;
    });

    dispose();
    x.destroy();
  });

  test('a function frame is data at the first read and after a change', () => {
    // `MotionValue<V>` is generic over whatever Motion can carry, and Motion
    // stores a function like any other value. Solid is the half with the
    // opinion: it reads a function initial as a compute function and a function
    // setter argument as an updater, so either end would call the frame instead
    // of keeping it. The accessor has to hand back the value, not a call.
    const first = vi.fn((n: number) => n * 2);
    const second = vi.fn((n: number) => n + 1);
    const x = motionValue<(n: number) => number>(first);
    let read!: Accessor<(n: number) => number>;

    const dispose = createRoot((dispose) => {
      read = createMotionValueAccessor(x);
      expect(read()).toBe(first);
      return dispose;
    });

    x.set(second);
    flush();

    expect(read()).toBe(second);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();

    dispose();
    x.destroy();
  });

  test('a function frame arriving as a change is data too', () => {
    // The other half of the same ambiguity: the initial frame is not a function,
    // so the signal is an ordinary one, and the change is the first function its
    // setter sees. Solid would apply it as an updater over the previous frame.
    const later = vi.fn(() => 42);
    const x = motionValue<number | (() => number)>(0);
    let read!: Accessor<number | (() => number)>;

    const dispose = createRoot((dispose) => {
      read = createMotionValueAccessor(x);
      expect(read()).toBe(0);
      return dispose;
    });

    x.set(later);
    flush();

    expect(read()).toBe(later);
    expect(later).not.toHaveBeenCalled();

    dispose();
    x.destroy();
  });

  test('lands its writes at flush, like any other Solid signal', () => {
    let x!: MotionValue<number>;
    const applied: number[] = [];

    // The value and its reader are owned; the write comes from outside the
    // scope, which is where a MotionValue is driven from — an event handler or
    // a Motion frame, never a component's construction pass.
    const dispose = createRoot((dispose) => {
      x = createMotionValue(0);
      const read = createMotionValueAccessor(x);
      // A tracked scope reading the bridge, which is the whole point of it: a
      // render can depend on a MotionValue. The apply half records what the
      // render saw.
      createEffect(
        () => read(),
        (next) => {
          applied.push(next);
        },
      );
      return dispose;
    });

    expect(applied).toEqual([]);

    // The mount pass runs in Solid's effect phase, so it arrives with the
    // first flush, reading the value's initial frame.
    flush();
    expect(applied).toEqual([0]);

    x.set(4);
    // Solid 2 batches: the value already moved, the render has not been handed
    // the new frame.
    expect(x.get()).toBe(4);
    expect(applied).toEqual([0]);

    flush();

    expect(applied).toEqual([0, 4]);

    dispose();
  });

  test('a write from inside an owned scope is Solid’s error, not swallowed', () => {
    // The bridge writes a signal, and a signal write inside an owner's
    // construction pass is what Solid 2 rejects. The primitive does not opt out
    // of that check: a producer that writes there is calling `set()` from the
    // wrong place, and silently accepting it would hide the bug.
    const x = motionValue(0);

    const dispose = createRoot((dispose) => {
      createMotionValueAccessor(x);
      expect(() => x.set(1)).toThrow(/owned scope/i);
      return dispose;
    });

    dispose();
    x.destroy();
  });

  test('unsubscribes with its owner, so the disposed scope is never re-entered', () => {
    const x = motionValue(0);
    let unsubscribed = 0;
    const on = x.on.bind(x);
    // The engine stays real; only the returned unsubscribe is recorded, which
    // is the one thing a listener cannot observe from the outside.
    vi.spyOn(x, 'on').mockImplementation(((event, callback) => {
      const stop = on(event, callback);
      return () => {
        unsubscribed += 1;
        stop();
      };
    }) as typeof x.on);

    const dispose = createRoot((dispose) => {
      createMotionValueAccessor(x);
      return dispose;
    });

    expect(unsubscribed).toBe(0);

    dispose();
    expect(unsubscribed).toBe(1);

    expect(() => {
      x.set(9);
      flush();
    }).not.toThrow();

    x.destroy();
  });

  test('needs neither an owner nor an element, which is the server shape', () => {
    // No owner, no element, no DOM: a value can be created and read during a
    // server render. The only update mechanism is the value's own `change`
    // event — there is no frame to wait for, which is why the flush test above
    // moves a value with nothing else running.
    const diagnostics: string[] = [];
    const record = (...args: unknown[]) => {
      diagnostics.push(args.map(String).join(' '));
    };
    vi.spyOn(console, 'warn').mockImplementation(record);
    vi.spyOn(console, 'error').mockImplementation(record);

    const x = createMotionValue(0);
    const read = createMotionValueAccessor(x);
    const stop = subscribeMotionValue(x, () => {});

    expect(read()).toBe(0);

    x.set(3);
    flush();

    expect(read()).toBe(3);
    // A cleanup registered with no owner only warns in dev and never runs, so
    // the primitives skip it rather than promise something they cannot keep.
    expect(diagnostics.join('\n')).not.toContain('NO_OWNER_CLEANUP');

    stop();
    x.destroy();
  });
});

describe('the values contract', () => {
  test('a visual element borrows the values it is handed', () => {
    const element = document.createElement('div');
    const x = motionValue(0);
    const changes = vi.fn();
    x.on('change', changes);

    // The renderer a motion element creates for itself, bound with a value the
    // page owns — the same handoff `values={{ x }}` makes.
    const visualElement = new HTMLVisualElement({
      props: { style: { x } } as MotionNodeOptions,
      presenceContext: null,
      visualState: {
        latestValues: {},
        renderState: { transform: {}, transformOrigin: {}, style: {}, vars: {} },
      },
    });

    visualElement.mount(element);
    // The renderer took the value itself, not a copy of its current frame.
    expect(visualElement.getValue('x')).toBe(x);

    visualElement.unmount();

    // Unmount removes the renderer's own subscription and nothing else: a value
    // it did not create stays live, which is what lets a page rebind one value
    // to the next element (a shared element crossing a branch swap).
    x.set(5);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(x.get()).toBe(5);

    x.destroy();
  });
});
