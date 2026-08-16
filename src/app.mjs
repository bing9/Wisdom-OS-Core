import {
  DECISION_STAGES,
  TASK_STAGES,
  buildHandoff,
  computeButlerBrief,
  moveItem,
} from './domain.mjs';

const stageLabels = {
  sense: ['SENSE', '捕捉'],
  distill: ['DISTILL', '成形'],
  judge: ['JUDGE', '判断'],
  bank: ['BANK', '收框'],
  learn: ['LEARN', '复盘'],
  backlog: ['BACKLOG', '待办'],
  ready: ['READY', '就绪'],
  doing: ['DOING', '执行'],
  verify: ['VERIFY', '验证'],
  done: ['DONE', '交付'],
};

const $ = (selector) => document.querySelector(selector);
const refs = {
  board: $('#board'),
  areaList: $('#areaList'),
  areaHeader: $('#areaHeader'),
  butlerBrief: $('#butlerBrief'),
  drawer: $('#drawer'),
  drawerBackdrop: $('#drawerBackdrop'),
  toast: $('#toast'),
  saveStatus: $('#saveStatus'),
  addItemBtn: $('#addItemBtn'),
  searchInput: $('#searchInput'),
  priorityFilter: $('#priorityFilter'),
  importInput: $('#importInput'),
};

let state;
let mode = 'decision';
let selectedAreaId = '';
let selectedItem = null;
let toastTimer;

const esc = (value = '') => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');
const present = (value) => typeof value === 'string' ? value.trim().length > 0 : value !== undefined && value !== null;
const initials = (value = '?') => value.split(/\s|-|_/).filter(Boolean).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
const formatDate = (value) => value ? new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short' }).format(new Date(value)) : 'No date';
const nowIso = () => new Date().toISOString();
const entityCollection = (type) => type === 'decision' ? 'decisions' : type === 'task' ? 'tasks' : 'areas';
const getEntity = (type, id) => state[entityCollection(type)]?.find((item) => item.id === id);
const getArea = (id) => state.areas.find((area) => area.id === id);

function showToast(message, kind = '') {
  refs.toast.textContent = message;
  refs.toast.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { refs.toast.className = 'toast'; }, 2600);
}

function setSaveStatus(label, kind = '') {
  refs.saveStatus.className = `save-status ${kind}`;
  refs.saveStatus.innerHTML = `<i></i>${esc(label)}`;
}

async function loadState() {
  setSaveStatus('Connecting');
  const response = await fetch('/api/state', { cache: 'no-store' });
  if (!response.ok) throw new Error(`State load failed: ${response.status}`);
  state = await response.json();
  selectedAreaId = state.areas
    .map((area) => ({ id: area.id, count: state.decisions.filter((item) => item.areaId === area.id).length + state.tasks.filter((item) => item.areaId === area.id).length }))
    .sort((a, b) => b.count - a.count)[0]?.id ?? '';
  setSaveStatus('Local state ready');
  render();
}

async function persist() {
  setSaveStatus('Saving');
  try {
    const response = await fetch('/api/state', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(state),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? `Save failed: ${response.status}`);
    state.revision = result.revision;
    setSaveStatus('Saved to shared state');
  } catch (error) {
    setSaveStatus(error.message.includes('reload') ? 'Conflict · reload' : 'Save failed', 'error');
    showToast(error.message, 'error');
    throw error;
  }
}

function render() {
  if (!state) return;
  renderButler();
  renderAreas();
  renderAreaHeader();
  renderBoard();
  updateModeControls();
}

function renderButler() {
  const findings = computeButlerBrief(state);
  refs.butlerBrief.innerHTML = findings.length
    ? findings.map((finding) => `
      <article class="brief-card" data-open-type="${esc(finding.entityType)}" data-open-id="${esc(finding.entityId)}">
        <div class="brief-meta">
          <span class="brief-type">${esc(finding.type.replaceAll('-', ' '))}</span>
          <span class="priority ${esc(finding.priority)}">${esc(finding.priority)}</span>
        </div>
        <strong>${esc(finding.title)}</strong>
        <p>${esc(finding.message)}</p>
      </article>`).join('')
    : '<div class="empty-brief">No P0 judgment needed. 安静即健康。</div>';
}

