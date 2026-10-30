import { Title } from '@solidjs/meta';
import { animateLayout, type GroupAnimation } from 'motion';
import { For, Show, createSignal, flush, onCleanup } from 'solid-js';

import './index.css';

// Motion's vanilla layout API, driven straight from Solid state: no wrapper
// components, no integration layer. Every animation below is one
// animateLayout(scope, updateDom, transition) call.
//
// The experiment is the update callback. Motion 14.8.0 queues a
// LayoutAnimationBuilder, runs updateDom on that microtask, and reconciles
// added/removed layout nodes in the same pass. Solid 2 commits its own DOM
// writes on a microtask too, so the three strategies below differ in where
// Motion's reconcile lands relative to Solid's commit.
type Strategy = 'flush' | 'batched' | 'promise';

const TILES = ['one', 'two', 'three', 'four'] as const;
const CHIPS = ['alpha', 'bravo', 'charlie', 'delta'] as const;

// Layout animations are springs: they settle into the new layout rather than
// running a fixed-duration tween, and a run interrupted mid-flight hands off to
// the next one from the position it had reached. Motion animates layout through
// a single 0→1 progress value, so this is the spring on that progress.
const LAYOUT_TRANSITION = {
  type: 'spring',
  visualDuration: 0.4,
  bounce: 0.2,
} as const;

type Run = {
  label: string;
  strategy: Strategy;
  targets: number;
  shared: number;
  ms: number;
};

