import { render } from '@solidjs/testing-library';
import { createRoot, flush, untrack } from 'solid-js';
import type { MotionScope } from 'motion';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  createInView,
  createMotionScope,
  createReducedMotion,
  type CreateInViewOptions,
} from './motion-hooks';

// These tests use the real Motion engine (`inView`, `scopeMotion`) wherever the
// platform can support it. Only the platform primitives jsdom does not provide
// are faked:
//
//   - `matchMedia`, so a media listener can be changed and its removal counted.
//   - `IntersectionObserver`, so an observer can be told what Motion's real
//     `inView()` should see. The assertion surface is the options Motion passes
//     (`rootMargin`, `threshold`, observed targets) and the entries Motion's own
//     callback receives, not a mock of `inView()` itself.
//
// `scopeMotion` needs neither, so that suite runs entirely against the installed
// engine. jsdom still cannot paint, so these tests say nothing about actual
// visibility or animation timing; they cover lifecycle and the values handed
// back to Solid.

const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
const originalIntersectionObserver = Object.getOwnPropertyDescriptor(
  globalThis,
  'IntersectionObserver',
);

afterEach(() => {
  if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
  else delete (window as unknown as { matchMedia?: unknown }).matchMedia;

  if (originalIntersectionObserver) {
    Object.defineProperty(globalThis, 'IntersectionObserver', originalIntersectionObserver);
  } else {
    delete (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
  }
});

type MediaListener = (event: MediaQueryListEvent) => void;

const installMatchMedia = (matches: boolean) => {
  const listeners = new Set<MediaListener>();
  const state = { matches };

  const media = {
    get matches() {
      return state.matches;
    },
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addEventListener: vi.fn((type: string, listener: MediaListener) => {
      if (type === 'change') listeners.add(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: MediaListener) => {
      if (type === 'change') listeners.delete(listener);
    }),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as unknown as MediaQueryList;

  const matchMedia = vi.fn(() => media);
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: matchMedia,
  });

  return {
    matchMedia,
    listenerCount: () => listeners.size,
    set(next: boolean) {
      state.matches = next;
      listeners.forEach((listener) => listener({ matches: next } as MediaQueryListEvent));
    },
  };
};

const ReducedProbe = () => {
  const reduced = createReducedMotion();
  return <output data-testid="reduced">{reduced() ? 'reduce' : 'full'}</output>;
};

describe('createReducedMotion', () => {
  test('reports the server-safe initial value before the media query settles', () => {
    installMatchMedia(true);
    let firstRead: boolean | undefined;

    const Probe = () => {
      const reduced = createReducedMotion();
      if (firstRead === undefined) firstRead = untrack(reduced);
      return <output data-testid="reduced">{reduced() ? 'reduce' : 'full'}</output>;
    };

    const { getByTestId } = render(() => <Probe />);
    expect(firstRead).toBe(false);

    flush();
    expect(getByTestId('reduced')).toHaveTextContent('reduce');
  });

  test('starts false for SSR, follows the media query, and removes its listener', () => {
    const media = installMatchMedia(true);
    const { getByTestId, unmount } = render(() => <ReducedProbe />);

    flush();
    expect(media.matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
    expect(getByTestId('reduced')).toHaveTextContent('reduce');
    expect(media.listenerCount()).toBe(1);

    media.set(false);
    flush();
    expect(getByTestId('reduced')).toHaveTextContent('full');

    media.set(true);
    flush();
    expect(getByTestId('reduced')).toHaveTextContent('reduce');

    unmount();
    expect(media.listenerCount()).toBe(0);
  });

  test('stays false and does not throw when matchMedia is unavailable', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: undefined,
    });

    const { getByTestId } = render(() => <ReducedProbe />);
    flush();

    expect(getByTestId('reduced')).toHaveTextContent('full');
  });
});