function renderAreas() {
  refs.areaList.innerHTML = state.areas.map((area) => {
    const count = state.decisions.filter((item) => item.areaId === area.id).length + state.tasks.filter((item) => item.areaId === area.id).length;
    return `
      <button class="area-item ${area.id === selectedAreaId ? 'active' : ''}" data-area-id="${esc(area.id)}">
        <span class="area-avatar">${esc(initials(area.name))}</span>
        <span class="area-copy">
          <span class="area-name">${esc(area.name)}</span>
          <span class="area-director">${esc(area.director || 'No Director')}</span>
        </span>
        <span class="area-count">${count}</span>
      </button>`;
  }).join('');
}

function renderAreaHeader() {
  const area = getArea(selectedAreaId);
  if (!area) {
    refs.areaHeader.innerHTML = '<p class="muted">Create an area to begin.</p>';
    return;
  }
  const decisions = state.decisions.filter((item) => item.areaId === area.id);
  const tasks = state.tasks.filter((item) => item.areaId === area.id);
  const blocked = tasks.filter((item) => present(item.blockedReason)).length;
  const needsHuman = decisions.filter((item) => item.priority === 'P0' && !['bank', 'learn'].includes(item.stage)).length + tasks.filter((item) => item.stage === 'verify' && !item.acceptedByHuman).length;
  refs.areaHeader.innerHTML = `
    <div class="area-header-grid">
      <div>
        <div class="area-title-row">
          <h2>${esc(area.name)}</h2>
          <span class="director-badge">${esc(area.director || 'Director missing')}</span>
          <button class="edit-director" data-open-type="area" data-open-id="${esc(area.id)}">Edit contract</button>
        </div>
        <p class="area-mandate">${esc(area.mandate || 'No mandate yet.')}</p>
      </div>
      <div class="health-strip">
        <div class="health-metric"><strong>${decisions.length}</strong><span>Decisions</span></div>
        <div class="health-metric"><strong>${tasks.length}</strong><span>Delivery</span></div>
        <div class="health-metric"><strong>${blocked}</strong><span>Blocked</span></div>
        <div class="health-metric"><strong>${needsHuman}</strong><span>Human calls</span></div>
      </div>
    </div>`;
}

function filteredItems() {
  const collection = mode === 'decision' ? state.decisions : state.tasks;
  const query = refs.searchInput.value.trim().toLowerCase();
  const priority = refs.priorityFilter.value;
  return collection.filter((item) => item.areaId === selectedAreaId)
    .filter((item) => priority === 'all' || item.priority === priority)
    .filter((item) => !query || `${item.title} ${item.whyNow ?? ''} ${item.acceptance ?? ''} ${item.owner ?? ''}`.toLowerCase().includes(query));
}

function cardMarkup(item) {
  const summary = mode === 'decision'
    ? item.humanCall || item.whyNow || 'Define why this decision matters now.'
    : item.blockedReason || item.acceptance || 'Define acceptance before execution.';
  const owner = item.owner || item.maker || 'Unowned';
  return `
    <article class="work-card" draggable="true" data-type="${mode}" data-id="${esc(item.id)}" tabindex="0">
      <div class="card-top">
        <span class="type-chip">${mode === 'decision' ? 'DECISION' : 'DELIVERABLE'}</span>
        <span class="priority ${esc(item.priority || 'P2')}">${esc(item.priority || 'P2')}</span>
      </div>
      <h4>${esc(item.title)}</h4>
      <p class="card-summary ${item.blockedReason ? 'blocked-flag' : ''}">${item.blockedReason ? 'Blocked · ' : ''}${esc(summary)}</p>
      <div class="card-footer">
        <span class="card-owner"><i>${esc(initials(owner))}</i>${esc(owner)}</span>
        <span>${esc(formatDate(item.dueDate || item.reviewDate))}</span>
      </div>
    </article>`;
}

function renderBoard() {
  const stages = mode === 'decision' ? DECISION_STAGES : TASK_STAGES;
  const items = filteredItems();
  refs.board.innerHTML = stages.map((stage) => {
    const stageItems = items.filter((item) => item.stage === stage);
    const [label, sublabel] = stageLabels[stage];
    return `
      <section class="board-column" data-stage="${stage}">
        <header class="column-header">
          <div class="column-label"><i class="stage-dot"></i><h3>${label} · ${sublabel}</h3></div>
          <span class="column-count">${stageItems.length}</span>
        </header>
        <div class="column-cards">
          ${stageItems.length ? stageItems.map(cardMarkup).join('') : '<div class="empty-column">Drop here</div>'}
        </div>
      </section>`;
  }).join('');
}

