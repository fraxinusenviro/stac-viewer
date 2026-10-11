// The editor for a strata × cover scheme (strata.ts): the height strata as a
// small table, then the cover types — each a name, a colour, AND-ed spectral
// conditions, and the strata it may occur in.

import { h } from '../dom.ts';
import { OPS, type Op } from '../rules.ts';
import { defaultScheme, parseScheme, schemeUsesLeafOff, schemeVariables, strataProblem, stratumRange, type StrataScheme } from '../strata.ts';
import { variableOptions } from '../ui/variables.ts';

export interface StrataEditorHost {
  scheme: StrataScheme;
  /** The scheme changed; `structural` = re-render the editor too. */
  changed: (structural: boolean) => void;
  replace: (s: StrataScheme) => void;
  leafOff: boolean;
  panel: (key: string, title: string, open: boolean) => HTMLDetailsElement;
  say: (msg: string, kind?: 'info' | 'error') => void;
}

const OPEN_ENDED = 999;

export function strataEditor(host: StrataEditorHost): HTMLElement {
  const sc = host.scheme;
  const wrap = host.panel('strata', 'Strata × cover classes', true);
  const edit = (fn: () => void, structural = false) => () => { fn(); host.changed(structural); };

  wrap.append(h('input', { type: 'text', value: sc.name, 'aria-label': 'Scheme name', onchange: (e: Event) => { sc.name = (e.target as HTMLInputElement).value; host.changed(false); } }));
  wrap.append(h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: sc.maskClouds, onchange: (e: Event) => { sc.maskClouds = (e.target as HTMLInputElement).checked; host.changed(false); } }), 'Mask cloud, shadow and snow (Sentinel-2 SCL)'));
  wrap.append(h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: sc.showUnclassified, onchange: (e: Event) => { sc.showUnclassified = (e.target as HTMLInputElement).checked; host.changed(false); } }), 'Show unclaimed pixels by stratum (grey)'));
  if (schemeUsesLeafOff(sc) && !host.leafOff) wrap.append(h('p', { class: 'note small' }, 'Some cover rules use leaf-off variables: choose a leaf-off scene above.'));
  if (schemeVariables(sc).some(v => v.sharpenKeys)) wrap.append(h('p', { class: 'muted small' }, 'LiDAR-sharpened variables are unmixed by the default height classes (< 1, 1–5, ≥ 5 m), from zoom 15.'));

  // ── Strata ──
  wrap.append(h('h3', { class: 'sub' }, 'Height strata (canopy height model)'));
  wrap.append(h('div', { class: 'strata-row muted small' }, h('span', {}, 'Name'), h('span', {}, 'From (m)'), h('span', {}, 'To (m)'), h('span', {}, '')));
  sc.strata.forEach((s, i) => {
    wrap.append(h('div', { class: 'strata-row' },
      h('input', { type: 'text', value: s.label, 'aria-label': 'Stratum name', onchange: (e: Event) => { s.label = (e.target as HTMLInputElement).value; host.changed(true); } }),
      h('input', { type: 'number', step: '0.1', min: '0', value: String(s.min), 'aria-label': `${s.label} lower height`, onchange: (e: Event) => { s.min = +(e.target as HTMLInputElement).value; host.changed(true); } }),
      h('input', { type: 'number', step: '0.1', value: s.max >= OPEN_ENDED ? '' : String(s.max), placeholder: 'open', 'aria-label': `${s.label} upper height`, onchange: (e: Event) => { const v = (e.target as HTMLInputElement).value; s.max = v === '' ? OPEN_ENDED : +v; host.changed(true); } }),
      h('button', { class: 'icon', title: 'Remove stratum', 'aria-label': `Remove ${s.label}`, onclick: edit(() => { sc.strata.splice(i, 1); sc.covers.forEach(c => { c.strata = c.strata.filter(id => id !== s.id); }); }, true) }, '✕')));
  });
  const problem = strataProblem(sc.strata);
  if (problem) wrap.append(h('p', { class: 'note small' }, `Strata: ${problem}.`));
  wrap.append(h('div', { class: 'row' },
    h('button', { class: 'chip', onclick: edit(() => {
      const last = sc.strata[sc.strata.length - 1];
      if (last && last.max >= OPEN_ENDED) last.max = last.min + 5;
      const from = last ? last.max : 0;
      sc.strata.push({ id: `s${Date.now().toString(36)}`, label: 'New stratum', min: from, max: OPEN_ENDED });
    }, true) }, '+ Add stratum')));
  wrap.append(h('p', { class: 'muted small' }, 'The canopy height model is the top surface: a pixel is classed by its tallest layer, and understorey under a canopy is not seen. DSM − DTM carries ~0.1–0.2 m of noise, so boundaries below ~0.5 m lean on the cover rules.'));

  // ── Cover types ──
  wrap.append(h('h3', { class: 'sub' }, 'Cover types (first that holds and allows the stratum)'));
  sc.covers.forEach((cv, i) => {
    const card = h('div', { class: `rule${cv.off ? ' rule-off' : ''}` });
    const move = (d: number) => edit(() => { const j = i + d; if (j < 0 || j >= sc.covers.length) return; [sc.covers[i], sc.covers[j]] = [sc.covers[j], sc.covers[i]]; }, true);
    card.append(h('div', { class: 'row rule-head' },
      h('span', { class: 'rule-n muted' }, `${i + 1}`),
      h('input', { type: 'color', value: cv.colour, 'aria-label': 'Colour', onchange: (e: Event) => { cv.colour = (e.target as HTMLInputElement).value; host.changed(false); } }),
      h('input', { type: 'text', class: 'grow', value: cv.label, 'aria-label': 'Cover type', onchange: (e: Event) => { cv.label = (e.target as HTMLInputElement).value; host.changed(false); } }),
      h('button', { class: 'icon', title: 'Move up', 'aria-label': 'Move up', onclick: move(-1) }, '↑'),
      h('button', { class: 'icon', title: 'Move down', 'aria-label': 'Move down', onclick: move(1) }, '↓'),
      h('button', { class: 'icon', title: cv.off ? 'Turn on' : 'Turn off', 'aria-label': cv.off ? 'Turn on' : 'Turn off', onclick: edit(() => { cv.off = !cv.off || undefined; }, true) }, cv.off ? '○' : '●'),
      h('button', { class: 'icon', title: 'Delete cover type', 'aria-label': 'Delete cover type', onclick: edit(() => { sc.covers.splice(i, 1); }, true) }, '✕')));
    cv.when.forEach((w, j) => {
      card.append(h('div', { class: 'cond' },
        h('span', { class: 'muted small' }, j ? 'and' : 'if'),
        h('select', { class: 'grow', 'aria-label': 'Variable', onchange: (e: Event) => { w.v = (e.target as HTMLSelectElement).value; host.changed(true); } }, ...variableOptions(w.v, host.leafOff)),
        h('select', { 'aria-label': 'Operator', onchange: (e: Event) => { w.op = (e.target as HTMLSelectElement).value as Op; if (w.op === 'between' && w.b === undefined) w.b = w.a; if (w.op !== 'between') delete w.b; host.changed(true); } },
          ...OPS.map(o => h('option', { value: o, selected: o === w.op }, o === '>=' ? '≥' : o === '<=' ? '≤' : o))),
        h('input', { type: 'number', step: 'any', value: String(w.a), 'aria-label': 'Value', onchange: (e: Event) => { w.a = +(e.target as HTMLInputElement).value; host.changed(false); } }),
        w.op === 'between' ? h('input', { type: 'number', step: 'any', value: String(w.b ?? w.a), 'aria-label': 'Upper value', onchange: (e: Event) => { w.b = +(e.target as HTMLInputElement).value; host.changed(false); } }) : null,
        h('button', { class: 'icon', title: 'Remove condition', 'aria-label': 'Remove condition', onclick: edit(() => { cv.when.splice(j, 1); }, true) }, '✕')));
    });
    card.append(h('button', { class: 'chip', onclick: edit(() => { cv.when.push({ v: 'ndvi', op: '>=', a: 0.5 }); }, true) }, '+ condition'));
    card.append(h('div', { class: 'allowed' }, h('span', { class: 'muted' }, 'Occurs in:'),
      ...sc.strata.map(s => h('label', { title: stratumRange(s) },
        h('input', { type: 'checkbox', checked: cv.strata.includes(s.id), onchange: (e: Event) => { const on = (e.target as HTMLInputElement).checked; cv.strata = on ? [...new Set([...cv.strata, s.id])] : cv.strata.filter(x => x !== s.id); host.changed(false); } }),
        s.label))));
    wrap.append(card);
  });

  const fileIn = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: async (e: Event) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    try { host.replace(parseScheme(JSON.parse(await f.text()))); host.say('Scheme imported.'); } catch (err) { host.say(`Could not import: ${(err as Error).message}`, 'error'); }
  } });
  wrap.append(h('div', { class: 'row' },
    h('button', { class: 'chip', onclick: edit(() => { sc.covers.push({ label: 'New cover', colour: '#ff7f00', when: [{ v: 'ndvi', op: '>=', a: 0.5 }], strata: sc.strata.map(s => s.id) }); }, true) }, '+ Add cover type'),
    h('button', { class: 'chip', onclick: () => {
      const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(sc, null, 2)], { type: 'application/json' })), download: `${(sc.name || 'strata').replace(/[^\w-]+/g, '_')}.json` });
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } }, 'Export JSON'),
    h('button', { class: 'chip', onclick: () => fileIn.click() }, 'Import JSON'), fileIn,
    h('button', { class: 'chip', onclick: () => { if (confirm('Reset to the default strata and cover types?')) host.replace(defaultScheme()); } }, 'Reset')));
  wrap.append(h('p', { class: 'muted small' }, 'Cover types sharing a name and colour are one row (an OR). A condition on a variable with no value at the pixel is false.'));
  return wrap;
}
