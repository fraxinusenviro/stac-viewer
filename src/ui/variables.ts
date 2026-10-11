// The grouped variable picker shared by the rule and strata editors.

import { h } from '../dom.ts';
import { FUSION_VARIABLES, needsLeafOff, type Variable } from '../products.ts';

/** Variable picker options, grouped. */
export function variableOptions(selected: string, leafOff: boolean) {
  const groups = new Map<string, Variable[]>();
  for (const v of FUSION_VARIABLES) (groups.get(v.group) ?? groups.set(v.group, []).get(v.group)!).push(v);
  return [...groups].map(([g, vs]) => h('optgroup', { label: needsLeafOff(vs[0]) && !leafOff ? `${g} (needs a leaf-off scene)` : g },
    ...vs.map(v => h('option', { value: v.id, selected: v.id === selected }, v.label))));
}

