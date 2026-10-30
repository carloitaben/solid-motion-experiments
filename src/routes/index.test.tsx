import { fireEvent, render } from '@solidjs/testing-library';
import { flush } from 'solid-js';
import { beforeEach, describe, expect, test, vi, type Mock } from 'vitest';

// What the scope looked like at the moment the mock reconciled, i.e. where
// Motion's reconcileAdditions/reconcileRemovals would have looked.
type ReconcileSnapshot = {
  scopeClass: string;
  layoutNodes: number;
  sharedNodes: number;
  heroClass: string | undefined;
  deferredForUpdate: boolean;
};

type TestAnimation = {
  animations: Array<{ state: 'idle' | 'running' }>;
  finished: Promise<never[]>;
  stop: Mock<() => void>;
};

// The route drives Motion's vanilla animateLayout() directly. The mock keeps
// the scheduling that the route's strategy switch exists to expose, which is
// the whole experiment:
//
//   1. animateLayout() only queues a LayoutAnimationBuilder. The update
//      callback runs on a microtask (queueMicrotask(flushPendingBuilders)),
//      after the caller's synchronous work and after anything Solid queued
//      before it.
//   2. A callback that returns nothing is reconciled straight away, in that
//      same microtask; a callback that returns a promise defers the reconcile
//      until the promise resolves (Promise.all(updatePromises).then(commit)).
//   3. The builder settles with the run's animation group once the reconcile
//      has happened. The animation keeps running past that point, which is
//      what the route's cleanup stops when the page is left mid-run.
//   4. A new run stops the animations the previous run left running in the
//      same scope, as Motion does when it starts the new layout animation.
//      Those stopped animations never settle `finished`.
const { animateLayout, snapshots } = vi.hoisted(() => ({
  animateLayout: vi.fn(),
  snapshots: [] as ReconcileSnapshot[],
}));

vi.mock('motion', () => ({ animateLayout }));

import MotionLab from './index';

const installBuilder = () => {
  const finishAnimations: Array<() => void> = [];
  const stops: Array<Mock<() => void>> = [];
  const byScope = new Map<Element, TestAnimation[]>();

  const createAnimation = (): TestAnimation => {
    const child: { state: 'idle' | 'running' } = { state: 'running' };
    const stop = vi.fn(() => {
      child.state = 'idle';
    });
    stops.push(stop);
    return {
      animations: [child],
      finished: new Promise<never[]>((resolveFinished) => {
        finishAnimations.push(() => resolveFinished([]));
      }),
      stop,
    };
  };

  animateLayout.mockImplementation(
    (scope: Element, updateDom: () => void | Promise<void>) => {
      return new Promise<TestAnimation>((resolve, reject) => {
        queueMicrotask(() => {
          let result: void | Promise<void>;
          try {
            result = updateDom();
          } catch (error) {
            reject(error);
            return;
          }

          const commit = (deferredForUpdate: boolean) => {
            snapshots.push({
              scopeClass: scope.className,
              layoutNodes: scope.querySelectorAll('[data-layout], [data-layout-id]')
                .length,
              sharedNodes: scope.querySelectorAll('[data-layout-id]').length,
              heroClass: scope.querySelector('[data-layout-id="hero"]')?.className,
              deferredForUpdate,
            });
            // Starting new layout animations stops the ones the previous run
            // left on the same nodes. Motion's stop never settles `finished`.
            const running = byScope.get(scope) ?? [];
            running.forEach((animation) => {
              if (animation.animations[0]?.state === 'running') animation.stop();
            });
            const animation = createAnimation();
            byScope.set(scope, [...running, animation]);
            resolve(animation);
          };

          if (result && typeof result.then === 'function') {
            result.then(
              () => commit(true),
              (error) => reject(error),
            );
          } else {
            commit(false);
          }
        });
      });
    },
  );

  return {
    resolveAnimations: () => finishAnimations.splice(0).forEach((finish) => finish()),
    stops,
  };
};

// Everything the route does after a click — the deferred update, the
// reconcile, the promise hop and record() — happens on microtasks. flush()
// lets Solid commit its own writes in between, as it does in a browser.
const settle = async () => {
  for (let turn = 0; turn < 12; turn += 1) {
    await Promise.resolve();
    flush();
  }
};

const choose = (radio: HTMLElement) => {
  fireEvent.click(radio);
  flush();
};

beforeEach(() => {
  animateLayout.mockReset();
  snapshots.length = 0;
});

