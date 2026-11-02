import { Title } from '@solidjs/meta';
import {
  HTMLVisualElement,
  animateElement,
  animateLayout,
  buildHTMLStyles,
  camelToDash,
  getValueTransition,
  hover,
  press,
  visualElementStore,
  type AnimationPlaybackControlsWithThen,
  type GroupAnimation,
  type EffectKeyframes,
  type HTMLRenderState,
  type MotionNodeOptions,
  type MotionValue,
  type TargetAndTransition,
  type Transition,
} from 'motion';
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  flush,
  omit,
  onCleanup,
  onSettled,
  untrack,
  type Component,
} from 'solid-js';
import { applyRef, dynamic, type JSX } from '@solidjs/web';

import { createMotionValue, createMotionValueAccessor } from '../lib/motion-value';
import { paths } from '../router';
import './motion.css';

// This page is a spike for a `motion.*` component API written against the
// vanilla engine, not against `motion/react`. The component factory and the
// layout boundary live in this file so the whole idea can be read (and judged)
// at once. The one piece this route shares with the rest of the app is value
// ownership: `src/lib/motion-value.ts` is where a MotionValue's lifetime meets
// Solid's, so the page does not hand-roll either half.
//
// Three decisions shape it:
//
//   1. Features are composed per element, at module scope. A motion element is
//      `createMotionElement('div', [animateFeature, hoverFeature])`; the
//      component body knows nothing about `animate`, hover or press. A page
//      that never names a feature never bundles or runs it, which is the
//      tree-shaking half of the argument. `motion/react` attaches every
//      feature to every `<motion.*>` instead. The prop surface follows the
//      features: an element accepts only the own props its features read (plus
//      the ones the factory owns itself), and every reserved name is stripped
//      from the spread whether or not this element installs the feature.
//   2. The layout boundary is explicit. `layout` only puts `data-layout` on the
//      element; nothing intercepts Solid state. Motion snapshots and
//      reconciles inside `boundary.update(mutate)`, which is the only place
//      the two schedulers meet (mutate, `flush()`, then Motion reconciles).
//   3. The value path is the element's own VisualElement. `animateElement()`
//      is handed the visual element the component created, so the values that
//      element creates are rendered and disposed with it; a value supplied
//      through `values` is borrowed instead. This page never calls
//      `styleEffect()`; see "4. Radius" for why that matters here.
//
// Two Solid 2 rules are load-bearing:
//
//   - A ref callback runs with no owner (`runWithOwner(null)`), before the
//     element is attached. Everything a feature needs to own — `onCleanup`,
//     `createEffect` — is set up in the component's setup half; the ref only
//     writes DOM and Motion state, and never returns a cleanup (it is dropped).
//   - Props are read, never destructured. The component reads `props.style` and
//     `props.layout` in JSX accessors, so a change to either is a DOM write, not
//     a re-render — except a string `style`, which is a whole cssText and is
//     therefore read once, as a static frame. The shape of `style` is fixed when
//     the element is created: an object stays reactive, a string never changes.
//     `initial` and `values` are read once too: both describe the frame the
//     element is bound with.

const SPRING = {
  type: 'spring',
  visualDuration: 0.45,
  bounce: 0.22,
} as const;

// 0.6rem at the default 16px root, as on the refs page, so the px and rem
// cases below are the same painted radius.
const HERO_RADIUS_PX = 9.6;

type Run = {
  label: string;
  /** Groups still animating when this update was queued. */
  inFlight: number;
  ms: number;
  /** Set when the mutation, or the commit it caused, threw. */
  error?: string;
};

// ---------------------------------------------------------------------------
// The component factory
// ---------------------------------------------------------------------------

// The props the component owns. Everything else is an ordinary DOM prop and is
// spread on the element unchanged (class, id, aria-*, data-*, events, ...).

/**
 * The initial frame this prototype accepts: static CSS and transform values.
 * A keyframe array, a variant label, a `MotionValue` or a function is not an
 * initial frame; own a value through `values` or animate it instead.
 */
type InitialTarget = Readonly<Record<string, string | number | undefined>>;

/** A static frame: the values an element renders before it has animated. */
type Frame = {
  /** The renderer's starting values, so later frames rebuild transform from them. */
  latestValues: Record<string, string | number>;
  /** The same frame as inline style, hyphenated for the DOM. */
  style: JSX.CSSProperties;
};

/**
 * The one value a key contributes to a frame. A keyframe array has no single
 * frame, except when the mount animation is skipped: then the frame is the
 * array's last element, where the skipped animation would have ended. That is
 * the rule a React motion component applies to `initial={false}`, and it is
 * what makes the first paint (server included) match the first client frame.
 */
function frameValue(value: unknown, last: boolean): string | number | undefined {
  const candidate = last && Array.isArray(value) ? value[value.length - 1] : value;
  return typeof candidate === 'string' || typeof candidate === 'number' ? candidate : undefined;
}

/**
 * A target this element can resolve per property. `transitionEnd` is omitted:
 * Motion applies it after the animation settles, outside the priority layers,
 * so it could overwrite a gesture that owns the same key by then. A typed
 * caller cannot pass it; `setTarget()` rejects a JS caller that does.
 */
type MotionTarget = Omit<TargetAndTransition, 'transitionEnd'>;

type MotionOwnProps = {
  /** Target of the element's own animation. A change retargets the running springs. */
  animate?: MotionTarget;
  /**
   * The frame the element starts from. Read once, when the element is created:
   * it seeds the element's renderer and is rendered as inline style on the
   * server *and* on the first client render.
   *
   * `false` means what it means on a React motion component: no mount
   * animation. The element starts at its first `animate` target instead of
   * springing to it from the renderer's defaults, so that target is also what
   * the first paint ships. A keyframe array resolves to its last frame — where
   * the skipped animation would have ended — so it renders without animating
   * too. Only the mount is skipped; targets that change afterwards animate as
   * usual.
   *
   * A key `initial` does not name falls back to the borrowed value for it (see
   * `values`). Under `initial={false}` the `animate` target takes that place
   * instead.
   */
  initial?: InitialTarget | false;
  transition?: Transition;
  /** Opt in to layout projection. Only the explicit boundary animates it. */
  layout?: boolean | 'position' | 'size';
  layoutId?: string;
  whileHover?: MotionTarget;
  whilePress?: MotionTarget;
  /**
   * Values the route owns and reads. The visual element animates these instead
   * of creating its own, so a readout is a `MotionValue` subscription rather
   * than DOM sampling. Captured when the element mounts, and borrowed: the
   * renderer subscribes on mount and unsubscribes on unmount, and never
   * destroys a value it did not create. A different record arriving later is
   * not applied — bind the value before the element mounts.
   *
   * Each value's current frame is also the element's first paint: a key
   * `initial` does not name (or `animate` does not name under
   * `initial={false}`) renders at `value.get()` on the server and on the first
   * client render. Without an explicit frame, a nonzero value is therefore
   * never painted at the renderer's default first.
   */
  values?: Record<string, MotionValue>;
  /**
   * Composed by the component, not spread. Arrays are flattened by `applyRef`,
   * the same primitive a native `ref={[a, b]}` uses.
   */
  ref?: ((element: HTMLElement) => void) | Array<(element: HTMLElement) => void>;
};

type MotionPropKey = keyof MotionOwnProps;

