import {
  inView as watchInView,
  scopeMotion,
  type MotionScope,
  type ScopeOptions,
  type ScopeSetup,
} from 'motion';
import {
  createEffect,
  createSignal,
  onSettled,
  type Accessor,
} from 'solid-js';

// The three Motion hooks that port cleanly to Solid 2 without a value layer.
// They are deliberately not React-shaped:
//
//   - `useReducedMotion()` is an environment subscription, so it becomes a
//     signal owned by the component that asks for it.
//   - `useInView(ref)` is a DOM observation, so it becomes `{ ref, inView }`
//     where the ref owns nothing: it writes the element into a signal and an
//     effect under the component owner starts/stops the observer.
//   - `useScopeMotion(ref, setup)` is a lifecycle adapter around Motion's own
//     `scopeMotion()`, again with the ref reduced to a slot.
//
// The owner split is the point. Solid 2 runs a ref callback with no owner
// (`runWithOwner(null)`, before the element is attached), and a cleanup it
// returns is dropped. Every external resource below — MediaQueryList listener,
// IntersectionObserver, MotionScope — is therefore created and released in the
// setup half (`onSettled` or a `createEffect` apply), never in the ref. The ref
// only writes the element into a signal, which is a DOM-independent value.
//
// SSR follows from the same split: none of this touches `window` at module
// scope or in a component body, and the initial signal values are the values
// the server rendered — `false` for both media and viewport state. A client
// that hydrates into a reduced-motion or in-view environment settles to the
// real value in the first post-mount pass, exactly as an effect does.

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * The user's `prefers-reduced-motion` setting, as a reactive boolean.
 *
 * The value is `false` during server rendering and the first client render,
 * then follows the media query from the first settled pass. That is deliberate:
 * the media setting is not available to the server, so reading it during render
 * would make the hydrated markup disagree with the one that was sent. Treat it
 * as a post-mount preference (skip an entrance animation, choose a transition)
 * rather than as a value that can shape the first paint.
 *
 * The listener belongs to the component owner, so it is removed on disposal and
 * on the server it is never installed at all.
 */
export function createReducedMotion(): Accessor<boolean> {
  const [reduced, setReduced] = createSignal(false);

  // `onSettled` is the post-mount pass: the render exists, and the returned
  // cleanup is owned by the component. On the server there is no matchMedia to
  // ask, so the callback exits before it touches anything.
  onSettled(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const media = window.matchMedia(REDUCED_MOTION_QUERY);
    setReduced(media.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  });

  return reduced;
}

/**
 * Options for `createInView()`. `root`, `margin` and `amount` are Motion's own
 * `inView()` options; `once` is the React hook's convenience flag and is
 * implemented here by not asking Motion to watch the element after its first
 * intersection.
 *
 * The object is read when the element binds, not tracked: to observe with
 * different options, bind a different `createInView()` instance.
 */
export type CreateInViewOptions = NonNullable<Parameters<typeof watchInView>[2]> & {
  /**
   * Stop observing after the first time the element enters the viewport. The
   * accessor stays `true` (the element has been seen); only a new ref target
   * starts over.
   */
  once?: boolean;
};

export type InViewHandle = {
  /**
   * Attach to the element to observe. Composes with other refs:
   * `ref={[inView.ref, other]}`. It has no owner and returns no cleanup; the
   * observer is released with the component.
   */
  ref: (element: Element) => void;
  /** Whether the element is currently intersecting its root. */
  inView: Accessor<boolean>;
  /** The last entry Motion reported, for callbacks that need the ratio/rect. */
  entry: Accessor<IntersectionObserverEntry | undefined>;
};

/**
 * Track whether an element is in view using Motion's public `inView()`.
 *
 * `inView()` is a real observer subscription: it returns a cleanup and normally
 * unobserves when its start callback returns nothing. This wrapper keeps the
 * element observed and returns a state handler so leaving the viewport flips
 * the accessor back to `false`. With `once`, the start callback returns nothing
 * instead, which is Motion's own "fire once, then unobserve" path.
 *
 * If the environment has no `IntersectionObserver` (the server, jsdom without
 * a shim, an old browser), the ref is accepted and `inView()` stays `false`
 * rather than throwing. That is the only fallback: there is no polling
 * approximation of intersection.
 *
 * The observer belongs to the component, not to the element being mounted: Solid
 * 2 does not call a ref again when its element leaves the tree, so removing the
 * element without binding a replacement leaves it observed until the component
 * is disposed. A replacement target re-runs the effect, and its cleanup releases
 * the previous observer before the next one starts.
 */