function updateModeControls() {
  document.querySelectorAll('.mode-button').forEach((button) => button.classList.toggle('active', button.dataset.mode === mode));
  refs.addItemBtn.textContent = mode === 'decision' ? '+ New decision' : '+ New task';
}

function moveDragged(type, id, target) {
  const result = moveItem(state, type, id, target);
  if (!result.ok) {
    showToast(`Blocked by gate: ${result.missing.join(', ')}`, 'error');
    openDrawer(type, id);
    return;
  }
  state = result.state;
  render();
  persist();
  showToast('Moved and logged');
}

function field(label, name, value = '', { type = 'text', full = false, placeholder = '' } = {}) {
  if (type === 'textarea') return `<div class="field ${full ? 'full' : ''}"><label>${esc(label)}</label><textarea name="${esc(name)}" placeholder="${esc(placeholder)}">${esc(value)}</textarea></div>`;
  if (type === 'date') return `<div class="field ${full ? 'full' : ''}"><label>${esc(label)}</label><input type="date" name="${esc(name)}" value="${esc(value)}" /></div>`;
  return `<div class="field ${full ? 'full' : ''}"><label>${esc(label)}</label><input type="${esc(type)}" name="${esc(name)}" value="${esc(value)}" placeholder="${esc(placeholder)}" /></div>`;
}

function ledgerMarkup(entries, type) {
  if (!entries.length) return '<p class="muted">No entries yet.</p>';
  return entries.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((entry) => type === 'feedback'
    ? `<div class="ledger-entry"><strong>${esc(entry.source || 'Unknown')}</strong><time>${esc(formatDate(entry.createdAt))}</time><p>${esc(entry.note)}${entry.requirementDelta ? `<br><span class="delta">Δ ${esc(entry.requirementDelta)}</span>` : ''}</p></div>`
    : `<div class="ledger-entry"><strong>${esc(entry.agent || 'Agent')}</strong><time>${esc(formatDate(entry.createdAt))}</time><p><code>${esc(entry.command)}</code><br>${esc(entry.result)} · ${esc(entry.artifact)}</p></div>`
  ).join('');
}