// Every prop the component reserves, listed by name rather than collected from
// the installed features. An element that does not install `hoverFeature` still
// strips `whileHover`: a prop no feature reads must never reach the DOM as an
// attribute. Collecting the names from the features instead would either strip
// only what this element installs (the leak this list exists to close) or have
// to import every feature to ask for its props, which is what tree shaking is
// meant to avoid. The `Record` type is what keeps the list complete: a new own
// prop with no line here does not compile. The values are unused.
const RESERVED_PROPS: Record<MotionPropKey, true> = {
  animate: true,
  initial: true,
  transition: true,
  layout: true,
  layoutId: true,
  whileHover: true,
  whilePress: true,
  values: true,
  ref: true,
};

type MotionNode = {
  /** The element, once Solid's ref has run. Undefined on the server. */
  element(): HTMLElement | undefined;
  /**
   * Raise, replace or clear one priority layer's target. The node resolves
   * every property to the value from the highest layer that names it, so
   * layers compose instead of replacing each other. A no-op animation without
   * an element; the layers are kept for when it arrives.
   */
  setTarget(priority: number, target: MotionTarget | undefined, transition?: Transition): void;
  /** Run once the element exists. This is the apply half: DOM + Motion only. */
  onBind(run: () => void): void;
};

// Target layers, lowest first. A gesture does not own a property outright: it
// raises the priority of the keys it names. `press` beating `hover` on `scale`
// while `hover` keeps `opacity` is the same resolution as `animate` holding a
// key no gesture names, and it is what makes the two gestures composable on one
// element instead of each restoring its own snapshot over the other.
const PRIORITY = { base: 0, hover: 1, press: 2 } as const;

type MotionFeature<K extends MotionPropKey = MotionPropKey> = {
  readonly name: string;
  /**
   * Own props this feature reads. A factory accepts these and no others, so
   * `whilePress` is not a prop of an element without `pressFeature`; every
   * reserved prop is stripped from the spread whether or not it is installed.
   */
  readonly props: readonly K[];
  /** Setup half: under the component owner, where `onCleanup` is registered. */
  setup(node: MotionNode, props: MotionOwnProps): void;
};

// The one thing every motion element owns: an element slot, a VisualElement and
// the animations still writing through it. Created in the setup half so cleanup
// belongs to the component; filled in the apply half, where there is no owner.
// `initial` is the frame the renderer starts from, so its transform string is
// built from every key the element begins with, not only the animated ones.
// `instant` is `initial={false}`: the first frame this node writes is a mount
// frame, written in one pass instead of animated (see `apply`).
function createMotionNode(
  values: Record<string, MotionValue> | undefined,
  initial: Record<string, string | number> | undefined,
  instant: boolean,
) {
  let element: HTMLElement | undefined;
  let visualElement: HTMLVisualElement | undefined;
  // Set by `initial={false}` until the first frame has been written: only the
  // mount frame is instant, every later target animates.
  let jump = instant;
  const running = new Set<AnimationPlaybackControlsWithThen>();
  const bindings: Array<() => void> = [];
  // One target per priority, with the transition that target was raised with.
  // Recomputed on every layer change, never merged by hand, which is the whole
  // per-property priority rule. The transition travels with the layer because a
  // value's transition belongs to the layer that owns the value, not to the
  // event that happened to trigger the recompute.
  type Layer = {
    keys: Record<string, unknown>;
    transition?: Transition;
  };
  const layers = new Map<number, Layer>();
  // For a key a gesture has taken over: what to put back once every gesture has
  // released it and the base target does not name it. Captured before the
  // gesture's value lands, so it is the frame the element was rendering.
  const fallbacks = new Map<string, unknown>();
  // What this node last sent to Motion, per key. Only keys whose resolved value
  // changed are animated, so raising a layer for `scale` does not restart an
  // `x` spring that is already in flight.
  const applied = new Map<string, unknown>();
  // Keys currently named by a layer above the base target.
  let overrides = new Set<string>();

  onCleanup(() => {
    // Stop what is still writing before the element (and its renderer) goes
    // away. Interrupted animations were already stopped by Motion's own
    // retarget path; they are pruned below rather than stopped twice.
    running.forEach((animation) => {
      if (animation.state === 'running') animation.stop();
    });
    running.clear();
    visualElement?.unmount();
    visualElement = undefined;
    element = undefined;
  });

  const prune = () => {
    running.forEach((animation) => {
      if (animation.state !== 'running') running.delete(animation);
    });
  };

  const resolve = () => {
    const resolved = new Map<
      string,
      { priority: number; value: unknown; transition?: Transition }
    >();
    layers.forEach((layer, priority) => {
      for (const key in layer.keys) {
        const current = resolved.get(key);
        if (!current || priority > current.priority) {
          resolved.set(key, {
            priority,
            value: layer.keys[key],
            transition: layer.transition,
          });
        }
      }
    });
    return resolved;
  };

  // The transition a changed key animates with. Each key takes the transition of
  // the layer that resolved it, so releasing press back to hover uses hover's
  // transition and releasing hover back to the base target uses the base's.
  // Keys with no owning layer (a gesture's captured fallback) keep the
  // transition supplied by the change that restored them.
  const resolveTransition = (
    changed: Record<string, unknown>,
    resolved: ReadonlyMap<string, { transition?: Transition }>,
    transition: Transition | undefined,
  ): Record<string, unknown> => {
    const effect: Record<string, unknown> = { ...(transition ?? SPRING) };
    for (const key in changed) {
      const owner = resolved.get(key)?.transition;
      if (owner) effect[key] = getValueTransition(owner, key);
    }
    // `animateElement()` takes a plain object; a conditional/union transition
    // has to be spread into one, which is why `effect` is not passed through.
    return effect;
  };

  const apply = (transition: Transition | undefined) => {
    // No element: the server, or a ref that has not run yet. The layers are
    // kept, so they apply whenever the element arrives; there is nothing to
    // animate until then.
    if (!element || !visualElement) return;
    const renderer = visualElement;
    const resolved = resolve();

    const nextOverrides = new Set<string>();
    resolved.forEach(({ priority }, key) => {
      if (priority > PRIORITY.base) nextOverrides.add(key);
    });
    // Captured before the gesture's value is written: `readValue()` prefers the
    // renderer's latest target, so this is what the element had a moment ago.
    nextOverrides.forEach((key) => {
      if (!overrides.has(key)) fallbacks.set(key, renderer.readValue(key));
    });

    const target: Record<string, unknown> = {};
    resolved.forEach(({ value }, key) => {
      target[key] = value;
    });
    // A key every gesture has released resolves to the base target when it
    // names the key, and otherwise to the value captured at takeover. Reading
    // the base again here (rather than restoring a snapshot) is what keeps a
    // changed `animate` target from being overwritten by an old frame.
    overrides.forEach((key) => {
      if (nextOverrides.has(key) || resolved.has(key)) return;
      const fallback = fallbacks.get(key);
      if (fallback !== undefined && fallback !== null) target[key] = fallback;
    });
    overrides = nextOverrides;
    fallbacks.forEach((_, key) => {
      if (!overrides.has(key)) fallbacks.delete(key);
    });

    const changed: Record<string, unknown> = {};
    for (const key in target) {
      if (Object.is(applied.get(key), target[key])) continue;
      changed[key] = target[key];
      applied.set(key, target[key]);
    }
    if (!Object.keys(changed).length) return;
    prune();

    // `initial={false}`: the mount frame is written through the renderer in one
    // pass, so it never springs out of the renderer's defaults on the first
    // frame. A keyframe array resolves to its last element, the frame the
    // skipped animation would have settled on, so it is written the same way
    // rather than animated. A value with no frame at all (a `MotionValue`, an
    // object) still animates, because there is no single value to write.
    // `bind()` clears the flag, so only the frames written while the element is
    // being bound are instant.
    let animated = changed;
    if (jump) {
      const keyframes: Record<string, unknown> = {};
      for (const key in changed) {
        const value = frameValue(changed[key], true);
        if (value === undefined) {
          keyframes[key] = changed[key];
          continue;
        }
        // A key the route owns through `values` is written on its value, so a
        // readout stays in step with the frame that was just applied.
        const bound = renderer.getValue(key);
        if (bound) bound.set(value);
        else renderer.setStaticValue(key, value);
      }
      renderer.render();
      if (!Object.keys(keyframes).length) return;
      animated = keyframes;
    }

    const effect = resolveTransition(animated, resolved, transition);
    animateElement(element, animated as EffectKeyframes, effect, renderer).forEach((animation) => {
      running.add(animation);
    });
  };

  const node: MotionNode = {
    element: () => element,
    setTarget(priority, target, transition) {
      if (!target) {
        layers.delete(priority);
        apply(transition);
        return;
      }
      // A transition nested in the target wins over the prop, as on a React
      // motion component; it is a transition, not a key to animate.
      const { transition: nested, transitionEnd, ...keys } = target as TargetAndTransition & {
        transition?: Transition;
      };
      if (transitionEnd) {
        // The type omits it, but a JS caller can still hand it over. Forwarding
        // it would let Motion write these values when the animation settles,
        // after a gesture may have taken the key over, so fail loudly instead.
        throw new Error(
          'transitionEnd is not supported by a motion element: Motion applies it after the animation completes, ' +
            'outside the per-property priority layers, so it can overwrite a gesture that owns the same property. ' +
            'Put the value in the target itself, or in a higher-priority layer that owns it.',
        );
      }
      layers.set(priority, {
        keys: keys as Record<string, unknown>,
        transition: { ...transition, ...nested },
      });
      apply({ ...transition, ...nested });
    },
    onBind(run) {
      bindings.push(run);
    },
  };

  const bind = (next: HTMLElement) => {
    element = next;
    // The same renderer a `motion.*` component uses. Creating it here (rather
    // than letting `animateLayout()` create one on first adoption) means the
    // values already live on it when projection arrives, so there is no
    // handoff step to reason about.
    visualElement = new HTMLVisualElement({
      // Motion reads values from `style` props (that is how its own components
      // take `style={{ x }}`); binding them here is what subscribes each one to
      // this element's renderer.
      props: (values ? { style: values } : {}) as MotionNodeOptions,
      presenceContext: null,
      visualState: {
        latestValues: initial ?? {},
        renderState: { transform: {}, transformOrigin: {}, style: {}, vars: {} },
      },
    });
    visualElement.mount(next);
    bindings.splice(0).forEach((run) => run());
    // The mount frames have been written; every target from here on animates,
    // even on an element that never named one at bind (a gesture-only element,
    // or a base target that only appears later).
    jump = false;
  };

  return { node, bind };
}

