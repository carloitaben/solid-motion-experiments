import { Title } from '@solidjs/meta';
import {
  animateLayout,
  motionValue,
  styleEffect,
  type GroupAnimation,
  type MotionValue,
} from 'motion';
import { For, Show, createSignal, flush, onCleanup } from 'solid-js';

import { paths } from '../router';
import './refs.css';

// This page looks at the two seams the main lab leaves implicit:
//
//   1. Where the update boundary lives. The lab on `/` calls animateLayout()
//      from a click handler and keeps the scope element in a `let`. Here the
//      scope is a ref: a composable owns the element, the animation set and
//      the cleanup, and hands back one function that is the only way to
//      mutate it.
//   2. What a MotionValue bound to the scope element does to a shared-element
//      layout animation. styleEffect() is the public way to bind a value;
//      animateLayout() picks the values up when it creates its visual element
//      for that node. The hero cards below compare binding nothing, a px
//      radius and a rem radius.
//
// Both refs are written the same way Solid 2 wants them: the setup half runs
// under the component owner (where onCleanup works and no DOM is touched), the
// returned callback runs with no owner (`runWithOwner(null)` in @solidjs/web),
// so it writes DOM state and nothing else. A cleanup returned from a ref
// callback is dropped, which is why nothing below returns one.

const SPRING = {
  type: 'spring',
  visualDuration: 0.4,
  bounce: 0.2,
} as const;

type Spring = typeof SPRING;

type Run = {
  label: string;
  /** Groups still animating when this update was queued. */
  inFlight: number;
  ms: number;
};

type LayoutScopeOptions = {
  transition?: Spring;
  onRun?: (run: Run) => void;
};

// The scope-ref composable. Everything is set up once, under the owner:
// the element slot, the set of groups still writing transforms, and the
// cleanup that stops them. `update()` is the explicit boundary — Motion
// snapshots the scope on its microtask, `updateDom` mutates and calls
// flush() so Solid's DOM write lands before Motion reconciles, and the
// builder settles into an animation that runs on.
//
// Shapes considered, all local to this file:
//
//   const [ref, update] = createLayoutScope()   tuple — same thing, one fewer name
//   update(scopeElement(), mutate)              free function — no owner to clean up from
//   <LayoutScope onUpdate>…</LayoutScope>       component — hides the element, and the
//                                               vanilla API exists to avoid that boundary
//
// The object form keeps the element slot and the cleanup under one owner. The
// composable imports only solid-js and motion, so lifting it into a module
// later is mechanical.
function createLayoutScope(options: LayoutScopeOptions = {}) {
  const transition = options.transition ?? SPRING;
  let element: HTMLElement | undefined;
  let disposed = false;
  // Overlapping runs are allowed: each update starts its own builder without
  // waiting. The set exists to stop whatever is still writing when the page
  // goes away, not to serialise updates.
  const animating = new Set<GroupAnimation>();

  onCleanup(() => {
    disposed = true;
    animating.forEach((animation) => animation.stop());
    animating.clear();
  });

  const isRunning = (animation: GroupAnimation) =>
    animation.animations.some((child) => child.state === 'running');

  // A group interrupted by a later run never settles: Motion stops the
  // previous animation when the new one starts, and a stopped animation
  // leaves `finished` pending. Drop those before tracking the new group so
  // cleanup only holds runs that are still writing.
  const track = (animation: GroupAnimation) => {
    animating.forEach((tracked) => {
      if (!isRunning(tracked)) animating.delete(tracked);
    });
    animating.add(animation);
    const release = () => animating.delete(animation);
    animation.finished.then(release, release);
  };

  const update = (mutate: () => void, label: string) => {
    const scope = element;
    // No scope element: on the server, or a ref that has not attached yet.
    // The state change still has to happen, there is simply nothing to
    // animate, so the mutation runs on its own.
    if (!scope) {
      mutate();
      return;
    }

    const inFlight = [...animating].filter(isRunning).length;
    const started = performance.now();
    animateLayout(
      scope,
      () => {
        mutate();
        // Same boundary the main lab uses as its baseline: Solid writes the
        // DOM now, so Motion reconciles the committed branch.
        flush();
      },
      transition,
    )
      .then((animation) => {
        // Unmounted before Motion finalised: do not log, and stop the run
        // rather than let it write to nodes the page no longer owns.
        if (disposed) {
          animation.stop();
          return;
        }
        track(animation);
        options.onRun?.({
          label,
          inFlight,
          ms: Number((performance.now() - started).toFixed(1)),
        });
      })
      .catch(() => {
        // Motion rejects the builder when updateDom throws. This one cannot.
      });
  };

  // Apply phase: record the element. No owner, no cleanup, no reactive read.
  const ref = (next: HTMLElement) => {
    element = next;
  };

  return { ref, update };
}

