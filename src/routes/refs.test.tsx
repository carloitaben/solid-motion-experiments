import { fireEvent, render } from '@solidjs/testing-library';
import { flush } from 'solid-js';
import { beforeEach, describe, expect, test, vi, type Mock } from 'vitest';

// What the reorder scope held when the mock reconciled, i.e. after the update
// callback returned and before the builder settled.
type Commit = {
  firstChip: string | undefined;
};

type TestAnimation = {
  animations: Array<{ state: 'idle' | 'running' }>;
  finished: Promise<never[]>;
  stop: Mock<() => void>;
};

// The route drives Motion's vanilla animateLayout() and binds style values with
// styleEffect(). The mock keeps the two things the route depends on:
//
//   1. animateLayout() queues the builder and runs updateDom on a microtask.
//      The route's update callback calls flush(), so the DOM is committed when
//      the reconcile sees it — the same boundary as the main lab's `flush`
//      strategy.
//   2. A new run in the same scope stops the animations the previous run left
//      running, and those never settle `finished`. That is what the scope's
//      cleanup set has to prune around.
//
// styleEffect() is mocked because jsdom has no layout and no projection
// renderer: the real correction is a browser observation, not a unit test.
const { animateLayout, styleEffect, commits } = vi.hoisted(() => ({
  animateLayout: vi.fn(),
  styleEffect: vi.fn(),
  commits: [] as Commit[],
}));

vi.mock('motion', () => ({
  animateLayout,
  styleEffect,
  motionValue: (initial: unknown) => {
    let current = initial;
    return {
      get: () => current,
      set: (next: unknown) => {
        current = next;
      },
    };
  },
}));

import RefsLab from './refs';