// `animate` is the only feature every element has. It owns the base layer: the
// first target plays when the element arrives; later ones play when the prop
// changes. The effect is deferred so its mount pass cannot play the bound
// target a second time — and so a target that only appears later still starts,
// which a "already played" gate would silently swallow.
const animateFeature = {
  name: 'animate',
  props: ['animate', 'transition'],
  setup(node, props) {
    const transition = () => untrack(() => props.transition) ?? SPRING;
    // The apply half is not a tracking scope: the current target is read
    // untracked, on purpose. Later targets arrive through the effect.
    node.onBind(() => node.setTarget(PRIORITY.base, untrack(() => props.animate), transition()));
    createEffect(
      () => props.animate,
      (target) => node.setTarget(PRIORITY.base, target, transition()),
      { defer: true },
    );
  },
} as const satisfies MotionFeature<'animate' | 'transition'>;

// Gestures are plain vanilla primitives wrapped around the element's own value
// path. They are features, not part of the component: a factory that does not
// list `hoverFeature` has no pointer listeners at all.
//
// A gesture target is transient, but it is not a snapshot: it raises its
// keys' priority and clears them on leave. The node then resolves each key to
// the base target if that names it, or to the frame the element had when the
// gesture took the key over. Overlapping gestures and a base target that
// changes mid-gesture therefore resolve to what is current, not to the values
// that were true when the gesture began.
function createGestureFeature<K extends 'whileHover' | 'whilePress'>(
  name: string,
  prop: K,
  priority: number,
  register: (element: Element, start: () => void | (() => void)) => () => void,
): MotionFeature<K | 'transition'> {
  return {
    name,
    props: [prop, 'transition'],
    setup(node, props) {
      let stop: (() => void) | undefined;
      onCleanup(() => stop?.());
      node.onBind(() => {
        const element = node.element();
        // The target is read at mount, so `whileHover`/`whilePress` are
        // mount-time props, not reactive ones. The cleanup above runs in the
        // setup half, which is what removes a listener the apply half added.
        const enter = untrack(() => props[prop]);
        if (!element || !enter) return;
        stop = register(element, () => {
          node.setTarget(priority, enter, untrack(() => props.transition) ?? SPRING);
          return () =>
            node.setTarget(priority, undefined, untrack(() => props.transition) ?? SPRING);
        });
      });
    },
  };
}

const hoverFeature = createGestureFeature('hover', 'whileHover', PRIORITY.hover, (element, start) =>
  hover(element, start),
);

const pressFeature = createGestureFeature('press', 'whilePress', PRIORITY.press, (element, start) =>
  press(element, start),
);

// A frame is the static part of a target: what the element can render before it
// has animated anything. It has two halves, the values the element's renderer
// starts from and the inline style the first paint (including SSR) ships. Both
// come from Motion's own style builder, so a transform shorthand lands in the
// same order and with the same units as an animated frame — `x: '50%'` stays
// `translateX(50%)`, `rotate: 45` becomes `rotate(45deg)`, and so on. Seeding
// the renderer matters as much as the inline style: `buildHTMLStyles()` builds
// the transform string out of every transform it knows about, so an initial
// `scale` has to be in `latestValues` or the first frame that animates `x`
// rewrites `transform` without it.
//
// The frame is always rebuilt from `latestValues`, never merged as style
// objects: two sources can each contribute a transform key, and merging the
// built `transform` strings would drop one of them.
function frameFromLatestValues(
  latestValues: Record<string, string | number>,
): Frame | undefined {
  if (!Object.keys(latestValues).length) return undefined;
  const renderState: HTMLRenderState = { transform: {}, transformOrigin: {}, style: {}, vars: {} };
  buildHTMLStyles(renderState, latestValues);
  // Solid 2's style object writes each key with `setProperty()`, which only
  // takes CSS names, so the builder's camelCase keys are hyphenated here.
  const style: Record<string, string | number> = {};
  for (const key in renderState.style) style[camelToDash(key)] = renderState.style[key];
  for (const key in renderState.vars) style[key] = renderState.vars[key];
  return { latestValues, style: style as JSX.CSSProperties };
}