type TestObserver = {
  callback: IntersectionObserverCallback;
  root: Element | Document | null;
  rootMargin: string;
  thresholds: readonly number[];
  observed: Set<Element>;
  disconnected: boolean;
  emit(target: Element, isIntersecting: boolean): void;
};

// jsdom has no IntersectionObserver. This fake is the browser primitive, not a
// Motion mock: Motion's real inView() constructs it, observes through it and
// reads the entries passed here.
const installIntersectionObserver = () => {
  const instances: TestObserver[] = [];

  class FakeIntersectionObserver {
    readonly root: Element | Document | null;
    readonly rootMargin: string;
    readonly thresholds: readonly number[];
    readonly observed = new Set<Element>();
    disconnected = false;

    constructor(
      readonly callback: IntersectionObserverCallback,
      init: IntersectionObserverInit = {},
    ) {
      this.root = init.root ?? null;
      this.rootMargin = init.rootMargin ?? '0px';
      this.thresholds = Array.isArray(init.threshold)
        ? init.threshold
        : [init.threshold ?? 0];
      instances.push(this as unknown as TestObserver);
    }

    observe(target: Element) {
      this.observed.add(target);
    }

    unobserve(target: Element) {
      this.observed.delete(target);
    }

    disconnect() {
      this.disconnected = true;
      this.observed.clear();
    }

    takeRecords() {
      return [];
    }

    emit(target: Element, isIntersecting: boolean) {
      const entry = {
        target,
        isIntersecting,
        intersectionRatio: isIntersecting ? 1 : 0,
      } as IntersectionObserverEntry;
      this.callback([entry], this as unknown as IntersectionObserver);
    }
  }

  Object.defineProperty(globalThis, 'IntersectionObserver', {
    configurable: true,
    writable: true,
    value: FakeIntersectionObserver,
  });

  return instances;
};

const InViewProbe = (props: { options?: CreateInViewOptions }) => {
  // Options describe the observation, not a reactive input: they are read once
  // when the element binds.
  const view = createInView(untrack(() => props.options));
  return (
    <div>
      <div data-testid="target" ref={view.ref} />
      <output data-testid="state">{view.inView() ? 'in' : 'out'}</output>
      <output data-testid="entry">{view.entry()?.isIntersecting ? 'entry-in' : 'entry-out'}</output>
    </div>
  );
};

describe('createInView', () => {
  test('observes the bound element with Motion options and tracks both directions', () => {
    const observers = installIntersectionObserver();
    const { getByTestId, unmount } = render(() => (
      <InViewProbe options={{ amount: 'all', margin: '10px 0px' }} />
    ));

    flush();
    expect(observers).toHaveLength(1);
    const observer = observers[0]!;
    const target = getByTestId('target');

    // Motion's own option normalisation: 'all' is threshold 1, the margin is
    // forwarded unchanged, and the ref target is what was observed.
    expect(observer.root).toBeNull();
    expect(observer.rootMargin).toBe('10px 0px');
    expect(observer.thresholds).toEqual([1]);
    expect([...observer.observed]).toEqual([target]);
    expect(getByTestId('state')).toHaveTextContent('out');

    observer.emit(target, true);
    flush();
    expect(getByTestId('state')).toHaveTextContent('in');
    expect(getByTestId('entry')).toHaveTextContent('entry-in');

    observer.emit(target, false);
    flush();
    expect(getByTestId('state')).toHaveTextContent('out');
    expect(getByTestId('entry')).toHaveTextContent('entry-out');

    unmount();
    expect(observer.disconnected).toBe(true);
    expect(observer.observed.size).toBe(0);
  });

  test('once keeps the first intersection and lets Motion unobserve', () => {
    const observers = installIntersectionObserver();
    const view: { handle?: ReturnType<typeof createInView> } = {};
    const { getByTestId, unmount } = render(() => {
      view.handle = createInView({ once: true });
      return (
        <div>
          <div data-testid="target" ref={view.handle.ref} />
          <output data-testid="state">{view.handle.inView() ? 'in' : 'out'}</output>
        </div>
      );
    });

    flush();
    const observer = observers[0]!;
    const target = getByTestId('target');

    observer.emit(target, true);
    flush();
    expect(view.handle!.inView()).toBe(true);
    // Motion's inView() unobserves when its start callback returns nothing; the
    // once path relies on that rather than re-implementing the observer.
    expect(observer.observed.size).toBe(0);

    observer.emit(target, false);
    flush();
    expect(view.handle!.inView()).toBe(true);

    unmount();
  });

  test('without IntersectionObserver the ref is accepted and the value stays false', () => {
    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      writable: true,
      value: undefined,
    });

    const { getByTestId } = render(() => <InViewProbe />);
    flush();

    expect(getByTestId('state')).toHaveTextContent('out');
  });
});