function renderDrawer() {
  if (!selectedItem) return;
  const { type, id } = selectedItem;
  const item = getEntity(type, id);
  if (!item) return closeDrawer();
  const feedback = state.feedback.filter((entry) => entry.entityType === type && entry.entityId === id);
  const runs = state.runs.filter((entry) => entry.entityType === type && entry.entityId === id);
  const optionsText = type === 'decision' ? (item.options ?? []).map((option) => `${option.choice} | ${option.sacrifice}`).join('\n') : '';
  const areaOptions = state.areas.map((area) => `<option value="${esc(area.id)}" ${area.id === item.areaId ? 'selected' : ''}>${esc(area.name)} · ${esc(area.director)}</option>`).join('');
  const decisionOptions = state.decisions.map((decision) => `<option value="${esc(decision.id)}" ${decision.id === item.decisionId ? 'selected' : ''}>${esc(decision.title)}</option>`).join('');

  let fields = '';
  if (type === 'decision') {
    fields = `
      <div class="form-grid">
        ${field('Title', 'title', item.title, { full: true })}
        <div class="field"><label>Area / Director</label><select name="areaId">${areaOptions}</select></div>
        <div class="field"><label>Priority</label><select name="priority">${['P0','P1','P2'].map((p) => `<option ${item.priority === p ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
        ${field('Why now', 'whyNow', item.whyNow, { type: 'textarea', full: true })}
        ${field('Options — one per line: choice | sacrifice', 'options', optionsText, { type: 'textarea', full: true })}
        ${field('Human call', 'humanCall', item.humanCall, { type: 'textarea', full: true })}
        ${field('Owner', 'owner', item.owner)}
        ${field('Decision date', 'dueDate', item.dueDate, { type: 'date' })}
        ${field('Resolved premise', 'resolvedPremise', item.resolvedPremise, { type: 'textarea', full: true })}
        ${field('Review date', 'reviewDate', item.reviewDate, { type: 'date' })}
        ${field('Outcome', 'outcome', item.outcome, { type: 'textarea', full: true })}
        ${field('Review', 'review', item.review, { type: 'textarea', full: true })}
        ${field('Case-law update', 'caseLawUpdate', item.caseLawUpdate, { type: 'textarea', full: true })}
      </div>`;
  } else if (type === 'task') {
    fields = `
      <div class="form-grid">
        ${field('Title', 'title', item.title, { full: true })}
        <div class="field"><label>Area / Director</label><select name="areaId">${areaOptions}</select></div>
        <div class="field"><label>Priority</label><select name="priority">${['P0','P1','P2'].map((p) => `<option ${item.priority === p ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
        <div class="field full"><label>Parent decision</label><select name="decisionId"><option value="">None</option>${decisionOptions}</select></div>
        ${field('Acceptance criteria', 'acceptance', item.acceptance, { type: 'textarea', full: true })}
        ${field('Maker agent', 'maker', item.maker)}
        ${field('Owner', 'owner', item.owner)}
        ${field('Evidence / artifact', 'evidence', item.evidence, { type: 'textarea', full: true })}
        ${field('Independent verifier', 'verifier', item.verifier)}
        ${field('Due date', 'dueDate', item.dueDate, { type: 'date' })}
        ${field('Verification result', 'verification', item.verification, { type: 'textarea', full: true })}
        ${field('Blocked reason', 'blockedReason', item.blockedReason, { type: 'textarea', full: true })}
        <label class="checkbox-field field full"><input type="checkbox" name="acceptedByHuman" ${item.acceptedByHuman ? 'checked' : ''} /> Human explicitly accepted this delivery</label>
      </div>`;
  } else {
    fields = `
      <div class="form-grid">
        ${field('Area name', 'name', item.name, { full: true })}
        ${field('Director', 'director', item.director, { full: true })}
        ${field('Mandate', 'mandate', item.mandate, { type: 'textarea', full: true })}
        ${field('Delivery contract', 'deliveryContract', item.deliveryContract, { type: 'textarea', full: true })}
      </div>`;
  }

  const handoff = type === 'area' ? '' : buildHandoff(state, type, id);
  refs.drawer.innerHTML = `
    <div class="drawer-header">
      <div><div class="section-kicker">${esc(type.toUpperCase())} · ${esc(item.stage || 'DIRECTOR CONTRACT')}</div><h2>${esc(item.title || item.name)}</h2></div>
      <button class="drawer-close" data-close-drawer>×</button>
    </div>
    <div class="drawer-body">
      <form id="itemForm" class="form-section">
        <h3>${type === 'area' ? 'Director contract' : 'Context & truth'}</h3>
        ${fields}
        <div class="form-actions"><span class="muted">Every edit is written to the shared state.</span><button class="button primary" type="submit">Save changes</button></div>
      </form>
      ${type === 'area' ? '' : `
      <section class="form-section">
        <h3>Feedback & requirement delta</h3>
        <div class="ledger-list">${ledgerMarkup(feedback, 'feedback')}</div>
        <form id="feedbackForm" class="inline-entry">
          <input name="source" placeholder="Source" required />
          <input name="note" placeholder="Feedback" required />
          <input name="requirementDelta" placeholder="Requirement Δ" />
          <button class="button ghost" type="submit">Add feedback</button>
        </form>
      </section>
      <section class="form-section">
        <h3>Agent runs & evidence</h3>
        <div class="ledger-list">${ledgerMarkup(runs, 'run')}</div>
        <form id="runForm" class="inline-entry run">
          <input name="agent" placeholder="Agent" required />
          <input name="command" placeholder="Command / prompt" required />
          <input name="result" placeholder="Result" required />
          <input name="artifact" placeholder="Artifact" />
          <button class="button ghost" type="submit">Log run</button>
        </form>
      </section>
      <section class="form-section">
        <h3>Restartable handoff</h3>
        <pre class="handoff-preview">${esc(handoff)}</pre>
        <div class="form-actions"><span class="muted">A fresh agent should continue from this alone.</span><button id="copyHandoffBtn" class="button ghost" type="button">Copy handoff</button></div>
      </section>`}
    </div>`;
}

function openDrawer(type, id) {
  selectedItem = { type, id };
  renderDrawer();
  refs.drawerBackdrop.hidden = false;
  refs.drawer.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => refs.drawer.classList.add('open'));
}

function closeDrawer() {
  refs.drawer.classList.remove('open');
  refs.drawer.setAttribute('aria-hidden', 'true');
  refs.drawerBackdrop.hidden = true;
  selectedItem = null;
}

function saveDrawerForm(form) {
  const { type, id } = selectedItem;
  const item = getEntity(type, id);
  const raw = Object.fromEntries(new FormData(form));
  const patch = { ...raw, updatedAt: nowIso() };
  if (type === 'decision') {
    patch.options = raw.options.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
      const [choice, ...rest] = line.split('|');
      return { choice: choice.trim(), sacrifice: rest.join('|').trim() };
    });
    delete patch.optionsText;
  }
  if (type === 'task') patch.acceptedByHuman = form.elements.acceptedByHuman.checked;
  const changedFields = Object.keys(patch).filter((key) => key !== 'updatedAt' && JSON.stringify(item[key] ?? '') !== JSON.stringify(patch[key] ?? ''));
  Object.assign(item, patch);
  state.history.push({
    id: `h-${patch.updatedAt}-${id}`,
    entityType: type,
    entityId: id,
    action: 'edited',
    fields: changedFields,
    createdAt: patch.updatedAt,
  });
  if (type === 'area' && selectedAreaId === id) selectedAreaId = item.id;
  render();
  renderDrawer();
  persist();
  showToast('Context updated');
}