export function createInView(options: CreateInViewOptions = {}): InViewHandle {
  const [inView, setInView] = createSignal(false);
  const [entry, setEntry] = createSignal<IntersectionObserverEntry>();
  const [element, setElement] = createSignal<Element>();
  let bound: Element | undefined;

  // The apply half owns the observer. The compute half is only the element
  // slot, so a ref that binds later (or replaces its target) re-runs setup and
  // the previous observer is disconnected before the next one starts.
  createEffect(
    () => element(),
    (target) => {
      if (!target || typeof IntersectionObserver === 'undefined') return;

      const stop = watchInView(
        target,
        (_element, startEntry) => {
          setInView(true);
          setEntry(startEntry);
          if (options.once) return;
          return (endEntry) => {
            setInView(false);
            setEntry(endEntry);
          };
        },
        {
          root: options.root,
          margin: options.margin,
          amount: options.amount,
        },
      );

      return () => stop();
    },
  );

  const ref = (next: Element) => {
    // A ref is ownerless; keep the identity check in a plain local rather than
    // reading the signal here, so this callback never becomes a tracking scope.
    if (next === bound) return;
    bound = next;
    // Reset the readouts so a replacement target starts hidden instead of
    // inheriting the previous element's state.
    setInView(false);
    setEntry(undefined);
    setElement(next);
  };

  return { ref, inView, entry };
}

/**
 * Options for `createMotionScope()`. `transition` and `matchMedia` are Motion's
 * scope options; `setup` is the scope body, run whenever a root is available
 * (and again when a `matchMedia` condition changes, as `scopeMotion()` does).
 *
 * The object is read when the scope is created. Changing it later does not
 * rebuild the scope; bind a new element or use `scope().refresh()` when that is
 * what Motion's own API would do.
 */
export type CreateMotionScopeOptions = Pick<ScopeOptions, 'transition' | 'matchMedia'> & {
  setup?: ScopeSetup;
};

export type MotionScopeHandle = {
  /**
   * Attach the scope root. Composes with other refs. The ref only records the
   * element; the scope itself is created in an owned effect, so this callback
   * neither needs an owner nor returns a cleanup.
   */
  ref: (element: Element) => void;
  /**
   * The live scope, or `undefined` before the element binds. Not a signal: a
   * caller reads it from an event handler or after mount, not during render.
   */
  scope(): MotionScope | undefined;
  /**
   * Run `callback` inside the live scope. Returns `undefined` and does not call
   * the callback when no element is bound yet (server render, or a ref that has
   * not run). This mirrors `scope.run()` without handing out a stale scope. The
   * callback runs in the caller's context, so it has no Solid owner to register
   * cleanups with — see `createMotionScope()`.
   */
  run<R>(callback: (scope: MotionScope) => R): R | undefined;
};

/**
 * A Solid lifecycle adapter around Motion's `scopeMotion()`.
 *
 * The scope is rooted at the element the ref receives. Anything started inside
 * `setup` or `run()` — animations, `inView()`, scroll listeners, gestures — is
 * collected by Motion and stopped together. The scope is cancelled when the
 * component is disposed or when the ref target changes, which also restores the
 * inline styles of elements the scope animated.
 *
 * The scope is created in an effect, not in the ref: this is what gives it an
 * owner-held cleanup and lets a branch swap cancel the previous scope before the
 * next one starts. `setup` may return a cleanup, which Motion attaches to the
 * scope itself; it is not a Solid cleanup and runs on `cancel()`/`refresh()`.
 *
 * Neither `setup` nor a `run()` callback runs with a Solid owner. `setup` runs
 * from Motion's own activation pass, which this adapter starts inside an effect
 * apply — and Solid 2 runs an apply without an owner — while `run()` runs in the
 * caller's context, which for an event handler or a Motion callback is no owner
 * at all. So Solid state created in either body is not owned by the component:
 * `onCleanup` there warns `NO_OWNER_CLEANUP` and never runs. Only Motion's
 * lifetime exists in those bodies: a function returned from `setup`, and
 * whatever animations, listeners or gestures Motion collects while they run.
 *
 * That lifetime follows the component, not the element in the DOM. Solid 2 does
 * not call a ref again when its element leaves the tree, so an element removed
 * without a replacement target leaves its scope active against a detached node
 * until the component is disposed; binding the next target, or disposing the
 * component, is what cancels it.
 */
export function createMotionScope(options: CreateMotionScopeOptions = {}): MotionScopeHandle {
  const [element, setElement] = createSignal<Element>();
  let current: MotionScope | undefined;

  createEffect(
    () => element(),
    (target) => {
      if (!target) return;

      const scope = scopeMotion(target, options.setup, {
        transition: options.transition,
        matchMedia: options.matchMedia,
      });
      current = scope;

      return () => {
        if (current === scope) current = undefined;
        scope.cancel();
      };
    },
  );

  return {
    ref: (next: Element) => setElement(next),
    scope: () => current,
    run(callback) {
      const scope = current;
      return scope ? scope.run(() => callback(scope)) : undefined;
    },
  };
}