// A style-binding ref. `values` are MotionValues created by the caller under
// its owner, so they outlive element swaps. The setup half only holds the
// binding slot and cleans it up with the component; the apply half binds the
// element it is given. Rebinding a second branch disposes the first binding —
// by then animateLayout has already taken that value into its visual element,
// so the old branch keeps nothing that the new one needs.
function createStyleRef(values: Record<string, MotionValue>) {
  let element: HTMLElement | undefined;
  let dispose: (() => void) | undefined;

  onCleanup(() => {
    dispose?.();
    dispose = undefined;
    element = undefined;
  });

  return (next: HTMLElement) => {
    if (next === element) return;
    dispose?.();
    element = next;
    dispose = styleEffect(next, values);
  };
}

// 0.6rem at the default 16px root. Motion's radius corrector only converts
// px (numbers or `Npx` strings) to a percentage of the projected box; any
// other unit is passed through untouched, which is what the third card shows.
const HERO_RADIUS_PX = 9.6;

type HeroBinding = {
  id: 'none' | 'px' | 'rem';
  radius: number | string | undefined;
  label: string;
};

const HERO_BINDINGS: readonly HeroBinding[] = [
  { id: 'none', radius: undefined, label: 'no binding' },
  { id: 'px', radius: HERO_RADIUS_PX, label: `borderRadius: ${HERO_RADIUS_PX}` },
  { id: 'rem', radius: '0.6rem', label: "borderRadius: '0.6rem'" },
];

const CHIPS = ['alpha', 'bravo', 'charlie', 'delta'] as const;

type RadiusSample = {
  ms: number;
  inline: string;
  scale: string;
  corrected: boolean;
  /** How far the element scale is from 1: the frames worth keeping. */
  deviation: number;
};

// Projection writes the four corner properties, not the shorthand.
const readInlineRadius = (element: HTMLElement) =>
  element.style.getPropertyValue('border-top-left-radius') ||
  element.style.borderRadius;

// The last scale in the projection transform is the element scale.
const readScale = (transform: string) => {
  const match = transform.match(/scale\(([^)]*)\)/g)?.at(-1);
  if (!match) return { text: '—', deviation: 0 };
  const text = match.slice('scale('.length, -1);
  const [x = 1, y = x] = text.split(',').map(Number);
  return { text, deviation: Math.max(Math.abs(x - 1), Math.abs(y - 1)) };
};

// Sample one shared-element run for ~1.2s: the spring's tail is longer than
// its visualDuration, so the last frame is close to the settled state. The rAF
// handle lives in the hero's setup scope so leaving the page cancels it (a
// click handler has no owner).
const SAMPLE_MS = 1200;

// Solid calls the ref value directly, so an optional ref has to be a function
// even when there is nothing to bind — `ref={undefined}` throws.
const noRef = () => {};