export default function MotionLab() {
  const [strategy, setStrategy] = createSignal<Strategy>('flush');
  const [mode, setMode] = createSignal<'row' | 'grid'>('row');
  const [order, setOrder] = createSignal<string[]>([...CHIPS]);
  const [expanded, setExpanded] = createSignal(false);
  const [runs, setRuns] = createSignal<Run[]>([]);
  let disposed = false;
  // Runs can overlap: each click starts its own builder without waiting for
  // the previous animation. The set only exists so leaving the page can stop
  // whatever is still writing transforms; it is not a lock.
  const animating = new Set<GroupAnimation>();

  let toggleScope: HTMLDivElement | undefined;
  let reorderScope: HTMLDivElement | undefined;
  let heroScope: HTMLDivElement | undefined;

  // What Motion can see in the scope when it finalizes the builder, using the
  // same selector it reconciles: the layout nodes, and how many of them carry
  // a shared (data-layout-id) identity. It describes the scope, not this run's
  // animations.
  const snapshotScope = (scope: HTMLElement) => ({
    targets: scope.querySelectorAll('[data-layout], [data-layout-id]').length,
    shared: scope.querySelectorAll('[data-layout-id]').length,
  });

  const record = (
    label: string,
    runStrategy: Strategy,
    started: number,
    scope: HTMLElement,
  ) => {
    const run: Run = {
      label,
      strategy: runStrategy,
      ...snapshotScope(scope),
      ms: Number((performance.now() - started).toFixed(1)),
    };
    setRuns((previous) => [run, ...previous].slice(0, 6));
  };

  // The experiment variable. `flush()` and the microtask hand-off are both
  // ways to put Solid's DOM commit before Motion's reconcile; `batched`
  // leaves Solid's default microtask alone. The strategy is captured before
  // the click so the callback reads no signals from Motion's microtask.
  const commitUpdate = (
    runStrategy: Strategy,
    mutate: () => void,
  ): void | Promise<void> => {
    if (runStrategy === 'flush') {
      mutate();
      flush();
      return;
    }
    if (runStrategy === 'promise') {
      return new Promise<void>((resolve) => {
        mutate();
        queueMicrotask(resolve);
      });
    }
    mutate();
  };

  // Motion keeps layout animations running past the builder's promise, so
  // each group is held until it settles. A group that a later run interrupts
  // never settles: Motion stops a node's previous animation when a new run
  // targets it, and a stopped animation leaves `finished` pending. So before
  // adding a group, drop the tracked ones that have nothing running left.
  // That keeps the set to what is actually writing transforms without waiting
  // on an interruption. Any live group stays, so cleanup still stops it.
  const isRunning = (animation: GroupAnimation) =>
    animation.animations.some((child) => child.state === 'running');

  const track = (animation: GroupAnimation) => {
    animating.forEach((tracked) => {
      if (!isRunning(tracked)) animating.delete(tracked);
    });
    animating.add(animation);
    const release = () => animating.delete(animation);
    animation.finished.then(release, release);
  };

  // Leaving the page mid-run: stop whatever is still writing transforms, so no
  // animation outlives the nodes it is animating.
  onCleanup(() => {
    disposed = true;
    animating.forEach((animation) => animation.stop());
    animating.clear();
  });

  const runExperiment = (
    scope: HTMLElement,
    label: string,
    updateDom: () => void,
  ) => {
    const strategyForRun = strategy();
    const started = performance.now();
    animateLayout(
      scope,
      () => commitUpdate(strategyForRun, updateDom),
      LAYOUT_TRANSITION,
    )
      .then((animation) => {
        // Unmounted before Motion finalized: nothing to log, and the animation
        // would otherwise keep writing to nodes the page no longer owns.
        if (disposed) {
          animation.stop();
          return;
        }
        track(animation);
        record(label, strategyForRun, started, scope);
      })
      .catch(() => {
        // Motion rejects the builder when its update callback throws. The
        // strategies here cannot, so there is nothing to record.
      });
  };

  const runToggle = () => {
    const scope = toggleScope;
    if (!scope) return;
    const next = mode() === 'row' ? 'grid' : 'row';
    runExperiment(scope, `Layout toggle → ${next}`, () => setMode(next));
  };

  const runReorder = (label: string, next: (current: string[]) => string[]) => {
    const scope = reorderScope;
    if (!scope) return;
    runExperiment(scope, label, () => setOrder(next));
  };

  const runHero = () => {
    const scope = heroScope;
    if (!scope) return;
    const next = !expanded();
    runExperiment(scope, `Shared element → ${next ? 'expanded' : 'collapsed'}`, () =>
      setExpanded(next),
    );
  };

  return (
    <main class="motion-lab">
      <Title>Motion layout lab</Title>
      <h1>Motion layout lab</h1>
      <p class="motion-lab-lede">
        Motion 14.8.0's vanilla <code>animateLayout()</code> over Solid 2
        signals. Every button runs one spring animation, and pressing again
        mid-flight starts a new run instead of waiting: Motion re-measures the
        scope and animates from wherever the previous run had reached.
      </p>

      <fieldset class="motion-lab-strategy">
        <legend>Update strategy</legend>
        <label>
          <input
            type="radio"
            name="motion-lab-strategy"
            checked={strategy() === 'flush'}
            onChange={() => setStrategy('flush')}
          />
          <code>flush()</code> inside the callback
        </label>
        <label>
          <input
            type="radio"
            name="motion-lab-strategy"
            checked={strategy() === 'batched'}
            onChange={() => setStrategy('batched')}
          />
          batched (Solid's microtask)
        </label>
        <label>
          <input
            type="radio"
            name="motion-lab-strategy"
            checked={strategy() === 'promise'}
            onChange={() => setStrategy('promise')}
          />
          promise hand-off (microtask)
        </label>
        <p>
          Motion runs the update callback, then reconciles added and removed
          layout nodes synchronously in that same microtask — before Solid's
          DOM write. Returning a promise from the callback defers that
          reconcile until it resolves: the hand-off Motion's builder supports
          for renderers with a commit lifecycle.
        </p>
        <p>
          The log records each run when Motion finalizes it: how many layout
          nodes and shared nodes were in the scope at that moment, and how long
          the click took to get there. It is a snapshot of the scope, not a
          count of that run's animations. Under <code>batched</code> the
          shared-element case is the clearest difference: Motion reconciles the
          branch Solid has not replaced yet, while <code>flush</code> and{' '}
          <code>promise</code> hand it the committed one.
        </p>
      </fieldset>

      <section class="motion-lab-panel" aria-labelledby="motion-lab-toggle">
        <h2 id="motion-lab-toggle">1. Layout toggle</h2>
        <p>
          One container, four <code>data-layout</code> tiles. The state change
          swaps a flex row for a two-column grid, so each tile's width is
          animated with a scale transform. The label inside each tile is its own
          nested layout node, <code>data-layout="position"</code>: Motion
          counter-scales it, so the text keeps its shape while the tile
          stretches. <code>position</code> is the right mode for the label
          because its own size never changes, only where it sits.
        </p>
        <div class="motion-lab-toolbar">
          <button type="button" onClick={runToggle}>
            {mode() === 'row' ? 'Switch to grid' : 'Switch to row'}
          </button>
          <output>mode: {mode()}</output>
        </div>
        <div
          class={['motion-lab-toggle', { 'is-grid': mode() === 'grid' }]}
          ref={(element) => (toggleScope = element)}
        >
          <For each={TILES}>
            {(tile) => (
              <div class="motion-lab-tile" data-layout>
                <span data-layout="position">{tile}</span>
              </div>
            )}
          </For>
        </div>
      </section>

      <section class="motion-lab-panel" aria-labelledby="motion-lab-reorder">
        <h2 id="motion-lab-reorder">2. Keyed reorder</h2>
        <p>
          The same four DOM nodes in a new order. Solid's keyed{' '}
          <code>&lt;For&gt;</code> keeps the element identity, so Motion
          animates the move instead of re-mounting.
        </p>
        <div class="motion-lab-toolbar">
          <button
            type="button"
            onClick={() =>
              runReorder('Keyed reorder → rotate', (current) => [
                current[current.length - 1]!,
                ...current.slice(0, -1),
              ])
            }
          >
            Rotate
          </button>
          <button
            type="button"
            onClick={() =>
              runReorder('Keyed reorder → reverse', (current) => [...current].reverse())
            }
          >
            Reverse
          </button>
          <output>order: {order().join(' · ')}</output>
        </div>
        <div class="motion-lab-reorder" ref={(element) => (reorderScope = element)}>
          <For each={order()}>
            {(chip) => (
              <div class="motion-lab-chip" data-layout>
                {chip}
              </div>
            )}
          </For>
        </div>
      </section>

      <section class="motion-lab-panel" aria-labelledby="motion-lab-shared">
        <h2 id="motion-lab-shared">3. Shared element</h2>
        <p>
          A card that swaps between a small tile and a full-width panel. Both
          branches carry <code>data-layout-id="hero"</code>, but only one is
          ever in the DOM: Motion measures the outgoing node in the snapshot it
          takes before the update, then adopts the replacement at reconcile and
          hands it that snapshot.
        </p>
        <div class="motion-lab-toolbar">
          <button type="button" onClick={runHero}>
            {expanded() ? 'Collapse' : 'Expand'}
          </button>
          <output>state: {expanded() ? 'expanded' : 'collapsed'}</output>
        </div>
        <div class="motion-lab-hero-slot" ref={(element) => (heroScope = element)}>
          <Show
            when={!expanded()}
            fallback={
              <div class="motion-lab-hero is-expanded" data-layout data-layout-id="hero">
                <span>Hero</span>
                <small>shared element, expanded</small>
              </div>
            }
          >
            <div class="motion-lab-hero" data-layout data-layout-id="hero">
              <span>Hero</span>
              <small>shared element</small>
            </div>
          </Show>
        </div>
      </section>

      <section class="motion-lab-panel" aria-labelledby="motion-lab-runs">
        <h2 id="motion-lab-runs">Runs</h2>
        <Show
          when={runs().length > 0}
          fallback={<p class="motion-lab-empty">No runs yet. Press a button above.</p>}
        >
          <ol class="motion-lab-log" aria-live="polite">
            <For each={runs()}>
              {(run) => (
                <li>
                  <span class="motion-lab-log-label">{run.label}</span>
                  <code>{run.strategy}</code>
                  <span class="motion-lab-log-stats">
                    layout nodes: {run.targets} · shared: {run.shared} · reconciled
                    in {run.ms}ms
                  </span>
                </li>
              )}
            </For>
          </ol>
        </Show>
      </section>
    </main>
  );
}