const installMotion = () => {
  const disposers: Mock[] = [];
  const stops: Mock[] = [];
  const finished: Array<() => void> = [];
  const byScope = new Map<Element, TestAnimation[]>();

  styleEffect.mockImplementation(() => {
    const dispose = vi.fn();
    disposers.push(dispose);
    return dispose;
  });

  animateLayout.mockImplementation(
    (scope: Element, updateDom: () => void | Promise<void>) =>
      new Promise<TestAnimation>((resolve, reject) => {
        queueMicrotask(() => {
          try {
            updateDom();
          } catch (error) {
            reject(error);
            return;
          }

          commits.push({
            firstChip:
              scope.querySelector('.refs-chip')?.textContent ?? undefined,
          });

          // Starting a new layout animation stops the previous one on the
          // same nodes. A stopped Motion animation never settles `finished`.
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
    disposers,
    stops,
    resolveAnimations: () => finished.splice(0).forEach((finish) => finish()),
  };
};

// The click, the deferred update, the reconcile, the promise hop and the log
// write all land on microtasks. flush() lets Solid commit in between, as it
// does in a browser.
const settle = async () => {
  for (let turn = 0; turn < 12; turn += 1) {
    await Promise.resolve();
    flush();
  }
};

beforeEach(() => {
  animateLayout.mockReset();
  styleEffect.mockReset();
  commits.length = 0;
});

describe('<RefsLab />', () => {
  test('renders the scope experiment and one shared node per binding', () => {
    installMotion();
    const { getByRole, container } = render(() => <RefsLab />);

    expect(
      getByRole('heading', { name: '1. Scope ref, explicit update boundary' }),
    ).toBeInTheDocument();
    expect(
      getByRole('heading', { name: '2. Shared element, border-radius handoff' }),
    ).toBeInTheDocument();
    expect(container.querySelectorAll('[data-layout-id]')).toHaveLength(3);
    // Four chips + their four labels + the three hero branches currently
    // mounted and their two labels each.
    expect(container.querySelectorAll('[data-layout]')).toHaveLength(17);
  });

  test('chips and both shared-element branches nest their text as position nodes', () => {
    installMotion();
    const { container } = render(() => <RefsLab />);

    const chips = [...container.querySelectorAll('.refs-chip')];
    expect(chips).toHaveLength(4);
    chips.forEach((chip) => {
      expect(chip).toHaveAttribute('data-layout');
      expect(chip).not.toHaveAttribute('data-layout', 'position');
      expect(chip.children).toHaveLength(1);
      expect(chip.firstElementChild).toHaveAttribute('data-layout', 'position');
      expect(chip.firstElementChild?.textContent).toBe(chip.textContent);
    });

    const heroes = [...container.querySelectorAll('.refs-hero')];
    expect(heroes).toHaveLength(3);
    heroes.forEach((hero) => {
      expect(hero).toHaveAttribute('data-layout');
      expect(hero).not.toHaveAttribute('data-layout', 'position');
      expect(hero).toHaveAttribute('data-layout-id');
      expect(hero.children).toHaveLength(2);
      expect(
        [...hero.children].every(
          (node) => node.getAttribute('data-layout') === 'position',
        ),
      ).toBe(true);
    });
  });

  test('binds only the px and rem branches, and leaves the CSS one alone', () => {
    installMotion();
    const { container } = render(() => <RefsLab />);

    const calls = styleEffect.mock.calls as Array<
      [HTMLElement, Record<string, { get: () => unknown }>]
    >;
    expect(calls).toHaveLength(2);

    const ids = calls.map(([element]) => element.dataset.layoutId);
    expect(ids).toEqual(['hero-px', 'hero-rem']);
    expect(calls[0]?.[1]?.borderRadius?.get()).toBe(9.6);
    expect(calls[1]?.[1]?.borderRadius?.get()).toBe('0.6rem');

    expect(container.querySelector('[data-layout-id="hero-none"]')).toBeTruthy();
  });

  test('replacing the shared branch binds the new element and releases the old binding', async () => {
    const { disposers } = installMotion();
    const { getAllByRole } = render(() => <RefsLab />);

    // The px card is the second Expand button.
    fireEvent.click(getAllByRole('button', { name: 'Expand' })[1]!);
    await settle();

    expect(styleEffect).toHaveBeenCalledTimes(3);
    expect(disposers).toHaveLength(3);
    // The collapsed px element was replaced, so its binding (the first
    // styleEffect call) was disposed. The rem branch was untouched.
    expect(disposers[0]).toHaveBeenCalledTimes(1);
    expect(disposers[1]).not.toHaveBeenCalled();
    expect(disposers[2]).not.toHaveBeenCalled();
  });

  test('the update boundary commits Solid before Motion reconciles', async () => {
    installMotion();
    const { getByRole, container } = render(() => <RefsLab />);
    const order = () => container.querySelector('.refs-lab-toolbar output')!;

    fireEvent.click(getByRole('button', { name: 'Rotate' }));

    // Motion has only queued the builder: the callback has not run.
    expect(commits).toHaveLength(0);
    expect(order()).toHaveTextContent('alpha');

    await settle();

    // By the time the mock reconciles, flush() has put the rotated order in
    // the DOM, so the pre-snapshot and post-snapshot scopes differ.
    expect(commits).toHaveLength(1);
    expect(commits[0]?.firstChip).toBe('delta');
    expect(order()).toHaveTextContent('delta · alpha · bravo · charlie');
    expect(container.querySelector('.refs-log li')).toHaveTextContent(
      'Reorder → rotate',
    );
  });

  test('a second update during a run is accepted and reports the group in flight', async () => {
    installMotion();
    const { getByRole, container } = render(() => <RefsLab />);

    fireEvent.click(getByRole('button', { name: 'Rotate' }));
    await settle();
    fireEvent.click(getByRole('button', { name: 'Reverse' }));
    await settle();

    // No lock: the second update started while the first animation was still
    // writing, and the log says one group was in flight when it was queued.
    expect(animateLayout).toHaveBeenCalledTimes(2);
    const entries = container.querySelectorAll('.refs-log li');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toHaveTextContent('Reorder → reverse');
    expect(entries[0]).toHaveTextContent('in flight at update: 1');
    expect(entries[1]).toHaveTextContent('in flight at update: 0');
  });

  test('leaving the page stops the running animation and disposes the bindings', async () => {
    const { disposers, stops } = installMotion();
    const { getByRole, unmount } = render(() => <RefsLab />);

    fireEvent.click(getByRole('button', { name: 'Rotate' }));
    await settle();

    expect(stops).toHaveLength(1);
    expect(stops[0]).not.toHaveBeenCalled();

    unmount();

    // onCleanup was registered in the composables' setup half, not returned
    // from the ref callbacks, so it is what stops the run and unbinds the
    // value refs.
    expect(stops[0]).toHaveBeenCalledTimes(1);
    expect(disposers).toHaveLength(2);
    expect(disposers[0]).toHaveBeenCalledTimes(1);
    expect(disposers[1]).toHaveBeenCalledTimes(1);
  });

  test('a builder that settles after unmount is stopped and not logged', async () => {
    const { stops } = installMotion();
    const { getByRole, unmount, container } = render(() => <RefsLab />);

    fireEvent.click(getByRole('button', { name: 'Rotate' }));
    unmount();
    await settle();

    expect(stops).toHaveLength(1);
    expect(stops[0]).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.refs-log')).toBeNull();
  });

  test('a settled animation is released from the cleanup set', async () => {
    const { resolveAnimations, stops } = installMotion();
    const { getByRole, unmount } = render(() => <RefsLab />);

    fireEvent.click(getByRole('button', { name: 'Rotate' }));
    await settle();
    resolveAnimations();
    await settle();
    unmount();

    expect(stops[0]).not.toHaveBeenCalled();
  });

  test('a bound value can be driven from the card', () => {
    installMotion();
    const { getAllByRole } = render(() => <RefsLab />);
    const values = styleEffect.mock.calls[0]?.[1] as {
      borderRadius: { get: () => unknown };
    };

    fireEvent.click(getAllByRole('button', { name: 'thicker radius' })[0]!);
    flush();

    expect(values.borderRadius.get()).toBe(24);
    expect(getAllByRole('button', { name: 'base radius' })).toHaveLength(1);
  });
});