export default function RefsLab() {
  const [runs, setRuns] = createSignal<Run[]>([]);
  const record = (run: Run) => setRuns((previous) => [run, ...previous].slice(0, 6));

  const [order, setOrder] = createSignal<string[]>([...CHIPS]);
  const reorder = createLayoutScope({ onRun: record });

  return (
    <main class="refs-lab">
      <Title>Motion refs lab</Title>
      <h1>Motion refs lab</h1>
      <p class="refs-lab-lede">
        Two composables built from plain Solid 2 primitives, one Motion call
        each. A layout scope is attached with a ref and mutated through one
        explicit update function; a shared element's border radius is bound
        with a Motion <code>styleEffect()</code> ref and compared against doing
        nothing.
      </p>
      <p class="refs-lab-lede">
        Back to the <a href={paths()}>layout lab</a>.
      </p>

      <section class="refs-lab-panel" aria-labelledby="refs-scope">
        <h2 id="refs-scope">1. Scope ref, explicit update boundary</h2>
        <p>
          <code>createLayoutScope()</code> returns <code>{'{ ref, update }'}</code>.
          The ref is only a slot for the element; every change goes through{' '}
          <code>update(mutate, label)</code>, which is where Motion snapshots
          the scope, Solid commits (<code>flush()</code>), and the builder is
          tracked for cleanup. Click twice quickly: updates are not queued, so
          the second run starts from wherever the first had reached and the log
          records how many groups were still writing. Each chip's text is its
          own <code>data-layout="position"</code> node, so the same rule the
          tiles use applies here too.
        </p>
        <div class="refs-lab-toolbar">
          <button
            type="button"
            onClick={() =>
              reorder.update(
                () =>
                  setOrder((current) => [
                    current[current.length - 1]!,
                    ...current.slice(0, -1),
                  ]),
                'Reorder → rotate',
              )
            }
          >
            Rotate
          </button>
          <button
            type="button"
            onClick={() =>
              reorder.update(
                () => setOrder((current) => [...current].reverse()),
                'Reorder → reverse',
              )
            }
          >
            Reverse
          </button>
          <output>order: {order().join(' · ')}</output>
        </div>
        <div class="refs-chips" ref={reorder.ref}>
          <For each={order()}>
            {(chip) => (
              <div class="refs-chip" data-layout>
                <span data-layout="position">{chip}</span>
              </div>
            )}
          </For>
        </div>
      </section>

      <section class="refs-lab-panel" aria-labelledby="refs-handoff">
        <h2 id="refs-handoff">2. Shared element, border-radius handoff</h2>
        <p>
          Three copies of the same shared element. In every card the collapsed
          and expanded branches carry the same <code>data-layout-id</code> and
          swap through a layout scope. They differ only in what{' '}
          <code>styleEffect()</code> binds to the node: nothing, a px radius, or
          the same radius as <code>0.6rem</code>. Inside both branches the text
          is nested as <code>data-layout="position"</code> nodes, so the shared
          box's projection counter-scales the copy instead of stretching it.
        </p>
        <p>
          animateLayout() creates a visual element for a layout node and takes
          any values already bound to that element into it. For a shared
          element the old node's values become the start of the blend and the
          new node's the end, so a bound radius lands in the projection
          renderer's latest values — the condition Motion's scale corrector
          checks before it rewrites <code>border-radius</code> as a percentage
          of the projected box. The readout keeps the frame furthest into the
          projection (<code>mid-run</code>) and the last sampled frame; after
          the run a later render restores the bound value.
        </p>
        <p>
          Only a px radius is safe. The shared blend parses both radii with{' '}
          <code>parseFloat</code> before the corrector sees them, so the{' '}
          <code>rem</code> card reaches the corrector as the number{' '}
          <code>0.6</code>, which it treats as 0.6px: its corners nearly square
          off during the run. Binding nothing leaves the CSS radius to be
          squashed by the projection transform, which is the jump the main lab
          describes.
        </p>
        <div class="refs-hero-grid">
          <For each={HERO_BINDINGS}>
            {(binding) => {
              const scope = createLayoutScope({ onRun: record });
              const [expanded, setExpanded] = createSignal(false);
              const [mid, setMid] = createSignal<RadiusSample>();
              const [lastSample, setLastSample] = createSignal<RadiusSample>();
              const radius =
                binding.radius === undefined
                  ? undefined
                  : motionValue(binding.radius);
              const heroRef =
                radius === undefined
                  ? noRef
                  : createStyleRef({ borderRadius: radius });
              const [thick, setThick] = createSignal(false);
              const thicker = binding.id === 'rem' ? '1.5rem' : 24;
              const layoutId = `hero-${binding.id}`;
              let slot: HTMLDivElement | undefined;
              let frame = 0;

              // onCleanup also runs when the server disposes its render, where
              // there is no animation frame to cancel.
              onCleanup(() => {
                if (typeof cancelAnimationFrame === 'function') {
                  cancelAnimationFrame(frame);
                }
              });

              // Keep the frame that is furthest into the projection (the one
              // where a corrected radius is visibly doing its job) and the
              // last frame (what the element settles back to). The rAF handle
              // lives in this setup scope so leaving the page cancels it.
              const sampleRun = () => {
                const scopeElement = slot;
                if (!scopeElement) return;
                cancelAnimationFrame(frame);
                const started = performance.now();
                let best: RadiusSample | undefined;
                let bestCorrected: RadiusSample | undefined;
                let last: RadiusSample | undefined;
                const tick = () => {
                  const hero = scopeElement.querySelector<HTMLElement>(
                    '[data-layout-id]',
                  );
                  if (hero) {
                    const inline = readInlineRadius(hero);
                    const scale = readScale(hero.style.transform);
                    const sample: RadiusSample = {
                      ms: Math.round(performance.now() - started),
                      inline,
                      scale: scale.text,
                      corrected: inline.includes('%'),
                      deviation: scale.deviation,
                    };
                    last = sample;
                    if (!best || sample.deviation > best.deviation) best = sample;
                    if (
                      sample.corrected &&
                      (!bestCorrected || sample.deviation > bestCorrected.deviation)
                    ) {
                      bestCorrected = sample;
                    }
                    setMid(bestCorrected ?? best);
                  }
                  if (performance.now() - started < SAMPLE_MS) {
                    frame = requestAnimationFrame(tick);
                  } else {
                    setLastSample(last);
                  }
                };
                frame = requestAnimationFrame(tick);
              };

              const toggle = () => {
                const next = !expanded();
                scope.update(
                  () => setExpanded(next),
                  `Hero ${binding.id} → ${next ? 'expanded' : 'collapsed'}`,
                );
                setMid(undefined);
                setLastSample(undefined);
                sampleRun();
              };

              // After animateLayout has adopted the node, the value lives on
              // its visual element instead of the style effect. Setting it is
              // then a direct write through the renderer, which is the other
              // half of the handoff: the value stays drivable.
              const toggleThickness = () => {
                if (!radius) return;
                const next = !thick();
                setThick(next);
                radius.set(next ? thicker : binding.radius!);
              };

              return (
                <article class="refs-hero-card">
                  <div class="refs-lab-toolbar">
                    <button type="button" onClick={toggle}>
                      {expanded() ? 'Collapse' : 'Expand'}
                    </button>
                    <Show when={radius}>
                      <button type="button" onClick={toggleThickness}>
                        {thick() ? 'base radius' : 'thicker radius'}
                      </button>
                    </Show>
                    <code>{binding.label}</code>
                  </div>
                  <div
                    class="refs-hero-slot"
                    ref={[scope.ref, (element) => (slot = element)]}
                  >
                    <Show
                      when={!expanded()}
                      fallback={
                        <div
                          class="refs-hero is-expanded"
                          data-layout
                          data-layout-id={layoutId}
                          ref={heroRef}
                        >
                          <span data-layout="position">Hero</span>
                          <small data-layout="position">{binding.label}</small>
                        </div>
                      }
                    >
                      <div
                        class="refs-hero"
                        data-layout
                        data-layout-id={layoutId}
                        ref={heroRef}
                      >
                        <span data-layout="position">Hero</span>
                        <small data-layout="position">{binding.label}</small>
                      </div>
                    </Show>
                  </div>
                  <output class="refs-readout">
                    <Show
                      when={mid()}
                      fallback={<span>inline radius: — (no run yet)</span>}
                    >
                      <span>
                        mid-run: <code>{mid()!.inline || 'no inline radius'}</code>{' '}
                        at {mid()!.ms}ms · scale {mid()!.scale} · corrected:{' '}
                        {mid()!.corrected ? 'yes' : 'no'}
                      </span>
                      <Show when={lastSample()}>
                        <span>
                          {' '}
                          · last sample: <code>{lastSample()!.inline || 'none'}</code>
                        </span>
                      </Show>
                    </Show>
                  </output>
                </article>
              );
            }}
          </For>
        </div>
      </section>

      <section class="refs-lab-panel" aria-labelledby="refs-runs">
        <h2 id="refs-runs">Runs</h2>
        <Show
          when={runs().length > 0}
          fallback={<p class="refs-lab-empty">No runs yet. Press a button above.</p>}
        >
          <ol class="refs-log" aria-live="polite">
            <For each={runs()}>
              {(run) => (
                <li>
                  <span class="refs-log-label">{run.label}</span>
                  <span class="refs-log-stats">
                    in flight at update: {run.inFlight} · finalised in {run.ms}ms
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
