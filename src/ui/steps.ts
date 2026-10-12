// The two pieces of FieldMapper's HabLab dialog chrome the Fusion tab reuses:
// a numbered step heading, and a full-width segmented bar for a choice of a
// few mutually exclusive options. A disabled option stays LISTED with its
// reason as the tooltip, so "why can't I pick this?" is answered on the spot.

import { h } from '../dom.ts';

export function stepHead(n: number, title: string, right?: Node | string | null): HTMLElement {
  return h('h3', { class: 'step-h' }, h('span', { class: 'step-n', 'aria-hidden': 'true' }, String(n)), h('span', { class: 'grow' }, title), right ? h('span', { class: 'step-right' }, right) : null);
}

export interface SegOption { value: string; label: string; disabled?: string }

export function segBar(label: string, opts: SegOption[], current: string, pick: (value: string) => void): HTMLElement {
  return h('div', { class: 'segbar', role: 'radiogroup', 'aria-label': label },
    ...opts.map(o => h('button', {
      type: 'button', class: `segbar-btn${o.value === current ? ' on' : ''}`, role: 'radio', 'aria-checked': String(o.value === current),
      disabled: !!o.disabled, title: o.disabled || undefined,
      onclick: () => { if (o.value !== current) pick(o.value); },
    }, o.label)));
}