describe('<MotionLab />', () => {
  test('renders the three experiments and one shared element', () => {
    installBuilder();
    const { getByRole, container } = render(() => <MotionLab />);

    expect(getByRole('heading', { name: '1. Layout toggle' })).toBeInTheDocument();
    expect(getByRole('heading', { name: '2. Keyed reorder' })).toBeInTheDocument();
    expect(getByRole('heading', { name: '3. Shared element' })).toBeInTheDocument();
    // Four tiles + their four labels + four chips + the single hero branch
    // currently mounted.
    expect(container.querySelectorAll('[data-layout]')).toHaveLength(13);
    expect(container.querySelectorAll('[data-layout-id="hero"]')).toHaveLength(1);
  });

  test('each toggle tile nests its label as a position layout node', () => {
    // The tile animates its width with a scale transform, which would stretch
    // the text painted inside it. Motion counter-scales only descendants that
    // are layout nodes of their own, and vanilla animateLayout() reads that
    // from data-layout, so the label carries the attribute the text is
    // measured and corrected through.
    installBuilder();
    const { container } = render(() => <MotionLab />);

    const tiles = [...container.querySelectorAll('.motion-lab-tile')];
    expect(tiles).toHaveLength(4);

    tiles.forEach((tile) => {
      expect(tile).toHaveAttribute('data-layout');
      expect(tile.children).toHaveLength(1);
      expect(tile.firstElementChild).toHaveAttribute('data-layout', 'position');
    });
  });

  test('the update callback runs on a microtask, not at the call site', async () => {
    installBuilder();
    const { getByRole, container } = render(() => <MotionLab />);

    fireEvent.click(getByRole('button', { name: 'Rotate' }));

    // Motion has only queued the builder: nothing has mutated or reconciled.
    expect(snapshots).toHaveLength(0);
    expect(container.querySelector('.motion-lab-log')).toBeNull();

    await settle();

    expect(snapshots).toHaveLength(1);
    expect(container.querySelector('.motion-lab-log li')).toHaveTextContent(
      'Keyed reorder → rotate',
    );
  });

  test('every run is a spring transition', async () => {
    installBuilder();
    const { getByRole } = render(() => <MotionLab />);

    fireEvent.click(getByRole('button', { name: 'Rotate' }));
    await settle();

    expect(animateLayout).toHaveBeenCalledTimes(1);
    expect(animateLayout.mock.calls[0]?.[2]).toMatchObject({ type: 'spring' });
  });

  test('the flush strategy commits Solid before Motion reconciles', async () => {
    installBuilder();
    const { getByRole, container } = render(() => <MotionLab />);
    const toggle = container.querySelector('.motion-lab-toggle')!;

    expect(getByRole('radio', { name: /flush/ })).toBeChecked();
    fireEvent.click(getByRole('button', { name: 'Switch to grid' }));
    await settle();

    // The callback called flush(), so Solid's commit was in the DOM when the
    // reconcile read it — and the reconcile saw no promise to wait for.
    expect(snapshots[0]?.scopeClass).toContain('is-grid');
    expect(snapshots[0]?.deferredForUpdate).toBe(false);
    // Four tiles plus the four nested label nodes that carry the text.
    expect(snapshots[0]?.layoutNodes).toBe(8);
    expect(toggle).toHaveClass('is-grid');
  });

  test('batched leaves the DOM for Solid’s microtask, after Motion reconciles', async () => {
    installBuilder();
    const { getByRole, container } = render(() => <MotionLab />);
    const toggle = container.querySelector('.motion-lab-toggle')!;

    choose(getByRole('radio', { name: /batched/ }));
    expect(getByRole('radio', { name: /batched/ })).toBeChecked();

    fireEvent.click(getByRole('button', { name: 'Switch to grid' }));
    await settle();

    // Motion reconciled the old DOM; Solid's commit landed afterwards.
    expect(snapshots[0]?.scopeClass).not.toContain('is-grid');
    expect(snapshots[0]?.deferredForUpdate).toBe(false);
    expect(toggle).toHaveClass('is-grid');
  });

  test('the promise strategy makes Motion wait for Solid’s commit', async () => {
    installBuilder();
    const { getByRole, container } = render(() => <MotionLab />);
    const toggle = container.querySelector('.motion-lab-toggle')!;

    choose(getByRole('radio', { name: /promise/ }));
    fireEvent.click(getByRole('button', { name: 'Switch to grid' }));
    await settle();

    // The callback returned a promise, so Motion deferred its reconcile until
    // Solid had committed: the same DOM Motion sees under flush.
    expect(snapshots[0]?.deferredForUpdate).toBe(true);
    expect(snapshots[0]?.scopeClass).toContain('is-grid');
    expect(toggle).toHaveClass('is-grid');
  });

  test('a run reports the layout it can see when Motion reconciles', async () => {
    installBuilder();
    const { getByRole, container } = render(() => <MotionLab />);

    fireEvent.click(getByRole('button', { name: 'Rotate' }));
    await settle();

    const entry = container.querySelector('.motion-lab-log li');
    expect(entry).toHaveTextContent('Keyed reorder → rotate');
    expect(entry).toHaveTextContent('flush');
    expect(entry).toHaveTextContent('layout nodes: 4');
    expect(entry).toHaveTextContent('shared: 0');
  });

  test('a click during an animation starts a new run instead of waiting', async () => {
    installBuilder();
    const { getByRole, container } = render(() => <MotionLab />);

    fireEvent.click(getByRole('button', { name: 'Rotate' }));
    await settle();

    // The first run has reconciled, but its animation is still running: no
    // animation has been resolved, so nothing has settled.
    expect(animateLayout).toHaveBeenCalledTimes(1);
    expect(getByRole('button', { name: 'Reverse' })).toBeEnabled();

    fireEvent.click(getByRole('button', { name: 'Reverse' }));
    await settle();

    // The second click was accepted while the first animation was in flight.
    expect(animateLayout).toHaveBeenCalledTimes(2);
    const entries = container.querySelectorAll('.motion-lab-log li');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toHaveTextContent('Keyed reorder → reverse');
    expect(entries[1]).toHaveTextContent('Keyed reorder → rotate');
  });

  test('unmounting mid-run stops the animation', async () => {
    const { stops } = installBuilder();
    const { getByRole, unmount } = render(() => <MotionLab />);

    fireEvent.click(getByRole('button', { name: 'Rotate' }));
    await settle();

    expect(stops).toHaveLength(1);
    expect(stops[0]).not.toHaveBeenCalled();

    unmount();

    // The animation is still writing transforms when the page goes away, so
    // it is stopped rather than left running against detached nodes.
    expect(stops[0]).toHaveBeenCalledTimes(1);
  });

  test('unmounting before Motion finalizes still stops the run', async () => {
    const { stops } = installBuilder();
    const { getByRole, unmount, container } = render(() => <MotionLab />);

    fireEvent.click(getByRole('button', { name: 'Rotate' }));
    unmount();
    await settle();

    // The builder landed after disposal: its animation is stopped rather than
    // left running, and nothing is logged for a page that no longer exists.
    expect(stops).toHaveLength(1);
    expect(stops[0]).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.motion-lab-log')).toBeNull();
  });

  test('an animation that finishes leaves the cleanup set', async () => {
    const { resolveAnimations, stops } = installBuilder();
    const { getByRole, unmount } = render(() => <MotionLab />);

    fireEvent.click(getByRole('button', { name: 'Rotate' }));
    await settle();
    resolveAnimations();
    await settle();

    unmount();

    // Settled animations are released as they finish, so leaving the page
    // does not stop them a second time.
    expect(stops[0]).not.toHaveBeenCalled();
  });

  test('an interrupted run is released even though its finished promise never settles', async () => {
    const { stops } = installBuilder();
    const { getByRole, unmount } = render(() => <MotionLab />);

    fireEvent.click(getByRole('button', { name: 'Rotate' }));
    await settle();
    fireEvent.click(getByRole('button', { name: 'Reverse' }));
    await settle();

    // The second run stopped the first one, and a stopped Motion animation
    // never resolves `finished`: only the second run is still writing.
    expect(stops).toHaveLength(2);
    expect(stops[0]).toHaveBeenCalledTimes(1);
    expect(stops[1]).not.toHaveBeenCalled();

    unmount();

    // The interrupted group was pruned from the cleanup set rather than
    // stopped a second time; the run still in flight is stopped.
    expect(stops[0]).toHaveBeenCalledTimes(1);
    expect(stops[1]).toHaveBeenCalledTimes(1);
  });

  test('the shared element: flush reconciles the expanded branch', async () => {
    installBuilder();
    const { getByRole, container } = render(() => <MotionLab />);

    fireEvent.click(getByRole('button', { name: 'Expand' }));
    await settle();

    // Solid's commit ran inside the callback, so the node Motion reconciled is
    // the expanded one, still carrying the single shared id.
    expect(snapshots[0]?.heroClass).toBe('motion-lab-hero is-expanded');
    expect(snapshots[0]?.sharedNodes).toBe(1);
    expect(container.querySelector('.motion-lab-log li')).toHaveTextContent(
      'layout nodes: 1',
    );
    expect(container.querySelector('.motion-lab-log li')).toHaveTextContent(
      'shared: 1',
    );
  });

  test('the shared element: batched reconciles the branch Solid has not replaced yet', async () => {
    installBuilder();
    const { getByRole, container } = render(() => <MotionLab />);

    choose(getByRole('radio', { name: /batched/ }));
    fireEvent.click(getByRole('button', { name: 'Expand' }));
    await settle();

    // Motion reconciled while the collapsed node was still mounted: under
    // batched the shared-element run is one where Motion sees the old branch,
    // not the one Solid is about to put in the DOM.
    expect(snapshots[0]?.heroClass).toBe('motion-lab-hero');
    expect(snapshots[0]?.sharedNodes).toBe(1);
    expect(container.querySelector('[data-layout-id="hero"]')).toHaveClass(
      'is-expanded',
    );
  });
});