// `last` selects what a keyframe array contributes: its final frame, for the
// target `initial={false}` starts from (see `frameValue()`), or nothing.
function buildFrame(
  target: Readonly<Record<string, unknown>> | undefined,
  last = false,
): Frame | undefined {
  // The type narrows this to a target object, but a JS caller can still hand
  // over a variant label, a list of them or a function; none of those is a
  // frame to start from.
  if (!target || typeof target !== 'object' || Array.isArray(target)) return undefined;
  const latestValues: Record<string, string | number> = {};
  for (const key in target) {
    const value = frameValue(target[key], last);
    if (value !== undefined) latestValues[key] = value;
  }
  return frameFromLatestValues(latestValues);
}

// The frame the borrowed values are already rendering. This is the same
// `get()` Motion's own `makeLatestValues()` resolves a style MotionValue with,
// and only a string or number is a static frame — the same rule `initial`
// follows. Reading is all it does: the value still belongs to its creator, and
// the element only subscribes to it on mount.
function buildValuesFrame(
  values: Readonly<Record<string, MotionValue>> | undefined,
): Frame | undefined {
  if (!values) return undefined;
  const latestValues: Record<string, string | number> = {};
  for (const key in values) {
    const candidate = values[key]?.get();
    if (typeof candidate === 'string' || typeof candidate === 'number') {
      latestValues[key] = candidate;
    }
  }
  return frameFromLatestValues(latestValues);
}

// One frame from two, `override` winning per key. The style is rebuilt from the
// merged values so a transform key from either side is part of the same string.
function mergeFrames(base: Frame | undefined, override: Frame | undefined): Frame | undefined {
  if (!base) return override;
  if (!override) return base;
  return frameFromLatestValues({ ...base.latestValues, ...override.latestValues });
}

// `initial` has two shapes and they mean what they mean on a React motion
// component. A values object is the frame the element starts from. `false`
// disables the mount animation: the element starts at its first `animate`
// target, so that target is the frame — the first paint ships it and nothing
// springs out of the renderer's defaults. A keyframe array in that target
// contributes its last frame, which is where the skipped animation would have
// ended. Only the mount is affected; a target that changes afterwards still
// animates.
//
// A borrowed value has a frame too: what it is currently rendering. It seeds
// any key the explicit frame does not name, and loses to the explicit frame on
// the keys both name — `initial` normally, `animate` under `initial={false}`.
// That is the precedence Motion's own `makeLatestValues()` applies, and it is
// why a nonzero `values={{ x }}` paints at `x` instead of at the renderer's
// defaults before any animation exists.
function initialFrame(
  initial: InitialTarget | false | undefined,
  animate: MotionTarget | undefined,
  values: Readonly<Record<string, MotionValue>> | undefined,
): { frame?: Frame; instant: boolean } {
  const borrowed = buildValuesFrame(values);
  const explicit = initial === false ? buildFrame(animate, true) : buildFrame(initial);
  return { frame: mergeFrames(borrowed, explicit), instant: initial === false };
}

const mergeStyle = (
  style: JSX.CSSProperties | string | undefined,
  initial: JSX.CSSProperties | undefined,
) => {
  if (!initial) return style;
  if (style === undefined) return initial;
  // A string style is a cssText, so the initial frame is appended to it rather
  // than replacing it. Object styles merge key by key.
  if (typeof style === 'string') {
    const css = Object.entries(initial)
      .map(([key, value]) => `${key}:${value}`)
      .join(';');
    return `${style};${css}`;
  }
  return { ...style, ...initial };
};

/** The own props an element accepts: what the factory reads, plus what its features read. */
type MotionElementProps<
  T extends keyof JSX.IntrinsicElements,
  F extends readonly MotionFeature[],
> = JSX.IntrinsicElements[T] &
  // Owned by the factory itself: the initial frame, the layout attributes, the
  // values handed to the renderer and the ref it composes.
  Pick<MotionOwnProps, 'initial' | 'layout' | 'layoutId' | 'values' | 'ref'> &
  // Owned by the installed features. `whilePress` is not a prop of an element
  // that did not install `pressFeature`, so an unsupported prop is a type error
  // rather than a DOM attribute.
  Pick<MotionOwnProps, F[number]['props'][number]>;

function createMotionElement<
  T extends keyof JSX.IntrinsicElements,
  const F extends readonly MotionFeature[],
>(tag: T, features: F): Component<MotionElementProps<T, F>> {
  // `static` is right here: the tag of one factory never changes, so there is
  // no memo and no per-element `dynamic()` component instance.
  const MotionTag = dynamic(() => tag as unknown as string, { static: true }) as Component<
    Record<string, unknown>
  >;

  // `ref` and `style` are composed by this component, so they never ride the
  // spread. Every reserved motion prop is stripped as well — installed feature
  // or not — so one can never land on the DOM as an attribute. The names come
  // from `RESERVED_PROPS`, not from `features`, which keeps the strip complete
  // without importing a feature this element did not install.
  const consumed = ['style', ...Object.keys(RESERVED_PROPS)];

  function MotionElement(props: Record<string, unknown>) {
    const own = props as MotionOwnProps;
    // Captured once, when the element is created: `values` and `initial`
    // describe the frame the renderer is bound with, not reactive props. The
    // same record seeds the first paint and the renderer, so a nonzero borrowed
    // value is on the element before mount has rendered anything.
    const values = untrack(() => own.values);
    const { frame, instant } = untrack(() => initialFrame(own.initial, own.animate, values));
    const { node, bind } = createMotionNode(values, frame?.latestValues, instant);

    // `style` has one shape for the element's lifetime, fixed here, when the
    // element is created.
    //
    // An object is written key by key by Solid, so it stays reactive: a change
    // writes the keys it names and leaves every other property — the
    // `transform` the renderer owns included — alone. A string is a whole
    // cssText, assigned in one write, so it is applied once: the first paint,
    // including SSR, with the initial frame appended. Merging a string per
    // property instead would mean owning a cssText parser, so the shape is the
    // contract rather than the value.
    //
    // The other shape arriving later is not applied. Both writes reach past the
    // keys the caller named: a late cssText replaces the transform the renderer
    // animates, and a late object silently drops the rest of the cssText. The
    // element keeps the style it rendered — `style()` hands Solid the object it
    // already wrote — and the change is reported once.
    const staticCss = untrack(() => {
      const style = props.style;
      return typeof style === 'string' ? style : undefined;
    });
    const staticStyle = staticCss === undefined ? undefined : mergeStyle(staticCss, frame?.style);
    // The last object style this element rendered. Repeated while the prop has
    // the other shape, so Solid has nothing to write and nothing to remove: the
    // keys it already applied, the initial frame's `transform` included, are
    // all still in the object it is handed.
    let rendered: JSX.CSSProperties | undefined;
    // The string branch reads no reactive prop, so Solid writes it once; an
    // object style is re-read on every change, as a DOM write.
    const style = () => {
      if (staticStyle !== undefined) return staticStyle;
      const next = props.style as JSX.CSSProperties | string | undefined;
      if (typeof next === 'string') return rendered;
      // Not a string here, so this is the object branch of `mergeStyle()`.
      rendered = mergeStyle(next, frame?.style) as JSX.CSSProperties | undefined;
      return rendered;
    };

    // One report per element: the shape is fixed, so a second switch is the
    // same mistake as the first.
    let warned = false;
    createEffect(
      () => props.style,
      (next) => {
        if (warned) return;
        const stable = staticCss === undefined ? typeof next !== 'string' : next === staticCss;
        if (stable) return;
        warned = true;
        console.warn(
          '[motion] `style` is fixed when the element is created: an object is written key by key and stays ' +
            'reactive, a string is a whole cssText and is written once. This change was not applied, so the ' +
            'transform this element animates was not replaced. Keep one shape for the element’s lifetime; ' +
            'pass an object for a reactive style.',
        );
      },
      { defer: true },
    );

    for (const feature of features) feature.setup(node, own);

    // Apply half. The caller's ref runs after the element is bound, so it sees
    // a live VisualElement; `applyRef` flattens arrays and is the same
    // primitive Solid uses for `ref={[a, b]}` on a DOM element.
    const attach = (element: HTMLElement) => {
      bind(element);
      const callerRef = untrack(() => own.ref) as
        | ((element: HTMLElement) => void)
        | Array<(element: HTMLElement) => void>
        | undefined;
      if (callerRef) applyRef(callerRef, element);
    };

    // The view is created once per component instance; the spread reads it
    // through Solid's own reactive spread, so a prop change is a DOM write.
    const rest = omit(props, ...consumed);

    return (
      <MotionTag
        {...rest}
        style={style()}
        data-layout={own.layout === true ? '' : own.layout || undefined}
        data-layout-id={own.layoutId}
        ref={attach}
      />
    );
  }

  return MotionElement as unknown as Component<MotionElementProps<T, F>>;
}