describe('createMotionScope', () => {
  test('creates the scope at the root, exposes run(), and cancels on disposal', () => {
    const scopes: MotionScope[] = [];
    let cleanups = 0;
    let handle!: ReturnType<typeof createMotionScope>;

    const Harness = () => {
      handle = createMotionScope({
        setup: (scope) => {
          scopes.push(scope);
          return () => {
            cleanups += 1;
          };
        },
      });
      return <div ref={handle.ref} />;
    };

    const { unmount } = render(() => <Harness />);
    flush();

    expect(scopes).toHaveLength(1);
    const scope = scopes[0]!;
    expect(handle.scope()).toBe(scope);
    expect(scope.state).toBe('active');
    expect(handle.run((live) => {
      expect(live).toBe(scope);
      return 7;
    })).toBe(7);

    unmount();
    expect(cleanups).toBe(1);
    expect(scope.state).toBe('cancelled');
    expect(handle.scope()).toBeUndefined();
  });

  test('run() before a ref binds is a no-op', () => {
    let handle!: ReturnType<typeof createMotionScope>;
    let called = false;

    const dispose = createRoot((dispose) => {
      handle = createMotionScope();
      return dispose;
    });

    expect(handle.scope()).toBeUndefined();
    expect(handle.run(() => {
      called = true;
      return 1;
    })).toBeUndefined();
    expect(called).toBe(false);

    dispose();
  });

  test('a replacement ref target cancels the previous scope', () => {
    const scopes: MotionScope[] = [];
    let handle!: ReturnType<typeof createMotionScope>;

    const dispose = createRoot((dispose) => {
      handle = createMotionScope({
        setup: (scope) => {
          scopes.push(scope);
        },
      });
      return dispose;
    });

    const first = document.createElement('div');
    const second = document.createElement('div');

    handle.ref(first);
    flush();
    const firstScope = handle.scope()!;
    expect(scopes).toHaveLength(1);

    handle.ref(second);
    flush();

    expect(firstScope.state).toBe('cancelled');
    expect(scopes).toHaveLength(2);
    expect(handle.scope()).not.toBe(firstScope);

    dispose();
    expect(scopes[1]!.state).toBe('cancelled');
  });

  test('matchMedia is passed to Motion and gates setup', () => {
    const media = installMatchMedia(false);
    const setups: MotionScope[] = [];
    let handle!: ReturnType<typeof createMotionScope>;

    const dispose = createRoot((dispose) => {
      handle = createMotionScope({
        matchMedia: { reduce: '(prefers-reduced-motion: reduce)' },
        setup: (scope) => {
          setups.push(scope);
        },
      });
      return dispose;
    });

    handle.ref(document.createElement('div'));
    flush();

    // Motion's scope runs setup only while a condition matches. Nothing matches
    // here, so the scope exists but its body has not run.
    expect(media.matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
    expect(handle.scope()).toBeDefined();
    expect(setups).toHaveLength(0);

    media.set(true);
    // Motion coalesces media changes onto a microtask before refreshing.
    return Promise.resolve().then(() => {
      flush();
      expect(setups).toHaveLength(1);
      dispose();
    });
  });
});
