# Solid Motion Lab

Motion's vanilla layout API (`animateLayout()` from `motion` 14.8.0) driven
straight from Solid 2 signals, on Solid's SSR/fullstack toolchain. No wrapper
components, no adapter: each experiment is one
`animateLayout(scope, updateDom, transition)` call, and the page is the
experiment harness.

The repo started as the Solid `fullstack` template; the home/counter/users/
session/API sample was removed, so the lab is the layout harness on `/`, the
refs page on `/refs`, and a 404.

## What the page shows

| Experiment      | DOM                                                     | What it exercises                                        |
| --------------- | ------------------------------------------------------- | -------------------------------------------------------- |
| Layout toggle   | four `data-layout` tiles in a flex row → 2-col grid      | size/position change on nodes Motion already tracks       |
| Keyed reorder   | four `data-layout` chips, Solid's keyed `<For>`           | element identity preserved, so Motion moves rather than remounts |
| Shared element  | one `data-layout-id="hero"` node swapped between branches | a replacement node: the outgoing node is measured in the pre-update snapshot, the incoming node is adopted at reconcile |

Each run is logged with the strategy used, how many layout/shared nodes were in
the scope when Motion finalized the run, and how long the click took to get
there. The log is a snapshot of the scope, not a count of that run's animations.

Every layout node that paints text nests a position-only layout node inside it:
`data-layout="position"` on `/` and `/refs`, `motion.span layout="position"` on
`/motion`. Motion projects that descendant too, so it counter-scales the copy
against the animated box instead of stretching the letters. It applies to both
branches of a shared hero as well. Those nodes are `display: inline-block`
because a transform on a non-replaced inline box is ignored, and the
counter-scale would never reach the text.

- `src/routes/index.tsx` — the lab (state, strategies, log)
- `src/routes/index.css` — its styles, scoped under `.motion-lab`
- `src/routes/index.test.tsx` — jsdom harness with a mocked `animateLayout`
  that reproduces Motion's scheduling (see [Tests](#tests))
- `src/routes/refs.tsx` — the refs page: two local composables, a shared-element
  radius comparison, and the same kind of run log
- `src/routes/refs.css` — its styles, scoped under `.refs-lab`
- `src/routes/refs.test.tsx` — jsdom harness for the composables' boundary,
  cleanup and ref binding
- `src/routes/[...404].tsx` — 404 that returns status 404 and links back
- `src/router.ts`, `src/App.tsx`, `src/Document.tsx` — file routes, shell, document
- `env.ts` — typed client env (`VITE_APP_NAME`, default `Solid Motion Lab`)

### The refs page (`/refs`)

The page keeps both experiments in `src/routes/refs.tsx`; there are no lib
files.

| Composable | Returns | What it owns |
| ---------- | ------- | ------------ |
| `createLayoutScope()` | `{ ref, update }` | the scope element, the set of running groups, `onCleanup` |
| `createStyleRef(values)` | a ref callback | a `styleEffect()` binding for the element the ref receives |

Both follow Solid 2's two-phase ref shape. The setup half runs under the
component owner, where `onCleanup` is registered; the returned callback runs
with no owner (`runWithOwner(null)` in `@solidjs/web`), so it only writes DOM
state and never returns a cleanup. `update(mutate, label)` is the explicit
update boundary: it calls `animateLayout(scope, () => { mutate(); flush(); })`,
then tracks the group until it settles. With no scope element (the server, or a
ref that has not attached) it runs the mutation without animating and without
touching the DOM.

