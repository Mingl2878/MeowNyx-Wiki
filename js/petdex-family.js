/** Petdex-only explicit family relations. Never changes the shared flat selectors. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PetDexFamily = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const validId = value => Number.isSafeInteger(value) && value > 0;
  const nameOf = m => m.localized?.zh?.name || m.name || '';
  const leader = m => !!m.is_leader_form || m.evolution_stage === '首领形态';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  function formIndex(monsters) {
    const byId = new Map(monsters.filter(m => validId(m.id) && !m.hidden).map(m => [m.id, m]));
    const parentById = new Map(), variantsById = new Map();
    for (const m of byId.values()) {
      const parent = byId.get(m.main_form_id);
      // An explicit ID is required. Names/dex numbers are never identity guesses.
      if (!parent || parent.id === m.id || parent.main_form_id || nameOf(parent) !== nameOf(m)) continue;
      parentById.set(m.id, parent.id);
      if (!variantsById.has(parent.id)) variantsById.set(parent.id, []);
      variantsById.get(parent.id).push(m);
    }
    return { byId, parentById, variantsById };
  }

  function groupVisible(sorted, index) {
    const visible = new Set(sorted.map(m => m.id)), children = new Map();
    for (const m of sorted) {
      const parentId = index.parentById.get(m.id);
      if (!visible.has(parentId)) continue;
      if (!children.has(parentId)) children.set(parentId, []);
      children.get(parentId).push(m);
    }
    const result = [];
    for (const m of sorted) {
      if (visible.has(index.parentById.get(m.id))) continue;
      result.push(m, ...(children.get(m.id) || []));
    }
    return result;
  }

  function build(monsters, selectedId) {
    const index = formIndex(monsters), { byId } = index;
    if (!byId.has(selectedId)) return { selectedId, nodes: [], edges: [] };
    const edges = [], adjacent = new Map([...byId.keys()].map(id => [id, []]));
    const add = (from, to, kind) => {
      if (!validId(from) || from === to || !byId.has(from)) return;
      const edge = { from, to, kind };
      edges.push(edge); adjacent.get(from).push(to); adjacent.get(to).push(from);
    };
    for (const m of byId.values()) {
      const ordinary = byId.get(m.evolves_from_id), base = byId.get(m.leader_of_id);
      if (ordinary && !leader(m) && !leader(ordinary)) add(ordinary.id, m.id, 'evolution');
      if (base && leader(m) && !leader(base)) add(base.id, m.id, 'leader');
      if (index.parentById.has(m.id)) add(index.parentById.get(m.id), m.id, 'form');
    }
    // Traverse explicit edges in both directions, including all downstream forks.
    // No source membership, learning inheritance, name or dex closure is involved.
    const seen = new Set([selectedId]), queue = [selectedId];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      for (const id of adjacent.get(queue[cursor])) if (!seen.has(id)) { seen.add(id); queue.push(id); }
    }
    return {
      selectedId,
      nodes: [...seen].sort((a, b) => a - b).map(id => ({ id, monster: byId.get(id), selected: id === selectedId, groupId: index.parentById.get(id) || id })),
      edges: edges.filter(e => seen.has(e.from) && seen.has(e.to)).sort((a, b) => a.from - b.from || a.to - b.to || a.kind.localeCompare(b.kind))
    };
  }

  // Form links discover the complete family but are NOT progression arrows.
  // Each corresponding-form chain is its own compact path. Shared ordinary
  // prefixes are emitted once, with only real outgoing edges becoming forks.
  function compact(graph) {
    const byId = new Map(graph.nodes.filter(n => validId(n.id)).map(n => [n.id, n]));
    const outgoing = new Map([...byId.keys()].map(id => [id, []])), incoming = new Set(), edgeKeys = new Set();
    for (const edge of graph.edges) {
      if (!['evolution', 'leader'].includes(edge.kind) || !byId.has(edge.from) || !byId.has(edge.to) || edge.from === edge.to) continue;
      const key = `${edge.kind}:${edge.from}>${edge.to}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key); outgoing.get(edge.from).push(edge); incoming.add(edge.to);
    }
    const emitted = new Set();
    function pathFrom(id) {
      const path = { steps: [], branches: [] };
      let edge = null;
      while (byId.has(id)) {
        const node = byId.get(id), reference = emitted.has(id);
        path.steps.push({ node, edge, reference });
        // A malformed cycle/shared target remains a plain reference, never a
        // second clickable/current marker or an unbounded recursive traversal.
        if (reference) break;
        emitted.add(id);
        const next = outgoing.get(id);
        if (next.length === 1) { edge = next[0]; id = edge.to; continue; }
        path.branches = next.map(link => ({ edge: link, path: pathFrom(link.to) }));
        break;
      }
      return path;
    }
    const paths = [];
    for (const id of byId.keys()) if (!incoming.has(id) && !emitted.has(id)) paths.push(pathFrom(id));
    // Normally empty: covers an isolated directed cycle defensively, in stable
    // graph order, without dropping any valid node from the presentation.
    for (const id of byId.keys()) if (!emitted.has(id)) paths.push(pathFrom(id));
    return paths;
  }

  function render(graph, displayName = m => nameOf(m) + (m.form && !['default', 'Original'].includes(m.form) ? `（${m.form}）` : '')) {
    if (!graph.nodes.length) return '';
    const nodeById = new Map(graph.nodes.map(n => [n.id, n])), groupCounts = new Map();
    for (const node of graph.nodes) groupCounts.set(node.groupId, (groupCounts.get(node.groupId) || 0) + 1);
    const labelOf = node => {
      const m = node.monster;
      if (groupCounts.get(node.groupId) > 1 && (!m.form || ['default', 'Original'].includes(m.form))) return nameOf(m) + '（本来的样子）';
      return displayName(m);
    };
    const nodeHtml = step => {
      const node = step.node, fullName = labelOf(node);
      if (step.reference) return `<span class="petdex-family-reference" data-family-reference-id="${node.id}" title="${escape('已列出：' + fullName)}">${escape(fullName)}</span>`;
      const relations = graph.edges.filter(e => e.from === node.id || e.to === node.id).map(e => {
        const other = nodeById.get(e.from === node.id ? e.to : e.from);
        if (!other) return '';
        const label = e.kind === 'form' ? '同名形态' : e.kind === 'leader' ? (e.to === node.id ? '首领来源' : '首领化') : (e.to === node.id ? '进化前置' : '进化后继');
        return `${label}：${labelOf(other)}`;
      }).filter(Boolean).join('；');
      const selected = node.id === graph.selectedId;
      return `<button type="button" class="petdex-family-node${selected ? ' is-selected' : ''}" data-related-id="${node.id}"${selected ? ' aria-current="true"' : ''} aria-label="${escape(fullName + (selected ? '，当前形态' : '') + (relations ? '；' + relations : ''))}" title="${escape(fullName + (relations ? '\n' + relations : ''))}">${escape(fullName)}</button>`;
    };
    const arrowHtml = (edge, diagonal = '') => {
      const symbol = diagonal || (edge.kind === 'leader' ? '⇢' : '→');
      const relation = edge.kind === 'leader' ? '首领化' : '普通进化';
      const label = `${labelOf(nodeById.get(edge.from))} → ${labelOf(nodeById.get(edge.to))}（${relation}）`;
      return `<span class="petdex-family-arrow${edge.kind === 'leader' ? ' is-leader' : ''}" data-family-edge="${edge.kind}" data-from-id="${edge.from}" data-to-id="${edge.to}" role="img" aria-label="${escape(label)}" title="${escape(relation)}">${symbol}</span>`;
    };
    function pathHtml(path) {
      const prefix = path.steps.map(step => `<span class="petdex-family-step">${step.edge ? arrowHtml(step.edge) : ''}${nodeHtml(step)}</span>`).join('');
      const branches = path.branches.map((branch, i, list) => {
        const diagonal = i === 0 ? '↗' : i === list.length - 1 ? '↘' : '→';
        return `<div class="petdex-family-branch">${arrowHtml(branch.edge, diagonal)}${pathHtml(branch.path)}</div>`;
      }).join('');
      return `<div class="petdex-family-tree"><div class="petdex-family-prefix">${prefix}</div>${branches ? `<div class="petdex-family-branches">${branches}</div>` : ''}</div>`;
    }
    return `<section class="petdex-family" aria-label="进化与形态关系"><div class="detail-section-title">进化与形态</div><div class="petdex-family-paths">${compact(graph).map(pathHtml).join('')}</div></section>`;
  }

  return { formIndex, groupVisible, build, compact, render };
});
