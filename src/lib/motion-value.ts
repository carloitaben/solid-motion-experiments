import { motionValue, type MotionValue } from 'motion';
import { createSignal, getOwner, onCleanup, type Accessor } from 'solid-js';

// Motion values are plain objects with a subscription API; nothing inside them
// knows about Solid. These primitives are the only place the two lifetimes
// meet, and they split along one rule:
//
//   createMotionValue(initial)       owns the value; the owner destroys it
//   createMotionValues(initials)     owns one value per key, disposed together
//   subscribeMotionValue(value, fn)  borrows the value for the owner's lifetime
//   createMotionValueAccessor(value) borrows it as a Solid accessor
//
// Whoever calls `motionValue()` (or `createMotionValue`) owns it, and only that
// caller destroys it. A `MotionValue` handed to anything else — a motion
// element's `values` prop, a subscription, an accessor — is borrowed. That is
// the same rule the engine already follows: `HTMLVisualElement.mount()`
// subscribes to the values it is handed and `unmount()` removes those
// subscriptions, so a page can bind one value to successive elements (a shared
// element swapping branches, the refs lab) without the element taking the value
// down with it.
//
// Nothing here touches the DOM, measures anything, or schedules a frame. A
// value can be created, read, subscribed to and set during SSR, where there is
// no element yet; the only frame source is whoever animates it.

/** A property → value record: the shape a motion element's `values` prop takes. */
export type MotionValues = Record<string, MotionValue>;

/**
 * Create a MotionValue owned by the current Solid owner.
 *
 * Disposing that owner destroys the value: Motion clears its listeners and
 * stops whatever animation is driving it, so nothing outside the page is left
 * subscribing to a value nobody renders any more. The last frame stays readable
 * through `get()`, which is what a farewell measurement wants.
 *
 * Called with no owner, the value belongs to the caller, who has to destroy it.
 * Registering a cleanup there would only warn in dev and never run, so the
 * guard keeps that case quiet rather than promising a cleanup that cannot
 * happen.
 */
export function createMotionValue<V>(initial: V): MotionValue<V> {
  const value = motionValue(initial);
  if (getOwner()) onCleanup(() => value.destroy());
  return value;
}

/**
 * Create one owned value per key, typed per key:
 * `createMotionValues({ x: 0, opacity: 1 })` gives
 * `{ x: MotionValue<number>, opacity: MotionValue<number> }`.
 *
 * This is a motion element's `values` prop, built at once. Each value registers
 * its own cleanup, so the record lives exactly as long as the owner it was
 * created under — not as long as an element that borrowed it — and every key is
 * disposed on the way out.
 */
export function createMotionValues<S extends Record<string, unknown>>(
  initials: S,
): { [K in keyof S]: MotionValue<S[K]> } {
  const values: MotionValues = {};
  // Own keys only: a record is what the caller handed over, not what it
  // inherits.
  for (const key of Object.keys(initials)) values[key] = createMotionValue(initials[key]);
  return values as { [K in keyof S]: MotionValue<S[K]> };
}

/**
 * Subscribe to a value's `change` event for the lifetime of the current owner,
 * and hand back an unsubscribe for callers that want to stop earlier.
 *
 * The value is borrowed, never destroyed: a subscriber is one of possibly
 * several (another component, an element's renderer) and does not own what it
 * listens to.
 */
export function subscribeMotionValue<V>(
  value: MotionValue<V>,
  listener: (value: V) => void,
): () => void {
  // The flag is the subscription's own state rather than Motion's: a manual
  // unsubscribe followed by the owner's cleanup is a no-op, and a listener
  // removed mid-notification is not handed the frame it was removed in.
  let subscribed = true;
  const stop = value.on('change', (next) => {
    if (subscribed) listener(next);
  });
  const unsubscribe = () => {
    if (!subscribed) return;
    subscribed = false;
    stop();
  };
  if (getOwner()) onCleanup(unsubscribe);
  return unsubscribe;
}

/**
 * Read a MotionValue as a Solid accessor.
 *
 * Opt in, and only where a render has to follow the value. Every `change`
 * writes a signal, so an animated value re-runs its readers on each frame that
 * moves it: right for a readout, wrong for a value an element animates through
 * its own renderer, which is already writing the DOM per frame. Nothing polls
 * per frame — the accessor is driven by the value's own `change` event — and a
 * value nobody animates costs nothing between sets.
 *
 * The first frame is read eagerly, so the accessor is correct before the first
 * change. What it writes is an ordinary Solid signal: the write lands when
 * Solid applies it, so a test reads `flush()` after `set()`, and it is a write
 * like any other — from an event handler, `onSettled`, or a Motion callback,
 * not from a component's construction pass, where Solid 2 rejects it. The
 * accessor does not opt that check out: a producer writing from there is
 * calling `set()` from the wrong place, and hiding it would hide the bug.
 *
 * The value is borrowed: disposing the owner unsubscribes, and the value keeps
 * running for its actual owner.
 */
export function createMotionValueAccessor<V>(value: MotionValue<V>): Accessor<V> {
  // The signal holds a record rather than the frame itself. `createSignal` reads
  // a function initial as a compute function and a function setter argument as
  // an updater, and `V` is only as wide as Motion's own generic: a value can
  // carry a function (a resolver, a callback a prop reads), and either end would
  // then call it instead of storing it. A record is never a function, so the
  // frame stays data whatever `V` is, and no cast is needed in or out. The cost
  // is one small object per change, paced by the value's own `change` event.
  const [frame, setFrame] = createSignal({ value: value.get() });
  subscribeMotionValue(value, (next) => setFrame({ value: next }));
  return () => frame().value;
}