// The module-scope composition. `motion.div` and `motion.button` are different
// components with different feature sets, which is the point of the spike:
// there is no single component carrying every feature. The button installs
// both gestures so the page has one element where hover and press overlap.
const motion = {
  div: createMotionElement('div', [animateFeature, hoverFeature]),
  button: createMotionElement('button', [animateFeature, hoverFeature, pressFeature]),
  // A layout node only. The tile labels use it to counter-scale the tile's
  // projection, so the text is not stretched with the box (see section 2).
  span: createMotionElement('span', []),
};

// Exported for the route's tests, which build one-feature elements from the
// same factory (a late `animate` target, an `initial` transform frame, a
// gesture without a base target, both gestures on one element).
export { animateFeature, createLayoutBoundary, createMotionElement, hoverFeature, pressFeature };

// ---------------------------------------------------------------------------
// The explicit layout boundary
// ---------------------------------------------------------------------------

type LayoutBoundary = {
  /** Attach the scope. Composes with other refs: `ref={[scope.ref, probe]}`. */
  ref: (element: HTMLElement) => void;
  /** The element the scope ref received, for diagnostics. */
  element(): HTMLElement | undefined;
  /**
   * The only place a layout animation starts. An update after the owner is
   * disposed is dropped — there is no element left to measure — and reported
   * through `onError`.
   */
  update(mutate: () => void, label: string): void;
};

type LayoutBoundaryOptions = {
  onRun?: (run: Run) => void;
  /**
   * Called when the mutation, or the Solid commit it caused, throws. Motion
   * catches that error and rejects the builder; without this callback it has
   * nowhere to go but an unhandled rejection (or, worse, a silent catch).
   */
  onError?: (failure: { label: string; error: unknown }) => void;
};

function createLayoutBoundary(options: LayoutBoundaryOptions = {}): LayoutBoundary {
  let scope: HTMLElement | undefined;
  let disposed = false;
  const animating = new Set<GroupAnimation>();

  onCleanup(() => {
    disposed = true;
    animating.forEach((animation) => animation.stop());
    animating.clear();
  });

  const isRunning = (animation: GroupAnimation) =>
    animation.animations.some((child) => child.state === 'running');

  const track = (animation: GroupAnimation) => {
    // A run interrupted by a later one never settles: Motion stops the previous
    // animations and a stopped one leaves `finished` pending. Prune before
    // tracking so leaving the page only stops what is still writing.
    animating.forEach((tracked) => {
      if (!isRunning(tracked)) animating.delete(tracked);
    });
    animating.add(animation);
    const release = () => animating.delete(animation);
    animation.finished.then(release, release);
  };

  // One error channel for the boundary. A boundary that has no listener is
  // still not allowed to lose the error: it goes to the console rather than to
  // an empty catch.
  const report = (error: unknown, label: string) => {
    if (options.onError) options.onError({ label, error });
    else console.error(`[motion] update "${label}" failed`, error);
  };

  const update = (mutate: () => void, label: string) => {
    // The owner is gone: so is the scope, and everything a mutation of this
    // subtree renders. Starting a run here would measure a detached element and
    // hand Motion nodes the page no longer owns, so drop the update and say so
    // through the same channel a failed run uses.
    if (disposed) {
      report(
        new Error(
          `the boundary was updated after its owner was disposed, so "${label}" did not run: there is no element left to animate`,
        ),
        label,
      );
      return;
    }
    const target = scope;
    // Server, or a ref that has not attached: run the mutation, animate
    // nothing. The state change is not conditional on the DOM. A throw here is
    // synchronous and belongs to the caller; there is no builder to reject.
    if (!target) {
      mutate();
      return;
    }
    const inFlight = [...animating].filter(isRunning).length;
    const started = performance.now();
    // Motion runs `updateDom` inside a try/catch of its own and rejects the
    // builder with whatever threw, so the only way to see that error is to
    // await the builder. Catching it here and reporting it is what replaces the
    // empty catch: the promise this function drops never rejects, and the error
    // is visible to the page instead of vanishing.
    void (async () => {
      try {
        const animation = await animateLayout(
          target,
          () => {
            mutate();
            // Solid writes now, so Motion reconciles the committed branch.
            // This is the whole boundary: one flush between the two schedulers.
            flush();
          },
          SPRING,
        );
        if (disposed || scope !== target) {
          // Unmounted, or the ref now points at a different element, before
          // Motion finalised: stop this run rather than let it write to nodes
          // the page no longer owns.
          animation.stop();
          return;
        }
        track(animation);
        options.onRun?.({
          label,
          inFlight,
          ms: Number((performance.now() - started).toFixed(1)),
        });
      } catch (error) {
        report(error, label);
      }
    })();
  };

  return {
    ref: (element) => {
      scope = element;
    },
    element: () => scope,
    update,
  };
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

const CHIPS = ['alpha', 'bravo', 'charlie', 'delta'] as const;

type RadiusCase = {
  id: 'px' | 'rem';
  radius: number | string;
  label: string;
};

const RADIUS_CASES: readonly RadiusCase[] = [
  { id: 'px', radius: HERO_RADIUS_PX, label: `borderRadius: ${HERO_RADIUS_PX}` },
  { id: 'rem', radius: '0.6rem', label: "borderRadius: '0.6rem'" },
];

const SAMPLE_MS = 1200;

type RadiusSample = {
  ms: number;
  inline: string;
  scale: string;
  corrected: boolean;
  deviation: number;
};

// Projection writes the four corner properties during a run; between runs the
// element's own renderer writes the shorthand.
const readInlineRadius = (element: HTMLElement) =>
  element.style.borderTopLeftRadius || element.style.borderRadius || '';

const readScale = (transform: string) => {
  const match = transform.match(/scale\(([^)]*)\)/g)?.at(-1);
  if (!match) return { text: '—', deviation: 0 };
  const text = match.slice('scale('.length, -1);
  const [x = 1, y = x] = text.split(',').map(Number);
  return { text, deviation: Math.max(Math.abs(x - 1), Math.abs(y - 1)) };
};