function addFeedback(form) {
  const raw = Object.fromEntries(new FormData(form));
  state.feedback.push({
    id: `f-${crypto.randomUUID()}`,
    entityType: selectedItem.type,
    entityId: selectedItem.id,
    source: raw.source,
    note: raw.note,
    requirementDelta: raw.requirementDelta,
    createdAt: nowIso(),
  });
  render();
  renderDrawer();
  persist();
  showToast('Feedback folded into context');
}

function addRun(form) {
  const raw = Object.fromEntries(new FormData(form));
  state.runs.push({
    id: `r-${crypto.randomUUID()}`,
    entityType: selectedItem.type,
    entityId: selectedItem.id,
    agent: raw.agent,
    command: raw.command,
    result: raw.result,
    artifact: raw.artifact,
    createdAt: nowIso(),
  });
  render();
  renderDrawer();
  persist();
  showToast('Agent run logged');
}

function addItem() {
  if (!selectedAreaId) return showToast('Create a Director area first', 'error');
  const id = `${mode}-${crypto.randomUUID()}`;
  const item = mode === 'decision'
    ? { id, areaId: selectedAreaId, title: 'Untitled decision', stage: 'sense', priority: 'P1', whyNow: '', options: [], humanCall: '', owner: '', dueDate: '', resolvedPremise: '', reviewDate: '', outcome: '', review: '', caseLawUpdate: '', createdAt: nowIso(), updatedAt: nowIso() }
    : { id, areaId: selectedAreaId, decisionId: '', title: 'Untitled deliverable', stage: 'backlog', priority: 'P1', acceptance: '', maker: '', evidence: '', verifier: '', verification: '', acceptedByHuman: false, blockedReason: '', owner: '', dueDate: '', createdAt: nowIso(), updatedAt: nowIso() };
  state[mode === 'decision' ? 'decisions' : 'tasks'].push(item);
  state.history.push({ id: `h-${nowIso()}-${id}`, entityType: mode, entityId: id, action: 'created', createdAt: nowIso() });
  render();
  persist();
  openDrawer(mode, id);
}

function addArea() {
  const id = `area-${crypto.randomUUID()}`;
  state.areas.push({ id, name: 'New area', director: '', mandate: '', deliveryContract: '' });
  selectedAreaId = id;
  render();
  persist();
  openDrawer('area', id);
}