The shared-element section runs three copies of the hero — no binding, a
`borderRadius` of `9.6` (px), and `'0.6rem'` — and samples the inline corner
radius and projection scale during each run. The result is under
[Border radius handoff](#border-radius-handoff-refs-page).

## Versions tested

`motion@14.8.0`, `solid-js@2.0.0-rc.19`, `@solidjs/web@2.0.0-rc.19`,
`@solidjs/router@2.0.0-next.43`, `@solidjs/meta@1.0.0-next.2`,
`@solidjs/vite-plugin@3.0.0-next.52`, `vite@8.3.0`, `vitest@5.0.1`,
`typescript@5.9.3`, Node 26.12.1, pnpm 9.15.9. Browser observations are from
**headless Chromium 156.0.0.0** (agent-browser). Nothing was checked in Safari
or Firefox.

## Run it

```bash
pnpm install
pnpm dev                 # http://localhost:3000 (streaming SSR)
pnpm dev --port 4322     # alternate port, diagnostics on /__solid/diagnostics

pnpm test                # vitest, jsdom
pnpm test:e2e            # Playwright browser checks, its own dev server on 4399
pnpm lint                # oxlint src
pnpm build               # dist/client + dist/server (handler + node.js)
PORT=4321 node dist/server/node.js   # or: pnpm start (reads .env if present)
```

There is no `typecheck` script; the check used here was `pnpm exec tsc --noEmit`.
`pnpm test` starts vitest in watch mode — `pnpm test run` is the one-shot run.

## How `animateLayout` commits (from the 14.8.0 source)

Useful because the three strategies only make sense as answers to it:

1. `animateLayout()` does **not** run the update immediately. It queues a
   `LayoutAnimationBuilder` and schedules `flushPendingBuilders` on a microtask.
2. On that microtask Motion snapshots every tracked node in the scope, then calls
   `updateDom()` for each builder created in the same tick.
3. If the callback returns nothing, Motion reconciles **in the same microtask**:
   additions (new `data-layout` nodes) are adopted, removals (nodes no longer
   connected) are dropped. If it returns a promise, the reconcile waits for
   `Promise.all(updatePromises)` — the builder's commit hook.
4. The builder then settles with a `GroupAnimation`, which keeps running after
   the promise resolves.

Solid 2 has the same shape one step later: writes are visible after its own
microtask, or synchronously after `flush()`. The strategies choose which of those
lands before Motion reconciles.

## The three strategies, and what they actually did

| Strategy  | Callback                         | Motion reconciles…                                  |
| --------- | -------------------------------- | --------------------------------------------------- |
| `flush`   | mutate, then `flush()`           | after Solid has written the DOM — synchronous baseline |
| `batched` | mutate only                      | before Solid writes the DOM (Solid sits on its microtask) |
| `promise` | return a promise resolved on a microtask | after Solid's commit, via `Promise.all(updatePromises).then(commit)` |

Measured in Chromium (headless 156), shared-element Expand under each strategy:

- **`flush`** — the new hero receives projection frames
  (`transform: translate3d(-323.9px, -53.7px, 0) scale(0.21, 0.44)` → … → `scale(1, 1)`),
  i.e. it animates from the collapsed box. All three experiments animate.
  This is the reliable baseline.
- **`batched`** (setter alone, the "obvious" Solid call) — Motion reconciled the
  collapsed branch that Solid had not replaced yet. Existing nodes still animate:
  chips under Rotate received full `translate3d` projection frames. But the
  replacement hero got `transform: none` and appeared in its final layout
  instantly — the shared-element case is simply not animated. The run log still
  reports `shared: 1`, because it describes the scope, not the animation.
- **`promise`** — the new hero receives the same frames as `flush` in Chromium
  (sampled mid-run), and the jsdom harness also asserts Motion's commit is
  deferred (`deferredForUpdate: true`) and reconciles the committed DOM.
  **Caveat: returning a promise from the update callback is not in the
  documented `animateLayout` API** (the 14.8.0 docs show only synchronous
  callbacks). It works because the builder happens to `Promise.all` non-void
  results, and `flushLayoutSnapshots` is exported for "renderers that tell us a
  DOM update is about to happen and then make it synchronously … with
  `updateDom` returning a promise". Treat it as implementation behavior that
  can change between versions, not a contract.

Push the shared-element case further: under `batched` the expanded branch is
painted at final size with no transition; under the other two it springs from
the collapsed box.

## How this differs from the React integration

Motion for React snapshots and reconciles around **React's own commit** — the
`layout` prop / `layoutId` on `motion` components hooks `willUpdate`/`didUpdate`
to React's lifecycle, and `<AnimatePresence>` runs exit/crossfade for a removed
`layoutId`. Nothing of that exists in the vanilla path: `animateLayout` has no
idea when your framework writes the DOM, which is exactly why it takes an
`updateDom` callback. The docs also say the vanilla build has no
`<AnimatePresence>` equivalent yet, so crossfading out of an removed node is not
available. For a shared element, the outgoing node only has to be there when
Motion takes its snapshot, before `updateDom`; the incoming node has to be there
at reconcile, where Motion matches it by `data-layout-id` and hands it the
outgoing snapshot.

So, for Solid: `flush()` is the equivalent of "tell Motion after the commit"
with no extra API; the promise hand-off is the same idea expressed through the
builder's commit hook, minus the documentation.

## Springs and interruption

Every run uses one transition:
`{ type: 'spring', visualDuration: 0.4, bounce: 0.2 }`. Layout is animated
through a single 0→1 progress value per node, so the spring is on progress, not
on width/height.

Observed: a second click while a run is in flight starts a new builder
immediately — no queue, no lock; the log gets a second entry while the first
animation is still running. Motion re-measures the scope and the new animation
continues from the interrupted projection: a chip moving with
`translateX(135.753px)` when interrupted was still at `135.753px` on the first
frame of the new run, then headed for its new layout — it did not snap back to
the old layout's origin.

**Velocity caveat:** Motion's `spring` takes `velocity` defaulting to "current
value velocity", but a fresh `animateLayout` builder creates a new animation for
the node, and this lab did not measure whether the interrupted velocity is
carried across builders. Position continuity is observed; velocity continuity is
untested — do not read the interruption hand-off as momentum preservation.

Interruption also leaves the previous group without an end signal: Motion stops
a node's previous layout animation when the new run starts it, and a stopped
Motion animation never settles `finished`. The page prunes interrupted groups
when it tracks a new one rather than waiting on a settle that never comes, so
teardown only holds animations that are still writing.

## The vanilla border-radius jump

Observed on this build: Motion writes only `transform` (and `transform-origin`)
inline on animated nodes. During a shared-element run the hero's inline style is
`transform: translate3d(...) scale(0.21, 0.44)` while its computed
`border-radius` stays `9.6px` (the CSS `0.6rem`), and the tiles behave the same
way (`8px`, `0.5rem`). Because the radius is part of the box and the box is
scaled non-uniformly, corners go elliptical while the spring runs and snap back
to the CSS radius when the inline transform is cleared at the end — the visible
"jump". No inline `border-radius` correction was written for these elements in
our samples; Motion does ship scale correctors for radius, so a setup that
triggers them would make the snap an explicit inline-style change instead.

### Border radius handoff (refs page)

The refs page answers the follow-up: `styleEffect(element, { borderRadius })` is
a public binding, `animateLayout()` takes the bound values into the visual
element it creates for the node (`resolveVisualElement` → `handOffElementState`),
and a shared element's blend then mixes `borderRadius` from the old node's
values to the new node's. With the value in the projection renderer's
`latestValues`, the scale corrector (`correctBorderRadius`) rewrites the four
inline corner properties as percentages of the target box on every projected
frame.

Measured in headless Chromium on the production build, expanding the px card
(`borderRadius: 9.6`, the CSS `0.6rem` at a 16px root):

- **px binding** — at 4ms the inline corner was `border-top-left-radius: 7.5%
  15%` with element scale `0.4836, 0.4`. The expanded box is 265×160, so 7.5% of
  265 × 0.4836 ≈ 9.6px and 15% of 160 × 0.4 = 9.6px: the painted corner stays a
  9.6px circle while the box is squashed. On collapse the sign flips (scale
  `2.07, 2.5`) and the percentage shrinks to compensate. The last sampled frame
  is back to `9.6px`; a later render restores the bound value.
- **no binding** — no inline corner property at all; the CSS radius is scaled
  with the box (9.6px × 0.4836 × 0.4 → an ellipse), i.e. the jump above.
- **`'0.6rem'` binding** — worse than nothing during a shared run. The corrector
  only converts px numbers/strings, but the shared blend runs first and
  `mixValues` parses both radii with `parseFloat`, dropping the unit: the
  corrector receives the number `0.6` and treats it as 0.6px, writing `0.46875%
  0.9375%` (≈0.6px of the projected box). Corners nearly square off mid-run,
  then the inline value returns to `0.6rem`. A non-px string is not corrected at
  all outside the shared path, so binding `rem` buys nothing and costs this.

Caveats for the handoff:

- The binding has to exist **before** the node is adopted. `handOffElementState`
  runs when `resolveVisualElement` creates the visual element, which for the
  incoming branch is at reconcile. The ref callback runs during Solid's commit,
  which is inside `updateDom`, so it is early enough; binding later is not part
  of this path.
- Writing the **same** MotionValue after adoption still works: the refs page's
  "thicker radius" button moves the px hero from `9.6px` to `24px` while the
  node has a visual element (inline `border-radius: 24px`), and the next shared
  run corrects 24px instead — `9.07% 15%` at scale `2.07, 2.5` over the 128×64
  collapsed box. The value is handed to the renderer, not copied and frozen.
- `styleEffect`, `motionValue`, `handOffElementState` and the corrector are all
  in `motion`'s exported type surface, but the layout documentation does not
  describe this interaction. Treat it as observed 14.8.0 behaviour, not a
  documented contract.

## Tests

16 tests in `src/routes/index.test.tsx`, jsdom, `motion` mocked. The mock keeps
the part the strategies exist to expose: the microtask queue, the update
callback, synchronous reconcile vs `Promise.all` deferral, and the builder
settling with an animation that outlives the promise. It records what the scope
looked like at reconcile time, so `flush`/`batched`/`promise` differences are
asserted as DOM snapshots, plus run overlap, unmount-mid-run, cleanup behavior,
and an interrupted run whose `finished` promise stays pending. It does not
exercise real animation frames, and nothing here or in the browser check
asserts Motion's actual curves, durations or timing: the mock never runs a
spring, and the browser check only observes projection transforms, not how
they move over time.

10 tests in `src/routes/refs.test.tsx`, jsdom, `animateLayout` and `styleEffect`
mocked. They cover the boundary (the mutation is in the DOM when the mock
reconciles), overlap and its in-flight count, owner-level cleanup for both
composables, releasing a settled group, rebinding the replacement branch,
binding only the px/rem branches, and driving a bound value from a control. The
radius correction itself is not asserted here: jsdom has no projection renderer,
so that claim rests on the browser observations above.

### Browser checks (Playwright)

`pnpm test:e2e` runs `e2e/hydration.spec.ts` and `e2e/layout-text.spec.ts` in
Chromium against the Vite dev server on port 4399 — `--strictPort`, one worker,
started and stopped by Playwright. Dev is deliberate: the dev build of
`solid-js` reports hydration mismatches, which a production build strips. The
three hydration checks on `/motion`:

- **No JavaScript.** Asserts the server response and its paint carry every
  `[data-ssr-probe]` frame — `initial={{ x: -12, opacity: 0.5 }}`, the
  `initial={false}` last keyframe `translateX(24px)`, and the borrowed
  `values={{ x }}` frame `translateX(40px)` — with the client-only ref report
  still empty, and that the refrow lays out as a wrapped two-column grid.
- **Hydration.** Holds every module script until the recorder has frozen a
  fully parsed, pre-script paint of the server markup, so no frame labelled
  "server paint" can be hydration already in flight. Records every
  `[data-layout]`/`[data-ssr-probe]` node from document-start, then hydrates.
  Asserts each probe was first seen while the document parsed (server
  markup), that hydration kept the same nodes, that every tracked node was
  sampled both before and after hydration at one box/transform/opacity, that
  the probe inline styles were not rewritten, and that every tracked node's
  frozen server paint (box, position, computed and inline transform/opacity)
  equals the no-JS page, along with the refrow geometry. Console errors and
  hydration warnings fail the run.
- **After hydration.** Clicks the refs "Widen" toggle, asserts the run log
  reports `Refs → widen` finalised, polls the committed height, and samples the
  inline transform through `DOMMatrix` from before the click: at least one
  sample must be numerically non-identity (more than half a pixel of
  translation or half a percent of scale), and that frame must come before the
  settled `none`. That is a hydration check that the boundary is still live
  after adoption, not an animation-correctness suite: spring curves, duration
  and timing are not asserted by this spec or by the jsdom tests, and remain
  unverified.

`layout-text.spec.ts` is the text-geometry check. For the tile toggle and the
shared hero on `/`, the ref box and radius card on `/motion`, and the shared
hero on `/refs`, it samples `getBoundingClientRect()` (painted, after every
ancestor transform) against `offsetWidth`/`offsetHeight` (layout) once per
frame, with the run interrupted by a second click. Every visible label has to
stay within 3% of its layout box, and at least one sampled frame has to have a
projected layout ancestor — otherwise a missing animation could pass vacuously.
Removing the `display: inline-block` rule fails the ref-box case at 0.56× its
layout width, which is the uncorrected shape this test exists to catch.

First run needs `pnpm exec playwright install chromium`. Only Chromium is
configured, matching the browser limitation above.

## Bundle size (measured snapshot)

One production build (`pnpm build`, versions under [Versions tested](#versions-tested)),
measured by hand. This is evidence, not a budget: chunk hashes change per build and
sizes move by a few hundred bytes between builds of the same source, so re-measure
after any change to source, dependencies or build config instead of quoting these
figures as current.

Method: each emitted asset is compressed on its own with `gzip -9` and `brotli -q 11`,
and the page totals are sums of those per-file results. That is what a browser pays
for separate responses, not the size of one compressed archive — every file pays its
own header and dictionary warm-up. kB below = 1,000 B.

The Motion split is a controlled A/B: the same source, with the `motion` import in
`src/routes/index.tsx` replaced by a no-op stub in a copy of the project. Both builds
keep the same page, state, shell and entry, so the stub removes the engine and the
animation work while the animation-free page still holds this route's UI and log. That
makes it a page-level comparison: the remainder is Solid, the router and the route's
own code together, not an isolated Solid/router measurement. No React, Next.js or
minimal-framework baseline was built, so no cross-framework comparison is claimed.

| Asset (client)                         | Role                              | Raw kB | gzip kB | brotli kB |
| -------------------------------------- | --------------------------------- | -----: | ------: | --------: |
| `virtual_solid-ssr-entry-client-*.js`  | entry                             |    1.0 |     0.6 |       0.5 |
| `web-*.js`                             | `solid-js/web` runtime            |   71.1 |    26.6 |      24.3 |
| `dist-*.js`                            | `solid-js` core + `@solidjs/meta` |    8.4 |     2.9 |       2.6 |
| `router-*.js`                          | `@solidjs/router`                 |   25.7 |    10.2 |       9.3 |
| `index-*.js`                           | the lab route + Motion            |  108.9 |    36.1 |      32.6 |
| initial JS (sum of the five above)     | what the first paint loads        |  215.1 |    76.4 |      69.3 |
| `index-*.css` (route)                  | lab styles                        |    2.7 |     0.9 |       0.7 |
| `virtual_solid-ssr-entry-client-*.css` | app styles                        |    0.4 |     0.3 |       0.2 |
| `_.404_*.js`                           | 404 (not loaded first)            |    0.5 |     0.4 |       0.3 |
| document HTML                          | SSR of `/`                        |    6.0 |     2.4 |       1.9 |

**This table predates the refs route.** With a second route importing `motion`,
the current build factors the engine into a shared `animate-layout-*.js` chunk
(101.7 kB raw / 33.7 kB gzip in the build measured here), leaves ~8 kB per
route, and merges the web runtime into the router chunk. Both pages load the
shared chunks; a navigation between them reuses them. The figures above describe
the single-route build and were not re-measured after the route was added.

- **Initial page load.** Confirmed with
  `performance.getEntriesByType('resource')`: entry + `web` + `dist` + `router` +
  route chunk = 215.1 kB raw / 76.4 gzip / 69.3 brotli of JS, plus the two
  stylesheets (3.1 / 1.2 / 0.9). The SSR head `modulepreload`s the four non-entry
  chunks next to the entry's `<script type="module">`, so the route chunk is not a
  late fetch; the 404 chunk is not requested. The favicon is 15.1 kB.
- **Motion delta**: with Motion stubbed out, the same page is 113.2 kB raw / 43.0
  gzip / 39.0 brotli of initial JS, so the animation layer costs roughly 101.9 /
  33.3 / 30.3 kB — ≈94% of the route chunk and ≈47% of the initial JS. Here Motion
  is the dominant client cost and almost entirely additive: the page's UI, state and
  log survive without it. Both sides carry the route's own code, so read the delta as
  this page's animation work with the engine included, not as the `motion` package
  in isolation. It subtracts two per-file sums, so it estimates incremental transfer
  rather than matching it byte for byte.
- **The engine is broad despite tree shaking.** The page calls exactly one export,
  `animateLayout`, and imports the full `motion` entry — not `motion/mini`, which was
  not measured. The route chunk's sourcemap still attributes 169 of `motion-dom`'s
  248 ES modules, and 23 of `motion-utils`' 30, to it, spanning `animation`, `value`,
  `projection`, `render`, `frameloop`, `layout` and `effects`. A layout-only page
  pays for more engine than it calls, so a smaller entry is where trimming would
  start.
- **No React in the bundle.** The same sourcemaps list `motion-dom`, `motion-utils`
  and this route, with no `motion/react` and no `react-dom`: these figures are the
  vanilla engine's, and nothing here measures the React integration.
- **Wire size.** The emitted Node server does not compress responses, so bytes on the
  wire from it equal the raw column; the gzip and brotli columns are what a
  compressing CDN or proxy would send.

Reproduce:

```bash
pnpm build
for f in dist/client/assets/*.js dist/client/assets/*.css; do
  printf '%-46s %8s %8s %8s\n' "$(basename "$f")" \
    "$(wc -c <"$f")" "$(gzip -9c "$f" | wc -c)" "$(brotli -q 11 -c "$f" | wc -c)"
done
```

Motion delta (needs the `brotli` CLI):

```bash
rsync -a --exclude node_modules --exclude dist --exclude .env ./ /tmp/motion-size-baseline/
ln -s "$PWD/node_modules" /tmp/motion-size-baseline/node_modules
# in /tmp/motion-size-baseline: replace
#   import { animateLayout, type GroupAnimation } from 'motion';
# with
#   import { animateLayout } from './motion-stub';
#   type GroupAnimation = { animations: Array<{ state: string }>; finished: Promise<unknown>; stop: () => void };
# and add src/routes/motion-stub.ts with a no-op animateLayout, e.g.
# (sizing only: it does not reproduce Motion's scheduling)
#   export const animateLayout = (_scope, updateDom) => {
#     updateDom();
#     return Promise.resolve({ animations: [], finished: Promise.resolve(), stop: () => {} });
#   };
# then:
(cd /tmp/motion-size-baseline && pnpm build)
```

Initial-load set: `PORT=4321 node dist/server/node.js`, open the page, then
`performance.getEntriesByType('resource').map((e) => e.name)` in devtools.

## Limitations

- **Chromium only.** All browser observations above are headless Chromium 156 on
  one macOS machine. Safari/Firefox, reduced-motion settings, and real
  (non-headless) compositing were not checked.
- **No broad guarantees.** These are observations on one page, one version, one
  build. Motion's scheduling is internal behaviour; the promise hand-off in
  particular is undocumented. Re-measure after upgrading `motion`.
- **The radius handoff is an interaction, not a documented feature.** Binding a
  px `borderRadius` before `animateLayout()` adopts a node is what makes its
  scale corrector run; nothing in Motion's layout docs promises that, and the
  non-px case produces a wrong value rather than an error.
- **The jsdom harness is a mock.** It reproduces Motion's scheduling contract,
  not its animation engine; it cannot catch visual regressions, and it never
  runs a spring, so curve shape, duration and timing are untested. The browser
  spec observes projection transforms but not how they evolve. The numbers in
  the run log (layout nodes/shared/reconcile ms) describe the scope at
  reconcile time, not what was animated.
- **Bundle numbers are a snapshot**, not a budget (see
  [Bundle size](#bundle-size-measured-snapshot)): minifier and chunk split are
  build-configuration dependent, and `gzip -9`/`brotli -q 11` differ from what a
  given CDN sends.

## Motion documentation used

- [Layout animations (vanilla `animateLayout`, `data-layout`, `data-layout-id`)](https://motion.dev/docs/layout-animations)
- [Layout animation for React (`layout`, `layoutId`, `AnimatePresence`)](https://motion.dev/docs/react-layout-animations)
- [spring (options, `velocity` default)](https://motion.dev/docs/spring)
- [animate (`animateLayout` returns the same controls)](https://motion.dev/docs/animate)
- [styleEffect (the binding the refs page uses)](https://motion.dev/docs/style-effect)
- [motionValue](https://motion.dev/docs/motion-value)
- Examples: [JS layout animation](https://motion.dev/examples/js-layout-animation),
  [JS shared layout animation](https://motion.dev/examples/js-shared-layout-animation)

## Deploying

SSR is preserved: `vite build` emits `dist/client` (static assets) and
`dist/server` (handler + `node.js` server). Run `node dist/server/node.js` with
`PORT` set. Any adapter can import `handleRequest`/`app.fetch` from
`dist/server/server.js` instead. `VITE_APP_NAME` is baked at build time; there
are no server environment variables. Dev-only diagnostics live at
`/__solid/diagnostics` (GET status, POST `{"method":"begin"|"end"}`).
