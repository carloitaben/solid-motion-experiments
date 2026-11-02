import { animate, animateLayout, motionValue, releaseElement, scopeMotion, styleEffect } from 'motion';

const SPRING = { type: 'spring', visualDuration: 0.35, bounce: 0.2 };
const BASE_RADIUS = 9.6;
const THICK_RADIUS = 24;

const frames = (count = 1) =>
  new Promise((resolve) => {
    let left = count;
    const tick = () => (left <= 0 ? resolve() : (left -= 1, requestAnimationFrame(tick)));
    requestAnimationFrame(tick);
  });

const readRadius = (element) =>
  element.style.getPropertyValue('border-top-left-radius') ||
  element.style.getPropertyValue('border-radius');

// MotionValue keeps its first listener outside the `events.change` manager.
const subscriberCount = (value) =>
  value ? (value.changeSubscriber ? 1 : 0) + (value.events?.change?.getSize?.() ?? 0) : 0;

const readScale = (transform) => {
  const match = transform.match(/scale\(([^)]*)\)/g)?.at(-1);
  if (!match) return { text: '—', deviation: 0 };
  const text = match.slice('scale('.length, -1);
  const [x = 1, y = x] = text.split(',').map(Number);
  return { text, deviation: Math.max(Math.abs(x - 1), Math.abs(y - 1)) };
};

const makeHero = (expanded, label) => {
  const element = document.createElement('div');
  element.className = `hero${expanded ? ' expanded' : ''}`;
  element.setAttribute('data-layout', '');
  element.setAttribute('data-layout-id', 'hero');
  element.textContent = `${expanded ? 'expanded' : 'collapsed'} · ${label}`;
  return element;
};

// Sample the incoming node's inline radius and element scale for one run.
const sampleRun = (current) =>
  new Promise((resolve) => {
    const started = performance.now();
    let bestCorrected = null;
    let best = null;
    let last = null;
    const tick = () => {
      const element = current();
      if (element) {
        const inline = readRadius(element);
        const scale = readScale(element.style.transform);
        const sample = {
          ms: Math.round(performance.now() - started),
          inline: inline || 'none',
          scale: scale.text,
          corrected: inline.includes('%'),
          deviation: scale.deviation,
        };
        last = sample;
        if (!best || sample.deviation > best.deviation) best = sample;
        if (sample.corrected && (!bestCorrected || sample.deviation > bestCorrected.deviation)) {
          bestCorrected = sample;
        }
      }
      if (performance.now() - started < 850) requestAnimationFrame(tick);
      else resolve({ best, bestCorrected, last });
    };
    requestAnimationFrame(tick);
  });

const scenariosRoot = document.getElementById('scenarios');
const reportRoot = document.getElementById('report');
const scenarios = new Map();

function makePanel(id, title, note) {
  const section = document.createElement('section');
  section.className = 'scenario';
  section.dataset.scenario = id;
  section.innerHTML = `
    <h2>${title}</h2>
    <p>${note}</p>
    <div class="toolbar">
      <button type="button" data-act="toggle">Expand</button>
      <button type="button" data-act="thicker">Radius ${THICK_RADIUS}</button>
      <button type="button" data-act="more">Toggle ×4</button>
    </div>
    <div class="slot"></div>
    <pre class="readout">no run yet</pre>
  `;
  scenariosRoot.append(section);
  return {
    section,
    slot: section.querySelector('.slot'),
    readout: section.querySelector('.readout'),
    toggleButton: section.querySelector('[data-act="toggle"]'),
    thickerButton: section.querySelector('[data-act="thicker"]'),
    moreButton: section.querySelector('[data-act="more"]'),
  };
}

/**
 * Build one experiment around a scope element.
 *
 * `def.create(expanded, state)` returns the node to mount.
 * `def.target(created, state)` optionally returns the layout node inside it.
 * `def.bind(element, radius, state)` returns the live value and its cleanup.
 * `def.swap(slot, state, previous)` changes the branch (or its class).
 * `def.setRadius(radius, state)` writes through the live binding.
 */