function exportState() {
  const blob = new Blob([`${JSON.stringify(state, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `decision-flywheel-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
  showToast('Board exported');
}

async function importState(file) {
  const imported = JSON.parse(await file.text());
  const valid = imported?.version === 1 && ['areas','decisions','tasks','feedback','runs','history'].every((key) => Array.isArray(imported[key]));
  if (!valid) throw new Error('Not a Decision Flywheel v1 export');
  if (!confirm('Replace the current board with this import? Export first if you need a rollback.')) return;
  state = imported;
  selectedAreaId = state.areas[0]?.id ?? '';
  closeDrawer();
  render();
  await persist();
  showToast('Board imported');
}

function handleDocumentClick(event) {
  const modeButton = event.target.closest('[data-mode]');
  if (modeButton) {
    mode = modeButton.dataset.mode;
    render();
    return;
  }
  const areaButton = event.target.closest('[data-area-id]');
  if (areaButton) {
    selectedAreaId = areaButton.dataset.areaId;
    render();
    return;
  }
  const openTarget = event.target.closest('[data-open-type][data-open-id]');
  if (openTarget) return openDrawer(openTarget.dataset.openType, openTarget.dataset.openId);
  const card = event.target.closest('.work-card');
  if (card) return openDrawer(card.dataset.type, card.dataset.id);
  if (event.target.closest('[data-close-drawer]')) closeDrawer();
  if (event.target.id === 'copyHandoffBtn' && selectedItem) {
    navigator.clipboard.writeText(buildHandoff(state, selectedItem.type, selectedItem.id));
    showToast('Handoff copied');
  }
}

function handleSubmit(event) {
  if (event.target.id === 'itemForm') {
    event.preventDefault();
    saveDrawerForm(event.target);
  }
  if (event.target.id === 'feedbackForm') {
    event.preventDefault();
    addFeedback(event.target);
  }
  if (event.target.id === 'runForm') {
    event.preventDefault();
    addRun(event.target);
  }
}

document.addEventListener('click', handleDocumentClick);
document.addEventListener('submit', handleSubmit);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && selectedItem) closeDrawer();
  const card = event.target.closest?.('.work-card');
  if (card && (event.key === 'Enter' || event.key === ' ')) openDrawer(card.dataset.type, card.dataset.id);
});
document.addEventListener('dragstart', (event) => {
  const card = event.target.closest('.work-card');
  if (!card) return;
  card.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('application/json', JSON.stringify({ type: card.dataset.type, id: card.dataset.id }));
});
document.addEventListener('dragend', (event) => event.target.closest('.work-card')?.classList.remove('dragging'));
document.addEventListener('dragover', (event) => {
  const target = event.target.closest('.board-column, .area-item');
  if (!target) return;
  event.preventDefault();
  target.classList.add('drag-over');
});
document.addEventListener('dragleave', (event) => event.target.closest('.board-column, .area-item')?.classList.remove('drag-over'));
document.addEventListener('drop', (event) => {
  const target = event.target.closest('.board-column, .area-item');
  if (!target) return;
  event.preventDefault();
  target.classList.remove('drag-over');
  try {
    const payload = JSON.parse(event.dataTransfer.getData('application/json'));
    const item = getEntity(payload.type, payload.id);
    if (!item) return;
    if (target.classList.contains('area-item')) moveDragged(payload.type, payload.id, { stage: item.stage, areaId: target.dataset.areaId });
    else moveDragged(payload.type, payload.id, { stage: target.dataset.stage, areaId: selectedAreaId });
  } catch (error) {
    showToast(error.message, 'error');
  }
});

refs.searchInput.addEventListener('input', renderBoard);
refs.priorityFilter.addEventListener('change', renderBoard);
refs.addItemBtn.addEventListener('click', addItem);
$('#addAreaBtn').addEventListener('click', addArea);
$('#exportBtn').addEventListener('click', exportState);
$('#importBtn').addEventListener('click', () => refs.importInput.click());
refs.importInput.addEventListener('change', async () => {
  try { if (refs.importInput.files[0]) await importState(refs.importInput.files[0]); }
  catch (error) { showToast(error.message, 'error'); }
  refs.importInput.value = '';
});
$('#runButlerBtn').addEventListener('click', async () => {
  try {
    const response = await fetch('/api/butler/run', { method: 'POST' });
    if (!response.ok) throw new Error('Butler scan failed');
    state.butler = await response.json();
    renderButler();
    showToast('Butler scan persisted · top three only');
  } catch (error) {
    showToast(error.message, 'error');
  }
});
refs.drawerBackdrop.addEventListener('click', closeDrawer);
setInterval(async () => {
  if (!state || selectedItem) return;
  try {
    const latest = await (await fetch('/api/state', { cache: 'no-store' })).json();
    state.butler = latest.butler;
    renderButler();
  } catch {}
}, 60_000);

loadState().catch((error) => {
  setSaveStatus('Connection failed', 'error');
  showToast(error.message, 'error');
});