export default function MotionApiLab() {
  const [runs, setRuns] = createSignal<Run[]>([]);
  const record = (run: Run) => setRuns((previous) => [run, ...previous].slice(0, 6));
  // An update that throws is logged like a run, with the message. The boundary
  // is what turns Motion's rejected builder into this entry.
  const fail = ({ label, error }: { label: string; error: unknown }) =>
    record({
      label,
      inFlight: 0,
      ms: 0,
      error: error instanceof Error ? error.message : String(error),
    });
  const boundaryOptions = { onRun: record, onError: fail };

  // 1. Spring and interruption. `x` is owned by this route: `createMotionValue()`
  // registers its destruction with the component owner, so leaving the page
  // clears its listeners and stops whatever was driving it. The element and the
  // readout both borrow it — `values` binds it to the element's visual element,
  // and `createMotionValueAccessor()` is a subscription rather than DOM sampling.
  const x = createMotionValue(0);
  const xFrame = createMotionValueAccessor(x);
  // Rounded here rather than in the accessor so a frame that moves the value
  // without moving the displayed pixel does not re-run the readout.
  const xNow = createMemo(() => Math.round(xFrame()));
  const [interrupt, setInterrupt] = createSignal<string>('');
  const [right, setRight] = createSignal(false);

  const nudge = (next: boolean) => {
    setInterrupt(
      `target changed at x=${x.get().toFixed(1)}px, v=${x.getVelocity().toFixed(0)}px/s`,
    );
    setRight(next);
  };

  // 2. Explicit layout boundary.
  const tiles = createLayoutBoundary(boundaryOptions);
  const [grid, setGrid] = createSignal(false);
  const [order, setOrder] = createSignal<string[]>([...CHIPS]);

  // 3. Refs and server-rendered initial styles.
  // Owned by this route, borrowed by the probe below: with no `animate` and no
  // `initial`, its current frame is the only thing the first paint can show.
  const borrowedX = createMotionValue(40);
  const refScope = createLayoutBoundary(boundaryOptions);
  const [wide, setWide] = createSignal(false);
  let probeElement: HTMLElement | undefined;
  let probeCalls = 0;
  // Read at ref time, not when the report is rendered: the point is the order
  // the component binds in.
  let probeSawRenderer = false;
  const probe = (element: HTMLElement) => {
    probeElement = element;
    probeCalls += 1;
    probeSawRenderer = visualElementStore.get(element) !== undefined;
  };
  const [refReport, setRefReport] = createSignal('');
  const readRefs = () => {
    const element = probeElement;
    if (!element) {
      setRefReport('the probe ref has not run');
      return;
    }
    setRefReport(
      `probe calls: ${probeCalls} · same element as the scope: ${
        element === refScope.element() ? 'yes' : 'no'
      } · visual element already bound when the probe ran: ${probeSawRenderer ? 'yes' : 'no'}`,
    );
  };
  onSettled(readRefs);

  const [ssr, setSsr] = createSignal<string>('');
  const readSsr = async () => {
    setSsr('reading…');
    try {
      const response = await fetch(location.pathname, { headers: { accept: 'text/html' } });
      const html = await response.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const nodes = [...doc.querySelectorAll('[data-ssr-probe]')];
      if (!nodes.length) {
        setSsr('no [data-ssr-probe] element in the server response');
        return;
      }
      // Both frames are reported: the `initial` object it ships and the
      // `initial={false}` target, whose keyframe array resolved to its last
      // frame before the markup was written.
      setSsr(
        nodes
          .map(
            (node) =>
              `<${node.tagName.toLowerCase()} class="${node.getAttribute('class') ?? ''}" style="${node.getAttribute(
                'style',
              ) ?? ''}">`,
          )
          .join(' · '),
      );
    } catch (error) {
      setSsr(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <main class="motion-api-lab">
      <Title>Motion components lab</Title>
      <h1>Motion components lab</h1>
      <p class="motion-api-lab-lede">
        A <code>motion.*</code> component built from the vanilla engine: features are chosen per
        element at module scope, every element owns one Motion <code>VisualElement</code>, and
        layout only animates inside an explicit update boundary. The component factory and the
        boundary are local to this route; value ownership is the shared helper in{' '}
        <code>src/lib/motion-value.ts</code>.
      </p>
      <p class="motion-api-lab-lede">
        Back to the <a href={paths()}>layout lab</a> or the <a href={paths.refs()}>refs lab</a>.
      </p>

      <section class="motion-api-lab-panel" aria-labelledby="motion-api-spring">
        <h2 id="motion-api-spring">1. motion.div, features composed per element</h2>
        <p>
          <code>motion.div</code> is <code>createMotionElement('div', [animateFeature,
          hoverFeature])</code>; <code>motion.button</code> is the same factory with{' '}
          <code>hoverFeature</code> and <code>pressFeature</code> as well. The body of the component
          knows none of them: it creates the node, calls each feature&apos;s setup, and binds the
          element once. A route that never names a feature never ships it, and an element does not
          accept that feature&apos;s props: <code>whilePress</code> on the <code>div</code> is a type
          error, and a reserved prop handed to an element from plain JS is stripped from the spread
          rather than landing on the DOM as an attribute.
        </p>
        <p>
          Targets compose per property, by priority: the <code>animate</code> target is the base,{' '}
          <code>whileHover</code> raises the keys it names above it, and <code>whilePress</code>{' '}
          above hover. Hover the button and press it: press owns <code>scale</code>, and letting go
          goes back to hover&apos;s value while the pointer is still on it. A key a gesture moved
          returns to the base target when that names the key, otherwise to the value the element was
          rendering when the gesture took it over. Whichever layer supplies the restored value also
          supplies its transition, so a key returning to hover or to <code>animate</code> uses that
          target&apos;s nested <code>transition</code>, not the gesture that released it. Because of
          that, changing <code>animate</code> during a gesture only retargets the keys the gesture
          is not holding, and the new base is what the gesture releases to — no stale snapshot.
          Only keys whose resolved value changed are sent to Motion, so raising one layer does not
          restart the spring another layer owns.
        </p>
        <p>
          Retarget mid-flight: the spring keeps the velocity the value already had, because the
          same <code>MotionValue</code> is animated through the same visual element. Click Right,
          then Left while it is still moving: the box carries on to the right for a few frames
          before it turns around, and the readout records the value and velocity at the moment the
          target changed. The value itself is the route&apos;s: <code>createMotionValue(0)</code>{' '}
          owns it and destroys it with the component, <code>values={'{{ x }}'}</code> lends it to
          the element, and <code>createMotionValueAccessor()</code> is the readout. The element
          unsubscribes on unmount and never destroys a value it did not create.
        </p>
        <div class="motion-api-lab-toolbar">
          <button type="button" onClick={() => nudge(false)}>
            Left
          </button>
          <button type="button" onClick={() => nudge(true)}>
            Right
          </button>
          <motion.button
            type="button"
            class="motion-api-lab-press"
            animate={{ scale: 1 }}
            transition={SPRING}
            whileHover={{ scale: 1.04 }}
            whilePress={{ scale: 0.92 }}
          >
            press me
          </motion.button>
        </div>
        <div class="motion-api-lab-stage">
          <motion.div
            class="motion-api-lab-puck"
            values={{ x }}
            animate={{ x: right() ? 220 : 0 }}
            transition={SPRING}
            whileHover={{ scale: 1.08 }}
          />
        </div>
        <output class="motion-api-lab-readout" aria-live="off">
          x: {xNow()}px
          <Show when={interrupt()}>
            {' '}
            · {interrupt()}
          </Show>
        </output>
      </section>

      <section class="motion-api-lab-panel" aria-labelledby="motion-api-boundary">
        <h2 id="motion-api-boundary">2. Explicit layout boundary</h2>
        <p>
          The tiles carry <code>layout</code>, which only renders <code>data-layout</code>. Nothing
          watches the signals: the buttons call <code>tiles.update(mutate, label)</code>, and that
          callback is the entire boundary — mutate, <code>flush()</code> so Solid&apos;s DOM write
          lands, then Motion snapshots and reconciles. Click twice quickly and the second run is
          accepted from wherever the first had reached.
        </p>
        <p>
          If the mutation throws, Motion catches it, completes the commit without animating and
          rejects the builder. The boundary awaits that builder and hands the rejection to{' '}
          <code>onError</code>, which logs the message below; nothing is swallowed and no rejection
          is left unhandled.
        </p>
        <p>
          Each tile&apos;s label is a nested <code>layout=&quot;position&quot;</code> node of its
          own. The run animates the tile&apos;s box with a scale, and text painted straight into
          that box would be stretched with it on every frame. The nested node is projected too, so
          Motion counter-scales it against the tile and only animates its position: the label stays
          its own size while it moves with the tile.
        </p>
        <p>
          The scope is guarded on both sides of that await. A run Motion finalises after the page
          was unmounted, or after the ref was handed a different element, is stopped instead of
          being tracked, and an <code>update()</code> called after the owner is disposed is dropped
          and reported: a detached element is not something to measure.
        </p>
        <div class="motion-api-lab-toolbar">
          <button
            type="button"
            onClick={() => tiles.update(() => setGrid((value) => !value), 'Tiles → row/grid')}
          >
            {grid() ? 'Switch to row' : 'Switch to grid'}
          </button>
          <button
            type="button"
            onClick={() =>
              tiles.update(
                () =>
                  setOrder((current) => [
                    current[current.length - 1]!,
                    ...current.slice(0, -1),
                  ]),
                'Tiles → rotate',
              )
            }
          >
            Rotate
          </button>
          <button
            type="button"
            onClick={() =>
              tiles.update(() => {
                throw new Error('deliberate: the mutation threw');
              }, 'Tiles → throwing update')
            }
          >
            Throw in update
          </button>
          <output>order: {order().join(' · ')}</output>
        </div>
        <div class="motion-api-lab-tiles" data-mode={grid() ? 'grid' : 'row'} ref={tiles.ref}>
          <For each={order()}>
            {(chip) => (
              <motion.div layout class="motion-api-lab-tile">
                <motion.span layout="position">{chip}</motion.span>
              </motion.div>
            )}
          </For>
        </div>
      </section>

      <section class="motion-api-lab-panel" aria-labelledby="motion-api-refs">
        <h2 id="motion-api-refs">3. Refs and server-rendered initial styles</h2>
        <p>
          The scope and the probe are composed the native way,{' '}
          <code>ref={'{[refScope.ref, probe]}'}</code>. The component strips the caller&apos;s ref
          from the spread, binds its own visual element first, and applies the caller&apos;s ref
          through <code>applyRef()</code> — the primitive Solid uses for a ref array on a DOM
          element, so arrays and nesting behave as they do everywhere else. The box&apos;s label is
          a nested <code>layout=&quot;position&quot;</code> node, so the padding change animates the
          box without stretching the text.
        </p>
        <output class="motion-api-lab-readout">{refReport()}</output>
        <p>
          <code>initial</code> is written as inline style during render, so the server response
          carries the first frame and there is no flash between the SSR paint and the first client
          animation. The three probe boxes have nothing after that frame: one has{' '}
          <code>initial</code> only, one <code>initial={'{false}'}</code> with a keyframe target,
          and one only a borrowed <code>values</code> record, so what the server ships is what
          stays on the element. A borrowed value is read with <code>get()</code> for that frame;
          an explicit <code>initial</code> key — or the <code>animate</code> target under{' '}
          <code>initial={'{false}'}</code> — wins over the value for the keys it names, the same
          precedence a React motion component applies. The same values seed the element&apos;s
          renderer, so when a later target animates another key the transform is rebuilt from the
          initial ones rather than replaced by it.
        </p>
        <p>
          <code>initial={'{false}'}</code> keeps the React meaning: the mount animation is skipped,
          so the element starts at its first <code>animate</code> target and that target is what the
          first paint ships. A keyframe array contributes its last frame — where the skipped
          animation would have ended — so it renders without animating too, on the server and on the
          first client frame. Only the mount is skipped; a target that changes afterwards animates
          as usual.
        </p>
        <div class="motion-api-lab-toolbar">
          <button
            type="button"
            onClick={() => refScope.update(() => setWide((value) => !value), 'Refs → widen')}
          >
            {wide() ? 'Narrow' : 'Widen'}
          </button>
          <button type="button" onClick={readRefs}>
            Check refs again
          </button>
          <button type="button" onClick={readSsr}>
            Read the server&apos;s markup
          </button>
        </div>
        <div class="motion-api-lab-refrow">
          <motion.div
            layout
            ref={[refScope.ref, probe]}
            class="motion-api-lab-refbox"
            data-wide={wide() ? '' : undefined}
          >
            <motion.span layout="position">scope + probe</motion.span>
          </motion.div>
          <motion.div
            class="motion-api-lab-initial"
            data-ssr-probe
            initial={{ x: -12, opacity: 0.5 }}
          >
            initial only
          </motion.div>
          <motion.div
            class="motion-api-lab-initial"
            data-ssr-probe
            initial={false}
            animate={{ x: [0, 24] }}
          >
            initial={'{false}'}
          </motion.div>
        </div>
        <motion.div
          class="motion-api-lab-initial motion-api-lab-borrowed"
          data-ssr-probe
          values={{ x: borrowedX }}
        >
          values only
        </motion.div>
        <Show when={ssr()}>
          <output class="motion-api-lab-readout">{ssr()}</output>
        </Show>
      </section>

      <section class="motion-api-lab-panel" aria-labelledby="motion-api-radius">
        <h2 id="motion-api-radius">4. Border radius: px only</h2>
        <p>
          These cards animate <code>borderRadius</code> through their own visual element — no{' '}
          <code>styleEffect()</code> binding, so none of the reported styleEffect handoff retention
          is exercised here. Motion&apos;s scale corrector rewrites the four corner properties as a
          percentage of the projected box on every projected frame, and it only converts px: a
          number, or a string ending in <code>px</code>. The number is the public requirement, the
          same one a React <code>motion.div</code> has. A <code>rem</code> string is returned
          unchanged, so the corner is stretched with the box during the run — the jump a CSS radius
          has. On a shared element (not this page) the blend parses both radii with{' '}
          <code>parseFloat</code> first, which is what makes <code>'0.6rem'</code> reach the
          corrector as 0.6; that is the refs page&apos;s finding, not reproduced here.
        </p>
        <p>
          <strong>Not addressed here:</strong> replacing a branch that carries a{' '}
          <code>styleEffect()</code> binding, and leaving the route, are the cases where the
          handoff has been observed to retain state. This page avoids the binding rather than
          claiming it is fixed. The card&apos;s copy is a pair of nested{' '}
          <code>layout=&quot;position&quot;</code> nodes, so the box can change size without
          stretching the text.
        </p>
        <div class="motion-api-lab-hero-grid">
          <For each={RADIUS_CASES}>
            {(item) => {
              const boundary = createLayoutBoundary(boundaryOptions);
              const [expanded, setExpanded] = createSignal(false);
              const [mid, setMid] = createSignal<RadiusSample>();
              const [last, setLast] = createSignal<RadiusSample>();
              let slot: HTMLDivElement | undefined;
              let frame = 0;

              onCleanup(() => {
                if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
              });

              const sampleRun = () => {
                const scope = slot;
                if (!scope) return;
                cancelAnimationFrame(frame);
                const started = performance.now();
                let best: RadiusSample | undefined;
                let bestCorrected: RadiusSample | undefined;
                let final: RadiusSample | undefined;
                const tick = () => {
                  const hero = scope.querySelector<HTMLElement>('[data-layout]');
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
                    final = sample;
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
                    setLast(final);
                  }
                };
                frame = requestAnimationFrame(tick);
              };

              const toggle = () => {
                const next = !expanded();
                boundary.update(
                  () => setExpanded(next),
                  `Radius ${item.id} → ${next ? 'wide' : 'narrow'}`,
                );
                setMid(undefined);
                setLast(undefined);
                sampleRun();
              };

              return (
                <article class="motion-api-lab-hero-card">
                  <div class="motion-api-lab-toolbar">
                    <button type="button" onClick={toggle}>
                      {expanded() ? 'Collapse' : 'Expand'}
                    </button>
                    <code>{item.label}</code>
                  </div>
                  <div
                    class="motion-api-lab-hero-slot"
                    ref={[boundary.ref, (element) => (slot = element)]}
                  >
                    <motion.div
                      layout
                      class="motion-api-lab-hero"
                      data-wide={expanded() ? '' : undefined}
                      animate={{ borderRadius: item.radius }}
                      transition={SPRING}
                    >
                      <motion.span layout="position">Hero</motion.span>
                      <motion.span layout="position">
                        <small>{item.label}</small>
                      </motion.span>
                    </motion.div>
                  </div>
                  <output class="motion-api-lab-readout" aria-live="off">
                    <Show when={mid()} fallback={<span>inline radius: — (no run yet)</span>}>
                      <span>
                        mid-run: <code>{mid()!.inline || 'no inline radius'}</code> at{' '}
                        {mid()!.ms}ms · scale {mid()!.scale} · corrected:{' '}
                        {mid()!.corrected ? 'yes' : 'no'}
                      </span>
                      <Show when={last()}>
                        <span>
                          {' '}
                          · last sample: <code>{last()!.inline || 'none'}</code>
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

      <section class="motion-api-lab-panel" aria-labelledby="motion-api-runs">
        <h2 id="motion-api-runs">Runs</h2>
        <Show
          when={runs().length > 0}
          fallback={<p class="motion-api-lab-empty">No runs yet. Press a button above.</p>}
        >
          <ol class="motion-api-lab-log" aria-live="polite">
            <For each={runs()}>
              {(run) => (
                <li>
                  <span class="motion-api-lab-log-label">{run.label}</span>
                  <span class="motion-api-lab-log-stats">
                    <Show
                      when={run.error}
                      fallback={`in flight at update: ${run.inFlight} · finalised in ${run.ms}ms`}
                    >
                      failed: {run.error}
                    </Show>
                  </span>
                </li>
              )}
            </For>
          </ol>
        </Show>
      </section>

      <section class="motion-api-lab-panel" aria-labelledby="motion-api-limits">
        <h2 id="motion-api-limits">Limits of the spike</h2>
        <ul class="motion-api-lab-limits">
          <li>
            It is built on exported engine pieces, not a documented component API:{' '}
            <code>HTMLVisualElement</code>, <code>animateElement()</code>, <code>applyRef()</code>.
            Pin <code>motion</code> and re-check after an upgrade.
          </li>
          <li>
            Every element creates a visual element on mount, animated or not. That renderer is
            also what unmounts the projection node Motion attaches to a layout element: observed
            in dev, after a layout run the projection tree is back to its document root once this
            route is left, mid-run included. A <code>static</code> factory that skips the renderer
            for props-only nodes would need to keep that release.
          </li>
          <li>
            No exit animations, variants, or a shared element that crosses a branch swap. Those
            are the cases where the <code>styleEffect()</code> handoff has been observed to retain
            state; this page keeps clear of them rather than claiming a fix.
          </li>
          <li>
            Transform shorthands on <code>style</code> are not intercepted. Move them with{' '}
            <code>animate</code>/<code>initial</code>, or own the value and pass it through{' '}
            <code>values</code>. A <code>style</code> keeps the shape it had when the element was
            created: an object is written key by key and stays reactive, a string is a whole cssText
            and is written once, at mount. A value of the other shape arriving later is reported and
            ignored, because Solid would either rewrite the cssText in one assignment — replacing
            the transform the element animates — or drop the rest of it. Keep one shape; pass an
            object for a reactive style.
          </li>
          <li>
            <code>initial</code> takes static values only: a number or a string per key. Keyframe
            arrays, variant labels, <code>MotionValue</code>s and functions are not an initial
            frame; own a value through <code>values</code> or animate it. <code>initial</code> is
            read once, when the element is created.{' '}
            <code>initial={'{false}'}</code> reads its frame from the first <code>animate</code>{' '}
            target, and a keyframe array there contributes its last frame — the value the skipped
            mount animation would have ended on — so it ships as the first paint instead of
            animating.
          </li>
          <li>
            <code>values</code> is captured when the element mounts and the values are borrowed.
            The element subscribes to each on mount and unsubscribes on unmount; it never destroys
            one. A caller-owned value therefore outlives the element — one value can drive the
            next element — while a <code>createMotionValue()</code> value is destroyed with its
            Solid owner. Replacing the record later does not rebind the element: the renderer keeps
            the values it was bound with. Each value’s current frame seeds the first paint, the
            server response included, so a nonzero value does not start at the renderer’s default;
            an explicit <code>initial</code> key — or the <code>animate</code> target under{' '}
            <code>initial={'{false}'}</code> — wins over the value for the keys it names. That
            frame is part of the response, so the value has to start on the same frame on the
            server and the client; a value created differently on each hydrates onto a different
            first paint.
          </li>
          <li>
            <code>whileHover</code>/<code>whilePress</code> are read once at mount. Their targets
            layer over <code>animate</code> per property (<code>animate</code> &lt; hover &lt;
            press), and layout is only animated inside <code>update()</code> — there is deliberately
            no interception of state.
          </li>
          <li>
            <code>transitionEnd</code> is rejected, in the prop type and at runtime. Motion applies
            it after an animation settles, outside the priority layers, so it can overwrite a
            gesture that owns the same property by then. Put the value in the target itself, or in a
            higher-priority layer that owns it.
          </li>
        </ul>
      </section>
    </main>
  );
}