function createScenario(id, title, note, def) {
  const panel = makePanel(id, title, note);
  const state = {
    expanded: false,
    radius: BASE_RADIUS,
    current: null,
    binding: null,
    all: [],
    runs: 0,
    lastSample: null,
  };

  const adopt = (created) => {
    // Some scenarios mount a wrapper and bind the hero inside it.
    const element = def.target?.(created, state) ?? created;
    state.current = element;
    state.all.push(element);
    state.binding = def.bind(element, state.radius, state);
  };

  const initial = def.create(false, state);
  panel.slot.append(initial);
  adopt(initial);

  const updateButton = () => {
    panel.toggleButton.textContent = state.expanded ? 'Collapse' : 'Expand';
  };

  const toggle = async (sample = true) => {
    if (state.busy) return state.lastResult;
    state.busy = true;
    state.expanded = !state.expanded;
    updateButton();
    const previous = state.current;
    const previousBinding = state.binding;
    const sampled = sample ? sampleRun(() => state.current) : null;

    const animation = await animateLayout(
      panel.slot,
      () => {
        def.swap(panel.slot, state, previous);
        const next = state.current;
        if (next !== previous) {
          // Mirror the ref composable: release the outgoing binding before the
          // incoming branch binds. `releaseElement` is the public counterpart.
          previousBinding?.dispose?.();
          def.beforeAdopt?.(previous, state);
          adopt(next);
        }
      },
      SPRING,
    );

    await animation.finished;
    const result = await (sampled ?? Promise.resolve(null));
    state.lastSample = result;
    state.runs += 1;
    state.busy = false;
    state.lastResult = { animation, result };
    render();
    return state.lastResult;
  };

  const setRadius = async (next) => {
    state.radius = next;
    def.setRadius(next, state);
    await frames(2);
    render();
  };

  const probeDetached = async () => {
    const detached = state.all.filter((element) => !element.isConnected);
    const before = detached.map((element) => element.getAttribute('style'));
    const next = state.radius === THICK_RADIUS ? BASE_RADIUS : THICK_RADIUS;
    await setRadius(next);
    const after = detached.map((element) => element.getAttribute('style'));
    const changed = detached
      .map((element, index) => ({ element, before: before[index], after: after[index] }))
      .filter((entry) => entry.before !== entry.after);
    return {
      detached: detached.length,
      detachedUpdated: changed.length,
      changed: changed.map((entry) => entry.after),
      liveRadius: def.liveRadius(state),
      subscribers: def.subscribers(state),
    };
  };

  const render = () => {
    const result = state.lastSample;
    const sample = result?.bestCorrected ?? result?.best;
    panel.readout.textContent = [
      `runs: ${state.runs} · attached: ${state.all.filter((e) => e.isConnected).length} · detached: ${state.all.filter((e) => !e.isConnected).length}`,
      `live radius: ${def.liveRadius(state)} · subscribers: ${def.subscribers(state)}`,
      sample
        ? `mid-run: ${sample.inline} at ${sample.ms}ms · scale ${sample.scale} · corrected: ${sample.corrected ? 'yes' : 'no'}`
        : 'no sample',
      result?.last ? `last sample: ${result.last.inline}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  };

  panel.toggleButton.addEventListener('click', () => toggle());
  panel.thickerButton.addEventListener('click', () =>
    setRadius(state.radius === THICK_RADIUS ? BASE_RADIUS : THICK_RADIUS),
  );
  panel.moreButton.addEventListener('click', async () => {
    for (let i = 0; i < 4; i += 1) await toggle(false);
  });

  const scenario = { id, panel, state, toggle, setRadius, probeDetached, render };
  scenarios.set(id, scenario);
  return scenario;
}

// 1. The /refs approach: one MotionValue, a new styleEffect per branch.
createScenario(
  'rebind',
  '1. Rebind one value per branch (the /refs shape)',
  'One MotionValue survives branch swaps; styleEffect is disposed and re-bound on the incoming node before animateLayout adopts it.',
  {
    create: (expanded, state) => makeHero(expanded, state.radius),
    bind: (element, radius, state) => {
      const value = (state.value ??= motionValue(radius));
      const dispose = styleEffect(element, { borderRadius: value });
      return { value, dispose };
    },
    swap: (slot, state, previous) => {
      const next = makeHero(state.expanded, state.radius);
      previous.replaceWith(next);
      state.current = next;
    },
    setRadius: (radius, state) => state.value?.set(radius),
    liveRadius: (state) => state.value?.get(),
    subscribers: (state) => subscriberCount(state.value),
  },
);

// 2. The /refs shape plus every public cleanup we can name on the old node.
createScenario(
  'rebind-release',
  '2. Rebind + releaseElement(old)',
  'Same as 1, then dispose the outgoing binding and call releaseElement(old) on the detached node. Tests whether Motion offers a public way to un-adopt a handed-off value.',
  {
    create: (expanded, state) => makeHero(expanded, state.radius),
    bind: (element, radius, state) => {
      const value = (state.value ??= motionValue(radius));
      const dispose = styleEffect(element, { borderRadius: value });
      return { value, dispose };
    },
    swap: (slot, state, previous) => {
      const next = makeHero(state.expanded, state.radius);
      previous.replaceWith(next);
      state.current = next;
    },
    beforeAdopt: (previous, state) => {
      releaseElement(previous);
      state.released = (state.released ?? 0) + 1;
    },
    setRadius: (radius, state) => state.value?.set(radius),
    liveRadius: (state) => state.value?.get(),
    subscribers: (state) => subscriberCount(state.value),
  },
);

// 3. A fresh MotionValue per branch, with a plain number as the source.
createScenario(
  'fresh',
  '3. Fresh value per branch',
  'The live value is never shared with an adopted node. Each branch creates a new MotionValue at the current radius, so a detached branch keeps only its own value graph.',
  {
    create: (expanded, state) => makeHero(expanded, state.radius),
    bind: (element, radius) => {
      const value = motionValue(radius);
      const dispose = styleEffect(element, { borderRadius: value });
      return { value, dispose };
    },
    swap: (slot, state, previous) => {
      const next = makeHero(state.expanded, state.radius);
      previous.replaceWith(next);
      state.current = next;
    },
    setRadius: (radius, state) => state.binding?.value.set(radius),
    liveRadius: (state) => state.radius,
    subscribers: (state) => subscriberCount(state.binding?.value),
  },
);

// 4. One stable layout node; only its class changes (no branch swap).
createScenario(
  'stable',
  '4. Stable layout node',
  'The shared element is never replaced; only its class changes inside animateLayout. The binding is created once, so nothing is ever handed to a second visual element.',
  {
    create: (expanded) => makeHero(expanded, 'stable'),
    bind: (element, radius) => {
      const value = motionValue(radius);
      const dispose = styleEffect(element, { borderRadius: value });
      return { value, dispose };
    },
    swap: (slot, state) => {
      state.current.classList.toggle('expanded', state.expanded);
      state.current.textContent = `${state.expanded ? 'expanded' : 'collapsed'} · stable`;
    },
    setRadius: (radius, state) => state.binding?.value.set(radius),
    liveRadius: (state) => state.binding?.value.get(),
    subscribers: (state) => subscriberCount(state.binding?.value),
  },
);

// 5. A stable element moved between two branch containers.
createScenario(
  'reparent',
  '5. Stable node, reparented branch',
  'The hero identity survives; updateDom moves the same node into the other branch container and toggles its class. This keeps a branch-container transition without adopting a second element.',
  {
    create: (expanded, state) => {
      const fragment = document.createDocumentFragment();
      const wrapperA = document.createElement('div');
      wrapperA.className = 'branch-a';
      const wrapperB = document.createElement('div');
      wrapperB.className = 'branch-b';
      state.wrapperA = wrapperA;
      state.wrapperB = wrapperB;
      state.hero = makeHero(expanded, 'reparent');
      wrapperA.append(state.hero);
      fragment.append(wrapperA, wrapperB);
      return fragment;
    },
    target: (created, state) => state.hero,
    bind: (element, radius, state) => {
      const value = (state.value ??= motionValue(radius));
      const dispose = styleEffect(element, { borderRadius: value });
      return { value, dispose };
    },
    swap: (slot, state) => {
      const nextParent = state.expanded ? state.wrapperB : state.wrapperA;
      nextParent.append(state.current);
      state.current.classList.toggle('expanded', state.expanded);
      state.current.textContent = `${state.expanded ? 'expanded' : 'collapsed'} · reparent`;
    },
    setRadius: (radius, state) => state.value?.set(radius),
    liveRadius: (state) => state.value?.get(),
    subscribers: (state) => subscriberCount(state.value),
  },
);

// 6. Use animate() as the writer instead of a long-lived styleEffect binding.
createScenario(
  'animate-write',
  '6. animate() writes the radius',
  'Each branch is seeded with a zero-duration animate() before adoption. Once adopted, animate(element, …) routes through the existing visual element, so updates reach latestValues without a component-held MotionValue shared across branches.',
  {
    create: (expanded, state) => makeHero(expanded, state.radius),
    bind: (element, radius) => {
      const controls = animate(element, { borderRadius: radius }, { duration: 0 });
      return { value: controls, dispose: () => controls.stop() };
    },
    swap: (slot, state, previous) => {
      const next = makeHero(state.expanded, state.radius);
      previous.replaceWith(next);
      state.current = next;
    },
    setRadius: (radius, state) => {
      animate(state.current, { borderRadius: radius }, { duration: 0 });
    },
    liveRadius: (state) => state.current?.style.borderRadius,
    subscribers: () => 'n/a',
  },
);

// The minimal upstream repro: bind, adopt, cancel, then write.
const minimal = async () => {
  const slot = document.createElement('div');
  slot.className = 'slot';
  const element = makeHero(false, 'minimal');
  slot.append(element);
  document.querySelector('.report').before(slot);
  const value = motionValue(BASE_RADIUS);
  const cancel = styleEffect(element, { borderRadius: value });

  const animation = await animateLayout(slot, () => {
    element.classList.add('expanded');
    element.textContent = 'minimal · adopted';
  }, { type: 'spring', visualDuration: 0.2 });
  await animation.finished;

  const before = element.style.borderRadius;
  cancel();
  value.set(THICK_RADIUS);
  await frames(3);

  return {
    before,
    inline: element.style.borderRadius,
    stillApplyingAfterCancel: element.style.borderRadius === `${THICK_RADIUS}px`,
    subscribers: subscriberCount(value),
  };
};

// The attached-element variant of the same question: does cancel() detach a
// value after animateLayout has adopted the element?
const cancelProbe = async () => {
  const slot = document.createElement('div');
  slot.className = 'slot';
  const element = makeHero(false, 'cancel');
  slot.append(element);
  document.querySelector('.report').before(slot);
  const value = motionValue(BASE_RADIUS);
  const cancel = styleEffect(element, { borderRadius: value });

  const animation = await animateLayout(slot, () => {
    element.textContent = 'cancel · adopted';
  }, { type: 'spring', visualDuration: 0.2 });
  await animation.finished;

  const before = element.style.borderRadius;
  cancel();
  value.set(THICK_RADIUS);
  await frames(3);

  return {
    before,
    after: element.style.borderRadius,
    applied: before !== element.style.borderRadius,
    subscribers: subscriberCount(value),
  };
};

// The docs say scope.cancel() releases values for elements the scope
// animated, so a styleEffect bound to the same element is released. Check
// whether that survives animateLayout's handoff.
const scopeProbe = async () => {
  const slot = document.createElement('div');
  slot.className = 'slot';
  const element = makeHero(false, 'scope');
  slot.append(element);
  document.querySelector('.report').before(slot);

  const value = motionValue(BASE_RADIUS);
  const scope = scopeMotion(() => {});
  scope.run(() => styleEffect(element, { borderRadius: value }));
  // animate() is what makes scope track the element for style restoration.
  scope.run(() => animate(element, { opacity: 1 }, { duration: 0 }));

  const animation = await scope.run(() =>
    animateLayout(slot, () => {
      element.classList.add('expanded');
      element.textContent = 'scope · adopted';
    }, { type: 'spring', visualDuration: 0.2 }),
  );
  await animation.finished;

  const before = element.style.borderRadius;
  scope.cancel();
  value.set(THICK_RADIUS);
  await frames(3);

  return {
    before,
    after: element.style.borderRadius,
    applied: element.style.borderRadius === `${THICK_RADIUS}px`,
    subscribers: subscriberCount(value),
  };
};

window.lab = {
  scenarios: Object.fromEntries([...scenarios].map(([id, scenario]) => [id, scenario])),
  scopeProbe,
  async probe(id, toggles = 4) {
    const scenario = scenarios.get(id);
    for (let i = 0; i < toggles; i += 1) await scenario.toggle(false);
    scenario.render();
    return scenario.probeDetached();
  },
  // Leave only WeakRefs to the detached branches, then let DevTools force GC
  // (HeapProfiler.collectGarbage). Requires the caller to run GC externally.
  async gcProbe(id, toggles = 6) {
    const scenario = scenarios.get(id);
    for (let i = 0; i < toggles; i += 1) await scenario.toggle(false);
    const detached = scenario.state.all.filter((element) => !element.isConnected);
    window.__detachedRefs = detached.map((element) => ({
      element: new WeakRef(element),
      text: element.textContent,
    }));
    // Drop the harness's strong references to the branches.
    scenario.state.all = [];
    scenario.state.lastResult = null;
    scenario.state.lastSample = null;
    return { detached: detached.length };
  },
  gcStatus() {
    return (window.__detachedRefs ?? []).map((entry) => ({
      text: entry.text,
      alive: entry.element.deref() !== undefined,
    }));
  },
  async all(toggles = 4) {
    const output = {};
    for (const [id, scenario] of scenarios) {
      for (let i = 0; i < toggles; i += 1) await scenario.toggle(false);
      output[id] = await scenario.probeDetached();
    }
    return output;
  },
  minimal,
  cancelProbe,
};

minimal()
  .then((minimalResult) => cancelProbe().then((cancelResult) => scopeProbe().then((scopeResult) => {
    reportRoot.textContent = [
      'minimal (bind → animateLayout adopt → cancel → value.set(24)):',
      JSON.stringify(minimalResult, null, 2),
      '',
      'attached cancel probe (no branch swap):',
      JSON.stringify(cancelResult, null, 2),
      '',
      'scopeMotion.cancel() probe:',
      JSON.stringify(scopeResult, null, 2),
      '',
      'Use window.lab.all() for per-scenario retention counts.',
    ].join('\n');
    reportRoot.dataset.ready = 'true';
  })))
  .catch((error) => {
    reportRoot.textContent = `minimal repro failed: ${error?.stack ?? error}`;
    reportRoot.dataset.ready = 'error';
  });
