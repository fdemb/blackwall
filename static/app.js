'use strict';

const state = { profile: null, workspace: null, revision: 0, members: [], view: 'issues', filter: {}, csrf: sessionStorage.getItem('blackwall-csrf') || '', register: false, schema: null };
const $ = (selector, root = document) => root.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dictionary = {
  en: { logout: 'Sign out', welcome: "Organize your team's work", auth_hint: 'Sign in or create an account to get started.', email: 'Email', password: 'Password', display_name: 'Display name', sign_in: 'Sign in', register: 'Create account', forgot_password: 'Forgot your password?', request_reset: 'Request recovery', reset_token: 'Recovery token', new_password: 'New password', reset_password: 'Reset password', workspace: 'Workspace', new_workspace: 'New workspace', issues: 'Issues', my_issues: 'My issues', board: 'Board', planning: 'Planning', inbox: 'Inbox', reports: 'Reports', members: 'People', trash: 'Trash', settings: 'Settings', search: 'Search', new_issue: 'New issue', save: 'Save', cancel: 'Cancel', title: 'Title', description: 'Description · Markdown', team: 'Team', stage: 'Stage', assignee: 'Assignee', priority: 'Priority', deadline: 'Deadline', estimate: 'Effort estimate', project: 'Project', sprint: 'Sprint', milestone: 'Milestone', labels: 'Labels', parent: 'Parent issue', dependencies: 'Blocked by', unassigned: 'Unassigned', none: 'None', all: 'All', empty_issues: 'No issues here. Create an issue or change the filters.', empty_workspace: 'Create a workspace to organize your first team.', sort: 'Sort', position: 'Position', updated: 'Recently updated', low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent', comment: 'Comment · Markdown', comments: 'Discussion', add_comment: 'Add comment', mentions: 'Mention colleagues', edit: 'Edit', delete: 'Delete', restore: 'Restore', follow: 'Follow', unfollow: 'Unfollow', time: 'Time entries', minutes: 'Minutes', note: 'Note', log_time: 'Log time', attachments: 'Attachments', upload: 'Upload attachment', save_view: 'Save view', view_name: 'View name', saved: 'Saved.', failed: 'Request failed.', close: 'Close', no_comments: 'No comments yet.', no_notifications: 'You are caught up.', mark_read: 'Mark read', read_all: 'Mark all read', name: 'Name', goal: 'Goal', starts: 'Starts', ends: 'Ends', create_team: 'Create team', create_project: 'Create project', create_sprint: 'Create sprint', create_milestone: 'Create milestone', teams: 'Teams', projects: 'Projects', sprints: 'Sprints', milestones: 'Milestones', complete: 'Complete', archive: 'Archive', backlog: 'Backlog', carryover: 'Move unfinished work to', role: 'Role', owner: 'Owner', admin: 'Admin', member: 'Member', viewer: 'Viewer', invite: 'Invite colleague', invitations: 'Pending invitations', resend: 'Resend', remove: 'Remove', profile: 'Profile', contact: 'Contact information', avatar: 'Profile picture URL', language: 'Language', theme: 'Theme', light: 'Light', dark: 'Dark', system: 'System', change_password: 'Change password', current_password: 'Current password', recovery_sent: 'If that account exists, recovery instructions have been queued.', alerts: 'Notifications', assignment: 'Assignments', reply: 'Replies', change: 'Changes', mention: 'Mentions', deadline_alert: 'Approaching deadlines', export: 'Export issues', import: 'Import issues', import_hint: 'Choose a Blackwall JSON export. Issues are imported into the selected workspace.', operations: 'More workspace actions', action: 'Action', run: 'Run action', bulk_delete: 'Delete selected', bulk_status: 'Set stage for selected', bulk_priority: 'Set priority for selected', total_minutes: 'Total minutes', open_issues: 'Open issues', effort: 'Effort', completed: 'Completed', delivery: 'Delivery by day', activity: 'Activity history', no_team: 'Create a team in Planning before adding issues.', search_hint: 'Search issues and people', accept_invitation: 'Accept an invitation', invitation_token: 'Invitation token', accept: 'Accept', refresh: 'Refresh', confirmation: 'Delete this issue? You can restore it from Trash.', conflict: 'Someone changed this workspace. Reloaded the latest version; please retry your change.', selection: 'Select issue', no_items: 'Nothing here yet.', profile_hint: 'Choose a person to see their contact details.', advanced_hint: 'Additional actions use the API contract. Choose an action, fill its fields, and submit.', notifications: 'Alerts', shared: 'Share with workspace', preview: 'Preview', source_links: 'Source links', add_link: 'Add source link', url: 'URL', logged_at: 'Logged at' },
  pl: { logout: 'Wyloguj', welcome: 'Zorganizuj pracę zespołu', auth_hint: 'Zaloguj się lub utwórz konto, aby zacząć.', email: 'E-mail', password: 'Hasło', display_name: 'Nazwa wyświetlana', sign_in: 'Zaloguj', register: 'Utwórz konto', forgot_password: 'Nie pamiętasz hasła?', request_reset: 'Odzyskaj hasło', reset_token: 'Token odzyskiwania', new_password: 'Nowe hasło', reset_password: 'Zresetuj hasło', workspace: 'Przestrzeń robocza', new_workspace: 'Nowa przestrzeń', issues: 'Zadania', my_issues: 'Moje zadania', board: 'Tablica', planning: 'Planowanie', inbox: 'Skrzynka', reports: 'Raporty', members: 'Osoby', trash: 'Kosz', settings: 'Ustawienia', search: 'Szukaj', new_issue: 'Nowe zadanie', save: 'Zapisz', cancel: 'Anuluj', title: 'Tytuł', description: 'Opis · Markdown', team: 'Zespół', stage: 'Etap', assignee: 'Osoba przypisana', priority: 'Priorytet', deadline: 'Termin', estimate: 'Nakład pracy', project: 'Projekt', sprint: 'Sprint', milestone: 'Kamień milowy', labels: 'Etykiety', parent: 'Zadanie nadrzędne', dependencies: 'Blokowane przez', unassigned: 'Nieprzypisane', none: 'Brak', all: 'Wszystkie', empty_issues: 'Brak zadań. Utwórz zadanie lub zmień filtry.', empty_workspace: 'Utwórz przestrzeń roboczą dla swojego zespołu.', sort: 'Sortowanie', position: 'Kolejność', updated: 'Ostatnio zmienione', low: 'Niski', normal: 'Normalny', high: 'Wysoki', urgent: 'Pilny', comment: 'Komentarz · Markdown', comments: 'Dyskusja', add_comment: 'Dodaj komentarz', mentions: 'Wspomnij osoby', edit: 'Edytuj', delete: 'Usuń', restore: 'Przywróć', follow: 'Obserwuj', unfollow: 'Nie obserwuj', time: 'Wpisy czasu', minutes: 'Minuty', note: 'Notatka', log_time: 'Zapisz czas', attachments: 'Załączniki', upload: 'Dodaj załącznik', save_view: 'Zapisz widok', view_name: 'Nazwa widoku', saved: 'Zapisano.', failed: 'Żądanie nie powiodło się.', close: 'Zamknij', no_comments: 'Brak komentarzy.', no_notifications: 'Wszystko na bieżąco.', mark_read: 'Oznacz jako przeczytane', read_all: 'Oznacz wszystkie', name: 'Nazwa', goal: 'Cel', starts: 'Początek', ends: 'Koniec', create_team: 'Utwórz zespół', create_project: 'Utwórz projekt', create_sprint: 'Utwórz sprint', create_milestone: 'Dodaj kamień milowy', teams: 'Zespoły', projects: 'Projekty', sprints: 'Sprinty', milestones: 'Kamienie milowe', complete: 'Zakończ', archive: 'Archiwizuj', backlog: 'Backlog', carryover: 'Przenieś niezakończone zadania do', role: 'Rola', owner: 'Właściciel', admin: 'Administrator', member: 'Członek', viewer: 'Obserwator', invite: 'Zaproś osobę', invitations: 'Oczekujące zaproszenia', resend: 'Wyślij ponownie', remove: 'Usuń', profile: 'Profil', contact: 'Dane kontaktowe', avatar: 'Adres zdjęcia profilowego', language: 'Język', theme: 'Motyw', light: 'Jasny', dark: 'Ciemny', system: 'Systemowy', change_password: 'Zmień hasło', current_password: 'Obecne hasło', recovery_sent: 'Jeśli konto istnieje, instrukcje odzyskiwania zostały dodane do kolejki.', alerts: 'Powiadomienia', assignment: 'Przypisania', reply: 'Odpowiedzi', change: 'Zmiany', mention: 'Wzmianki', deadline_alert: 'Zbliżające się terminy', export: 'Eksportuj zadania', import: 'Importuj zadania', import_hint: 'Wybierz eksport JSON z Blackwall. Zadania trafią do bieżącej przestrzeni.', operations: 'Pozostałe działania', action: 'Działanie', run: 'Wykonaj', bulk_delete: 'Usuń zaznaczone', bulk_status: 'Zmień etap zaznaczonych', bulk_priority: 'Zmień priorytet zaznaczonych', total_minutes: 'Suma minut', open_issues: 'Otwarte zadania', effort: 'Nakład pracy', completed: 'Zakończone', delivery: 'Zakończenia według dni', activity: 'Historia aktywności', no_team: 'Utwórz zespół w Planowaniu przed dodaniem zadania.', search_hint: 'Szukaj zadań i osób', accept_invitation: 'Przyjmij zaproszenie', invitation_token: 'Token zaproszenia', accept: 'Przyjmij', refresh: 'Odśwież', confirmation: 'Usunąć zadanie? Możesz je przywrócić z Kosza.', conflict: 'Ktoś zmienił przestrzeń. Wczytano nową wersję; powtórz zmianę.', selection: 'Zaznacz zadanie', no_items: 'Na razie nic tutaj nie ma.', profile_hint: 'Wybierz osobę, aby zobaczyć dane kontaktowe.', advanced_hint: 'Dodatkowe działania korzystają z kontraktu API. Wybierz działanie, uzupełnij pola i wyślij.', notifications: 'Alerty', shared: 'Udostępnij przestrzeni', preview: 'Podgląd', source_links: 'Odnośniki źródłowe', add_link: 'Dodaj odnośnik', url: 'Adres URL', logged_at: 'Data wpisu' }
};
dictionary.en.workspace_id = 'Workspace ID';
dictionary.pl.workspace_id = 'Identyfikator przestrzeni';
dictionary.en.planned = 'Planned'; dictionary.pl.planned = 'Planowany';
dictionary.en.active = 'Active'; dictionary.pl.active = 'Aktywny';
dictionary.en.archived = 'Archived'; dictionary.pl.archived = 'Archiwalny';
const t = key => dictionary[state.profile?.language || 'en'][key] || dictionary.en[key] || key;
const textInput = (name, key, value = '', type = 'text', required = false) => `<label><span>${t(key)}</span><input name="${name}" type="${type}" value="${escape(value)}" ${required ? 'required' : ''}></label>`;
const options = (items, value, empty = 'none') => `<option value="">${t(empty)}</option>` + items.map(item => `<option value="${escape(item.id)}" ${item.id === value ? 'selected' : ''}>${escape(item.name || item.title || item.display_name)}</option>`).join('');
const select = (name, key, items, value, empty = 'none', multiple = false) => `<label><span>${t(key)}</span><select name="${name}" ${multiple ? 'multiple' : ''}>${multiple ? items.map(item => `<option value="${item.id}" ${(value || []).includes(item.id) ? 'selected' : ''}>${escape(item.name || item.title || item.display_name)}</option>`).join('') : options(items, value, empty)}</select></label>`;
const enumItems = values => values.map(id => ({ id, name: t(id) }));
const priorities = () => enumItems(['none', 'low', 'normal', 'high', 'urgent']);
const members = () => state.members.map(p => ({ ...p, name: p.display_name }));
const memberName = id => state.members.find(p => p.id === id)?.display_name || id || t('unassigned');
const getTeam = id => state.workspace.teams.find(team => team.id === id);
const getStage = id => state.workspace.teams.flatMap(team => team.stages).find(stage => stage.id === id);
const localDate = value => value ? new Date(value).toLocaleDateString(state.profile?.language === 'pl' ? 'pl-PL' : 'en-GB') : '';
const localInput = value => value ? new Date(new Date(value).getTime() - new Date(value).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
const iso = value => value ? new Date(value).toISOString() : null;
const formValue = (form, name) => form.elements[name]?.value || '';
const chosen = (form, name) => [...form.elements[name].selectedOptions].map(option => option.value).filter(Boolean);

function notice(message, error = false) {
  $('#notice').hidden = false;
  $('#notice').textContent = message;
  $('#notice').classList.toggle('error', error);
}
function preferences() {
  document.documentElement.lang = state.profile?.language || 'en';
  document.documentElement.dataset.theme = state.profile?.theme || 'system';
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  $('#search').placeholder = t('search_hint');
}
async function api(path, method = 'GET', body) {
  const headers = {};
  if (method !== 'GET') headers['X-CSRF-Token'] = state.csrf;
  if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, { method, credentials: 'same-origin', headers, body: body ? body instanceof FormData ? body : JSON.stringify(body) : undefined });
  const csrf = response.headers.get('X-CSRF-Token');
  if (csrf) { state.csrf = csrf; sessionStorage.setItem('blackwall-csrf', csrf); }
  const result = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(result?.message || result?.error || result?.detail || t('failed'));
    error.status = response.status;
    throw error;
  }
  return result;
}
const workspacePath = suffix => `/api/workspaces/${state.workspace.id}${suffix}`;
async function command(change, refresh = true) {
  try {
    const result = await api(workspacePath('/commands'), 'POST', { revision: state.revision, command: change });
    state.revision = result.revision;
    if (refresh) await loadWorkspace();
    notice(t('saved'));
    return result;
  } catch (error) {
    if (error.status === 409) { await loadWorkspace(); throw new Error(t('conflict')); }
    throw error;
  }
}
function handle(form, action) {
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const buttons = [...form.querySelectorAll('button')];
    buttons.forEach(button => { button.disabled = true; });
    try { await action(form); } catch (error) { notice(error.message, true); }
    finally { buttons.forEach(button => { button.disabled = false; }); }
  });
}
function click(selector, action, root = document) {
  root.querySelectorAll(selector).forEach(button => button.addEventListener('click', async event => {
    try { await action(button, event); } catch (error) { notice(error.message, true); }
  }));
}
async function session(profile) {
  state.profile = profile;
  preferences();
  $('#auth').hidden = true;
  $('#application').hidden = false;
  $('#logout').hidden = false;
  $('#identity').textContent = profile.display_name;
  await loadWorkspaces();
}
async function loadWorkspaces(preferred) {
  const workspaces = await api('/api/workspaces');
  $('#workspace').innerHTML = workspaces.map(w => `<option value="${w.id}">${escape(w.name)}</option>`).join('');
  const id = preferred || localStorage.getItem('blackwall-workspace');
  if (workspaces.some(w => w.id === id)) $('#workspace').value = id;
  if (workspaces.length) await loadWorkspace();
  else { state.workspace = null; $('#content').innerHTML = `<p class="empty">${t('empty_workspace')}</p>`; $('#new-issue').hidden = true; }
}
async function loadWorkspace() {
  const id = $('#workspace').value;
  if (!id) return;
  localStorage.setItem('blackwall-workspace', id);
  const [snapshot, profiles] = await Promise.all([api(`/api/workspaces/${id}`), api(`/api/workspaces/${id}/members`)]);
  state.workspace = snapshot.workspace;
  state.revision = snapshot.revision;
  state.members = profiles;
  $('#saved-views').innerHTML = (state.workspace.views || []).map(view => `<button data-saved="${view.id}">${escape(view.name)}</button>`).join('');
  click('[data-saved]', button => { const view = state.workspace.views.find(v => v.id === button.dataset.saved); state.filter = { ...view.filter }; show('issues'); });
  await show(state.view);
}
async function show(view) {
  state.view = view;
  $('#detail').hidden = true;
  $('#content').hidden = false;
  $('#filters').hidden = true;
  $('#page-title').textContent = t(view === 'mine' ? 'my_issues' : view);
  $('#new-issue').hidden = !state.workspace || !['issues', 'mine', 'backlog', 'board', 'trash'].includes(view);
  document.querySelectorAll('[data-view]').forEach(button => button.setAttribute('aria-current', button.dataset.view === view ? 'page' : 'false'));
  if (!state.workspace && view !== 'settings') return;
  if (['issues', 'mine', 'backlog', 'board', 'trash'].includes(view)) await issueList();
  else if (view === 'inbox') { const snapshot = await api(workspacePath('')); state.workspace = snapshot.workspace; state.revision = snapshot.revision; inbox(); }
  else if (view === 'planning') planning();
  else if (view === 'members') people();
  else if (view === 'settings') await settings();
  else if (view === 'reports') await reports();
}
function renderFilters() {
  const filter = state.filter;
  $('#filters').hidden = false;
  $('#filters').innerHTML = select('team_id', 'team', state.workspace.teams, filter.team_id, 'all') + select('assignee', 'assignee', members(), filter.assignee, 'all') + select('stage_id', 'stage', state.workspace.teams.flatMap(team => team.stages), filter.stage_id, 'all') + select('priority', 'priority', priorities(), filter.priority, 'all') + select('label_id', 'labels', state.workspace.labels, filter.label_id, 'all') + select('sprint_id', 'sprint', state.workspace.sprints, filter.sprint_id, 'all') + select('project_id', 'project', state.workspace.projects, filter.project_id, 'all') + textInput('due_before', 'deadline', localInput(filter.due_before), 'datetime-local') + select('sort', 'sort', enumItems(['position', 'deadline', 'updated', 'priority']), filter.sort || 'position');
  $('#filters').querySelectorAll('input,select').forEach(input => input.addEventListener('change', async () => {
    state.filter[input.name] = input.name === 'due_before' ? iso(input.value) : input.value;
    try { await issueList(); } catch (error) { notice(error.message, true); }
  }));
}
async function issueList() {
  renderFilters();
  const filter = { ...state.filter, trash: state.view === 'trash' };
  if (state.view === 'mine') filter.assignee = state.profile.id;
  const query = new URLSearchParams(Object.entries(filter).filter(([, value]) => value !== '' && value !== null && value !== undefined));
  let issues = await api(workspacePath(`/issues?${query}`));
  if (state.view === 'backlog') issues = issues.filter(issue => getStage(issue.stage_id)?.kind === 'backlog');
  if (state.view === 'board') { board(issues); return; }
  $('#content').innerHTML = `<div class="toolbar"><button id="save-view" class="secondary">${t('save_view')}</button><button id="bulk-delete" class="danger">${t(state.view === 'trash' ? 'restore' : 'bulk_delete')}</button><button id="bulk-status" class="secondary">${t('bulk_status')}</button><button id="bulk-priority" class="secondary">${t('bulk_priority')}</button></div>` + (issues.length ? `<div class="table-wrap"><table><thead><tr><th></th><th>#</th><th>${t('title')}</th><th>${t('stage')}</th><th>${t('assignee')}</th><th>${t('priority')}</th><th>${t('deadline')}</th></tr></thead><tbody>${issues.map(issue => `<tr><td><input type="checkbox" data-select="${issue.id}" aria-label="${t('selection')} ${issue.number}"></td><td class="number">${issue.number}</td><td><button class="link" data-issue="${issue.id}">${escape(issue.title)}</button></td><td>${escape(getStage(issue.stage_id)?.name)}</td><td>${escape(memberName(issue.assignee))}</td><td>${t(issue.priority)}</td><td>${localDate(issue.deadline)}</td></tr>`).join('')}</tbody></table></div>` : `<p class="empty">${t('empty_issues')}</p>`);
  click('[data-issue]', button => issueDetail(button.dataset.issue));
  click('#save-view', async () => { const name = prompt(t('view_name')); if (name) await command({ type: 'save_view', name, shared: false, filter: { ...filter, sort: filter.sort || 'position' } }); });
  const selected = () => [...document.querySelectorAll('[data-select]:checked')].map(input => input.dataset.select);
  click('#bulk-delete', async () => { const ids = selected(); if (ids.length && (state.view === 'trash' || confirm(t('confirmation')))) await command({ type: 'bulk_issues', ids, action: state.view === 'trash' ? 'restore' : 'delete' }); });
  click('#bulk-status', async () => { const ids = selected(); if (ids.length) bulkForm(ids, 'stage_id', state.workspace.teams.flatMap(team => team.stages)); });
  click('#bulk-priority', async () => { const ids = selected(); if (ids.length) bulkForm(ids, 'priority', priorities()); });
}
function bulkForm(ids, field, items) {
  $('#content').innerHTML = `<form id="bulk-form" class="editor">${select(field, field === 'stage_id' ? 'stage' : 'priority', items)}<div class="actions"><button>${t('save')}</button><button type="button" id="cancel-bulk" class="secondary">${t('cancel')}</button></div></form>`;
  handle($('#bulk-form'), async form => { const value = formValue(form, field); if (value) await command({ type: 'bulk_issues', ids, action: { update: { [field]: value } } }); });
  click('#cancel-bulk', () => show(state.view));
}
function board(issues) {
  const team = getTeam(state.filter.team_id) || state.workspace.teams[0];
  if (!team) { $('#content').innerHTML = `<p class="empty">${t('no_team')}</p>`; return; }
  $('#content').innerHTML = `<div class="board">${team.stages.slice().sort((a, b) => a.position - b.position).map(stage => `<section class="column" data-stage="${stage.id}"><h2>${escape(stage.name)} <span class="muted count">${issues.filter(issue => issue.team_id === team.id && issue.stage_id === stage.id).length}</span></h2>${issues.filter(issue => issue.team_id === team.id && issue.stage_id === stage.id).map(issue => `<button class="board-issue" draggable="true" data-issue="${issue.id}">#${issue.number} ${escape(issue.title)}<small>${escape(memberName(issue.assignee))} · ${t(issue.priority)}</small></button>`).join('')}</section>`).join('')}</div>`;
  click('[data-issue]', button => issueDetail(button.dataset.issue));
  document.querySelectorAll('[draggable]').forEach(button => button.addEventListener('dragstart', event => event.dataTransfer.setData('text/plain', button.dataset.issue)));
  document.querySelectorAll('[data-stage]').forEach(column => {
    column.addEventListener('dragover', event => { event.preventDefault(); column.classList.add('drag-over'); });
    column.addEventListener('dragleave', () => column.classList.remove('drag-over'));
    column.addEventListener('drop', async event => {
      event.preventDefault(); column.classList.remove('drag-over');
      const id = event.dataTransfer.getData('text/plain');
      const before = event.target.closest('[data-issue]')?.dataset.issue;
      if (!id || id === before) return;
      try { await command({ type: 'move_issue', id, stage_id: column.dataset.stage, before_id: before || null }); } catch (error) { notice(error.message, true); }
    });
  });
}
function issueFields(issue = {}) {
  const team = getTeam(issue.team_id) || state.workspace.teams[0];
  const active = state.workspace.issues.filter(item => !item.deleted_at && item.id !== issue.id);
  return `<div class="form-grid">${textInput('title', 'title', issue.title, 'text', true)}${select('team_id', 'team', state.workspace.teams, team.id)}<label class="wide"><span>${t('description')}</span><textarea name="description">${escape(issue.description)}</textarea></label>${select('stage_id', 'stage', team.stages, issue.stage_id || team.stages[0]?.id)}${select('assignee', 'assignee', members(), issue.assignee, 'unassigned')}${select('priority', 'priority', priorities(), issue.priority || 'none')}${textInput('deadline', 'deadline', localInput(issue.deadline), 'datetime-local')}${textInput('estimate', 'estimate', issue.estimate, 'number')}${select('project_id', 'project', state.workspace.projects, issue.project_id)}${select('milestone_id', 'milestone', state.workspace.milestones, issue.milestone_id)}${select('sprint_id', 'sprint', state.workspace.sprints.filter(sprint => !['completed', 'archived'].includes(sprint.state)), issue.sprint_id)}${select('parent_id', 'parent', active, issue.parent_id)}${select('labels', 'labels', state.workspace.labels, issue.labels, 'none', true)}${select('dependencies', 'dependencies', active, issue.dependencies, 'none', true)}</div>`;
}
async function issueDetail(id) {
  const snapshot = await api(workspacePath(''));
  state.workspace = snapshot.workspace; state.revision = snapshot.revision;
  const issue = state.workspace.issues.find(item => item.id === id);
  if (!issue) throw new Error('Issue not found');
  $('#content').hidden = true; $('#filters').hidden = true; $('#detail').hidden = false;
  $('#page-title').textContent = `#${issue.number} ${issue.title}`;
  const following = issue.followers.includes(state.profile.id);
  $('#detail').innerHTML = `<div class="toolbar"><button id="back" class="secondary">${t('close')}</button><button id="follow" class="secondary">${t(following ? 'unfollow' : 'follow')}</button><button id="delete-issue" class="danger">${t(issue.deleted_at ? 'restore' : 'delete')}</button></div><form id="issue-form" class="editor">${issueFields(issue)}<div class="actions"><button>${t('save')}</button><button type="button" id="preview" class="secondary">${t('preview')}</button></div><div id="preview-output" class="markdown" hidden></div></form><section class="discussion"><h2>${t('attachments')}</h2><ul class="plain-list">${issue.attachments.map(file => `<li><a href="${workspacePath(`/attachments/${file.id}`)}">${escape(file.name)}</a> <span class="muted">${file.size} B</span><button class="danger" data-remove-attachment="${file.id}">${t('remove')}</button></li>`).join('')}</ul><form id="upload-form">${textInput('file', 'attachments', '', 'file', true)}<button>${t('upload')}</button></form><h2>${t('source_links')}</h2><ul class="plain-list">${issue.source_links.map(link => `<li><a href="${escape(link.url)}" target="_blank" rel="noopener">${escape(link.title)}</a></li>`).join('')}</ul><form id="source-form">${textInput('title', 'title', '', 'text', true)}${textInput('url', 'url', '', 'url', true)}<button>${t('add_link')}</button></form><h2>${t('comments')}</h2><div id="comments"></div><form id="comment-form"><label><span>${t('comment')}</span><textarea name="body" required></textarea></label>${select('mentions', 'mentions', members(), [], 'none', true)}${textInput('file', 'attachments', '', 'file')}<button>${t('add_comment')}</button></form><h2>${t('time')}</h2><div id="time-entries"></div><form id="time-form"><div class="form-grid">${textInput('minutes', 'minutes', '', 'number', true)}${textInput('logged_at', 'logged_at', localInput(new Date().toISOString()), 'datetime-local', true)}${textInput('note', 'note')}</div><button>${t('log_time')}</button></form></section>`;
  $('#issue-form').elements.team_id.disabled = true;
  handle($('#issue-form'), async form => {
    const patch = issueInput(form);
    delete patch.team_id;
    patch.clear_assignee = !patch.assignee; patch.clear_deadline = !patch.deadline; patch.clear_sprint = !patch.sprint_id; patch.clear_parent = !patch.parent_id;
    await command({ type: 'update_issue', id, patch }); await issueDetail(id);
  });
  click('#back', () => show(state.view));
  click('#follow', async () => { await command({ type: 'follow', issue_id: id, following: !following }); await issueDetail(id); });
  click('#delete-issue', async () => { if (issue.deleted_at || confirm(t('confirmation'))) await command({ type: issue.deleted_at ? 'restore_issue' : 'delete_issue', id }); });
  click('#preview', async () => { const result = await api('/api/markdown', 'POST', { text: $('#issue-form').elements.description.value }); $('#preview-output').innerHTML = result.html; $('#preview-output').hidden = false; });
  click('[data-remove-attachment]', async button => { await command({ type: 'remove_attachment', issue_id: id, attachment_id: button.dataset.removeAttachment }); await issueDetail(id); });
  handle($('#upload-form'), async form => { const file = form.elements.file.files[0]; if (file) { const data = new FormData(); data.append('file', file); data.append('revision', String(state.revision)); await api(workspacePath(`/issues/${id}/attachments`), 'POST', data); await loadWorkspace(); await issueDetail(id); } });
  handle($('#source-form'), async form => { await command({ type: 'add_source_link', issue_id: id, title: formValue(form, 'title'), url: formValue(form, 'url') }); await issueDetail(id); });
  handle($('#comment-form'), async form => {
    const file = form.elements.file.files[0];
    const result = await command({ type: 'add_comment', issue_id: id, body: formValue(form, 'body'), mentions: chosen(form, 'mentions'), attachments: [] }, false);
    if (file) { const data = new FormData(); data.append('file', file); data.append('comment_id', result.result.id); data.append('revision', String(state.revision)); await api(workspacePath(`/issues/${id}/attachments`), 'POST', data); }
    await loadWorkspace(); await issueDetail(id);
  });
  handle($('#time-form'), async form => { await command({ type: 'log_time', issue_id: id, minutes: Number(formValue(form, 'minutes')), note: formValue(form, 'note'), logged_at: iso(formValue(form, 'logged_at')) }); await issueDetail(id); });
  const preview = await api('/api/markdown', 'POST', { text: issue.description });
  $('#preview-output').innerHTML = preview.html; $('#preview-output').hidden = !issue.description;
  await discussion(id);
}
function issueInput(form) {
  const input = { title: formValue(form, 'title'), description: formValue(form, 'description'), team_id: formValue(form, 'team_id'), priority: formValue(form, 'priority'), labels: chosen(form, 'labels'), dependencies: chosen(form, 'dependencies'), estimate: formValue(form, 'estimate') ? Number(formValue(form, 'estimate')) : null, deadline: iso(formValue(form, 'deadline')) };
  ['stage_id', 'assignee', 'project_id', 'milestone_id', 'sprint_id', 'parent_id'].forEach(key => { input[key] = formValue(form, key) || null; });
  return input;
}
function createIssue() {
  if (!state.workspace?.teams.length) { notice(t('no_team'), true); return; }
  $('#content').hidden = false; $('#filters').hidden = true; $('#detail').hidden = true;
  $('#page-title').textContent = t('new_issue');
  $('#content').innerHTML = `<form id="create-issue" class="editor">${issueFields()}<div class="actions"><button>${t('new_issue')}</button><button type="button" id="cancel-create" class="secondary">${t('cancel')}</button></div></form>`;
  const form = $('#create-issue');
  form.elements.team_id.addEventListener('change', () => { form.elements.stage_id.innerHTML = options(getTeam(form.elements.team_id.value).stages); });
  handle(form, async form => { const result = await command({ type: 'create_issue', input: issueInput(form) }); await issueDetail(result.result.id); });
  click('#cancel-create', () => show(state.view));
}
async function discussion(id) {
  const comments = state.workspace.comments.filter(comment => comment.issue_id === id);
  $('#comments').innerHTML = comments.length ? comments.map(comment => `<article class="comment"><div class="meta">${escape(memberName(comment.author))} · ${localDate(comment.created_at)} ${comment.edited_at ? `· ${t('edit')}` : ''}</div><div class="markdown" data-comment-body="${comment.id}"></div>${comment.attachments.map(file => `<a href="${workspacePath(`/attachments/${file.id}`)}">${escape(file.name)}</a>`).join(' ')}<div class="inline-actions"><button class="secondary" data-edit-comment="${comment.id}">${t('edit')}</button><button class="danger" data-delete-comment="${comment.id}">${t('delete')}</button></div></article>`).join('') : `<p class="muted">${t('no_comments')}</p>`;
  await Promise.all(comments.map(async comment => { const result = await api('/api/markdown', 'POST', { text: comment.body }); const el = $(`[data-comment-body="${comment.id}"]`); if (el) el.innerHTML = result.html; }));
  click('[data-edit-comment]', async button => { const comment = comments.find(item => item.id === button.dataset.editComment); const body = prompt(t('comment'), comment.body); if (body !== null) { await command({ type: 'edit_comment', id: comment.id, body, mentions: comment.mentions }); await issueDetail(id); } });
  click('[data-delete-comment]', async button => { await command({ type: 'delete_comment', id: button.dataset.deleteComment }); await issueDetail(id); });
  $('#time-entries').innerHTML = `<ul class="plain-list">${state.workspace.time_entries.filter(entry => entry.issue_id === id).map(entry => `<li>${escape(memberName(entry.user_id))} · ${entry.minutes} ${t('minutes')} · ${escape(entry.note)} <button class="secondary" data-edit-time="${entry.id}">${t('edit')}</button><button class="danger" data-delete-time="${entry.id}">${t('delete')}</button></li>`).join('')}</ul>`;
  click('[data-edit-time]', async button => { const entry = state.workspace.time_entries.find(item => item.id === button.dataset.editTime); const minutes = prompt(t('minutes'), entry.minutes); if (minutes === null) return; const note = prompt(t('note'), entry.note); if (note !== null) { await command({ type: 'update_time', id: entry.id, minutes: Number(minutes), note, logged_at: entry.logged_at }); await issueDetail(id); } });
  click('[data-delete-time]', async button => { await command({ type: 'delete_time', id: button.dataset.deleteTime }); await issueDetail(id); });
}
function inbox() {
  const notifications = state.workspace.notifications.filter(item => item.user_id === state.profile.id).slice().reverse();
  $('#content').innerHTML = `<button id="read-all" class="secondary">${t('read_all')}</button><ul class="plain-list">${notifications.map(item => `<li>${item.issue_id ? `<button class="secondary" data-issue="${item.issue_id}">${escape(item.message)}</button>` : escape(item.message)} <span class="muted">${localDate(item.created_at)}</span>${!item.read_at ? `<button data-read="${item.id}">${t('mark_read')}</button>` : ''}</li>`).join('')}</ul>${notifications.length ? '' : `<p class="empty">${t('no_notifications')}</p>`}`;
  click('[data-read]', button => command({ type: 'mark_notification_read', id: button.dataset.read }));
  click('#read-all', () => command({ type: 'mark_all_notifications_read' }));
  click('[data-issue]', button => issueDetail(button.dataset.issue));
}
function planning() {
  const w = state.workspace;
  $('#content').innerHTML = `<div class="split"><section><h2>${t('teams')}</h2><ul class="plain-list">${w.teams.map(team => `<li>${escape(team.name)} <span class="muted">${team.members.length} ${t('members')}</span></li>`).join('')}</ul><details><summary>${t('create_team')}</summary><form id="team-form">${textInput('name', 'name', '', 'text', true)}${select('members', 'members', members(), [], 'none', true)}<button>${t('create_team')}</button></form></details><h2>${t('projects')}</h2><ul class="plain-list">${w.projects.map(project => { const issues = w.issues.filter(issue => issue.project_id === project.id && !issue.deleted_at); return `<li><strong>${escape(project.name)}</strong><p>${escape(project.description)}</p><span class="muted">${issues.filter(issue => getStage(issue.stage_id)?.kind === 'done').length}/${issues.length} ${t('completed')}</span></li>`; }).join('')}</ul><details><summary>${t('create_project')}</summary><form id="project-form">${textInput('name', 'name', '', 'text', true)}<label><span>${t('description')}</span><textarea name="description"></textarea></label>${select('team_ids', 'teams', w.teams, [], 'none', true)}<button>${t('create_project')}</button></form></details><h2>${t('milestones')}</h2><ul class="plain-list">${w.milestones.map(milestone => `<li>${escape(milestone.name)} · ${localDate(milestone.deadline)}</li>`).join('')}</ul><details><summary>${t('create_milestone')}</summary><form id="milestone-form">${textInput('name', 'name', '', 'text', true)}${select('project_id', 'project', w.projects)}${textInput('deadline', 'deadline', '', 'datetime-local')}<button>${t('create_milestone')}</button></form></details></section><section><h2>${t('sprints')}</h2><ul class="plain-list">${w.sprints.map(sprint => `<li><strong>${escape(sprint.name)}</strong> <span class="muted">${t(sprint.state)} · ${localDate(sprint.starts_at)} / ${localDate(sprint.ends_at)}</span><p>${escape(sprint.goal)}</p>${!['completed', 'archived'].includes(sprint.state) ? `<button data-complete="${sprint.id}">${t('complete')}</button>` : ''}${sprint.state !== 'archived' ? `<button data-archive="${sprint.id}" class="secondary">${t('archive')}</button>` : ''}</li>`).join('')}</ul><details><summary>${t('create_sprint')}</summary><form id="sprint-form">${textInput('name', 'name', '', 'text', true)}${select('team_id', 'team', w.teams)}${textInput('goal', 'goal', '', 'text', true)}${textInput('starts_at', 'starts', '', 'datetime-local', true)}${textInput('ends_at', 'ends', '', 'datetime-local', true)}<button>${t('create_sprint')}</button></form></details></section></div>`;
  handle($('#team-form'), form => command({ type: 'create_team', name: formValue(form, 'name'), members: chosen(form, 'members') }));
  handle($('#project-form'), form => command({ type: 'create_project', name: formValue(form, 'name'), description: formValue(form, 'description'), team_ids: chosen(form, 'team_ids') }));
  handle($('#milestone-form'), form => command({ type: 'create_milestone', name: formValue(form, 'name'), project_id: formValue(form, 'project_id'), deadline: iso(formValue(form, 'deadline')) }));
  handle($('#sprint-form'), form => command({ type: 'create_sprint', name: formValue(form, 'name'), team_id: formValue(form, 'team_id'), goal: formValue(form, 'goal'), starts_at: iso(formValue(form, 'starts_at')), ends_at: iso(formValue(form, 'ends_at')) }));
  click('[data-archive]', button => command({ type: 'archive_sprint', id: button.dataset.archive }));
  click('[data-complete]', button => {
    const sprint = w.sprints.find(item => item.id === button.dataset.complete);
    const targets = w.sprints.filter(item => item.id !== sprint.id && item.team_id === sprint.team_id && !['completed', 'archived'].includes(item.state));
    $('#content').innerHTML = `<form id="complete-form" class="editor"><h2>${escape(sprint.name)}</h2>${select('target', 'carryover', targets, null, 'backlog')}<div class="actions"><button>${t('complete')}</button><button id="cancel-sprint" type="button" class="secondary">${t('cancel')}</button></div></form>`;
    handle($('#complete-form'), form => command({ type: 'complete_sprint', id: sprint.id, carryover_sprint_id: formValue(form, 'target') || null }));
    click('#cancel-sprint', () => show('planning'));
  });
}
function people() {
  const w = state.workspace;
  const invites = w.invitations.filter(invite => invite.state === 'pending');
  $('#content').innerHTML = `<p class="muted">${t('profile_hint')}</p><ul class="plain-list">${state.members.map(profile => `<li><button class="secondary" data-profile="${profile.id}">${escape(profile.display_name)}</button> <span class="muted">${escape(profile.email)}</span><div class="row-actions">${select(`role-${profile.id}`, 'role', enumItems(['owner', 'admin', 'member', 'viewer']), w.members.find(member => member.user_id === profile.id)?.role)}<button class="secondary" data-role="${profile.id}">${t('save')}</button><button class="danger" data-remove-member="${profile.id}">${t('remove')}</button></div></li>`).join('')}</ul><section id="member-profile" class="settings-section" hidden></section><h2>${t('invite')}</h2><form id="invite-form" class="settings-section">${textInput('email', 'email', '', 'email', true)}${select('role', 'role', enumItems(['admin', 'member', 'viewer']), 'member')}<button>${t('invite')}</button></form><h2>${t('invitations')}</h2><ul class="plain-list">${invites.map(invite => `<li>${escape(invite.email)} · ${t(invite.role)} · ${localDate(invite.expires_at)}<button class="secondary" data-resend="${invite.id}">${t('resend')}</button><button class="danger" data-cancel-invite="${invite.id}">${t('cancel')}</button></li>`).join('')}</ul><details><summary>${t('accept_invitation')}</summary><form id="accept-form">${textInput('token', 'invitation_token', '', 'text', true)}<button>${t('accept')}</button></form></details>`;
  handle($('#invite-form'), form => command({ type: 'invite', email: formValue(form, 'email'), role: formValue(form, 'role'), token_hash: '' }));
  click('[data-resend]', button => command({ type: 'resend_invitation', id: button.dataset.resend, token_hash: '' }));
  click('[data-cancel-invite]', button => command({ type: 'cancel_invitation', id: button.dataset.cancelInvite }));
  click('[data-role]', button => command({ type: 'set_role', user_id: button.dataset.role, role: $(`[name="role-${button.dataset.role}"]`).value }));
  click('[data-remove-member]', async button => { if (confirm(`${t('remove')} ${memberName(button.dataset.removeMember)}?`)) { await command({ type: 'remove_member', user_id: button.dataset.removeMember }, false); await loadWorkspaces(); } });
  click('[data-profile]', button => {
    const profile = state.members.find(item => item.id === button.dataset.profile);
    const teams = w.teams.filter(team => team.members.includes(profile.id));
    $('#member-profile').hidden = false;
    $('#member-profile').innerHTML = `<h2>${escape(profile.display_name)}</h2>${profile.avatar_url ? `<img src="${escape(profile.avatar_url)}" alt="" width="64" height="64" loading="lazy">` : ''}<p><a href="mailto:${escape(profile.email)}">${escape(profile.email)}</a></p><p class="profile-contact">${escape(profile.contact)}</p><p>${t('teams')}: ${teams.map(team => escape(team.name)).join(', ') || t('none')}</p>`;
  });
  handle($('#accept-form'), async form => { await api(workspacePath('/invitations/accept'), 'POST', { token: formValue(form, 'token') }); await loadWorkspaces(); });
}
async function reports() {
  const report = await api(workspacePath('/report'));
  const table = (heading, rows, name) => `<h2>${t(heading)}</h2><div class="table-wrap"><table><thead><tr><th>${t('name')}</th><th>${t('minutes')}</th><th>${t('open_issues')}</th><th>${t('effort')}</th></tr></thead><tbody>${rows.map(row => `<tr><td>${escape(name(row.id))}</td><td class="number">${row.minutes}</td><td class="number">${row.open_issues}</td><td class="number">${row.effort}</td></tr>`).join('')}</tbody></table></div>`;
  $('#content').innerHTML = `<p>${t('total_minutes')}: <strong class="count">${report.total_minutes}</strong></p>${table('members', report.people, memberName)}${table('teams', report.teams, id => getTeam(id)?.name || id)}${table('projects', report.projects, id => state.workspace.projects.find(item => item.id === id)?.name || id)}${table('issues', report.issues, id => state.workspace.issues.find(item => item.id === id)?.title || id)}<h2>${t('sprints')}</h2><ul class="plain-list">${report.sprints.map(row => `<li>${escape(state.workspace.sprints.find(item => item.id === row.id)?.name)}: ${row.completed}/${row.total} ${t('completed')} · ${row.effort} ${t('effort')}</li>`).join('')}</ul><h2>${t('delivery')}</h2><ul class="plain-list">${report.delivery.map(day => `<li>${escape(day.date)}: ${day.completed} ${t('completed')}</li>`).join('')}</ul>`;
}
async function settings() {
  const p = state.profile;
  const alerts = state.workspace?.alert_preferences.find(item => item.user_id === p.id) || { assignment: true, reply: true, change: true, mention: true, deadline: true };
  $('#content').innerHTML = `<section class="settings-section"><h2>${t('profile')}</h2><form id="profile-form">${textInput('display_name', 'display_name', p.display_name, 'text', true)}${textInput('avatar_url', 'avatar', p.avatar_url, 'url')}<label><span>${t('contact')}</span><textarea name="contact">${escape(p.contact)}</textarea></label>${select('language', 'language', [{ id: 'en', name: 'English' }, { id: 'pl', name: 'Polski' }], p.language)}${select('theme', 'theme', enumItems(['light', 'dark', 'system']), p.theme)}<button>${t('save')}</button></form></section><section class="settings-section"><h2>${t('change_password')}</h2><form id="password-form">${textInput('current_password', 'current_password', '', 'password', true)}${textInput('new_password', 'new_password', '', 'password', true)}<button>${t('change_password')}</button></form></section>`;
  if (state.workspace) $('#content').insertAdjacentHTML('beforeend', `<section class="settings-section"><h2>${t('alerts')}</h2><form id="alerts-form">${Object.entries(alerts).filter(([key]) => key !== 'user_id').map(([key, enabled]) => `<label class="checkbox-label"><input type="checkbox" name="${key}" ${enabled ? 'checked' : ''}><span>${t(key === 'deadline' ? 'deadline_alert' : key)}</span></label>`).join('')}<button>${t('save')}</button></form></section><section class="settings-section"><h2>${t('import')} / ${t('export')}</h2><button id="export" class="secondary">${t('export')}</button><p class="muted">${t('import_hint')}</p><form id="import-form">${textInput('file', 'import', '', 'file', true)}<button>${t('import')}</button></form></section><section class="settings-section"><details id="more-actions"><summary>${t('operations')}</summary><p class="muted">${t('advanced_hint')}</p><div id="command-explorer"></div></details></section><section class="settings-section"><h2>${t('activity')}</h2><ul class="plain-list">${state.workspace.activity.slice(-100).reverse().map(event => `<li>${escape(memberName(event.actor))} · ${escape(event.action)} · ${localDate(event.at)}</li>`).join('')}</ul></section>`);
  handle($('#profile-form'), async form => {
    const profile = await api('/api/me', 'PATCH', { display_name: formValue(form, 'display_name'), avatar_url: formValue(form, 'avatar_url') || null, contact: formValue(form, 'contact'), language: formValue(form, 'language'), theme: formValue(form, 'theme'), alerts: p.alerts });
    state.profile = profile; preferences(); $('#identity').textContent = profile.display_name; await show('settings'); notice(t('saved'));
  });
  handle($('#password-form'), async form => { await api('/api/auth/password', 'POST', { current_password: formValue(form, 'current_password'), new_password: formValue(form, 'new_password') }); signedOut(); notice(t('saved')); });
  if (!state.workspace) return;
  handle($('#alerts-form'), form => command({ type: 'configure_alerts', assignment: form.elements.assignment.checked, reply: form.elements.reply.checked, change: form.elements.change.checked, mention: form.elements.mention.checked, deadline: form.elements.deadline.checked }));
  click('#export', async () => { const exported = await api(workspacePath('/export')); const url = URL.createObjectURL(new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = 'blackwall-issues.json'; link.click(); URL.revokeObjectURL(url); });
  handle($('#import-form'), async form => { const imported = JSON.parse(await form.elements.file.files[0].text()); if (imported.version !== 1 || !Array.isArray(imported.issues)) throw new Error('Choose a version 1 Blackwall JSON export.'); await api(workspacePath('/import'), 'POST', imported.teams ? { revision: state.revision, transfer: imported } : { revision: state.revision, issues: imported.issues }); await loadWorkspace(); notice(t('saved')); });
  $('#more-actions').addEventListener('toggle', async event => { if (event.target.open && !$('#command-explorer').hasChildNodes()) { try { await commandExplorer(); } catch (error) { notice(error.message, true); } } });
}
function resolveSchema(schema) {
  if (schema?.$ref) return schema.$ref.split('/').slice(1).reduce((value, key) => value?.[key], state.schema);
  return schema;
}
function schemaExample(input, depth = 0, name = '') {
  const schema = resolveSchema(input) || {};
  if (depth > 5) return null;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum) return schema.enum[0];
  if (schema.const !== undefined) return schema.const;
  if (schema.oneOf || schema.anyOf) return schemaExample((schema.oneOf || schema.anyOf)[0], depth + 1, name);
  if (schema.allOf) return Object.assign({}, ...schema.allOf.map(item => schemaExample(item, depth + 1, name)));
  if (schema.type === 'object' || schema.properties) return Object.fromEntries(Object.entries(schema.properties || {}).map(([key, field]) => [key, schemaExample(field, depth + 1, key)]));
  if (schema.type === 'array') return [];
  if (schema.type === 'boolean') return false;
  if (schema.type === 'integer' || schema.type === 'number') return 0;
  if (schema.format === 'date-time') return new Date().toISOString();
  if (schema.format === 'uuid') {
    const sources = { team_id: state.workspace.teams, stage_id: state.workspace.teams[0]?.stages, issue_id: state.workspace.issues, project_id: state.workspace.projects, milestone_id: state.workspace.milestones, sprint_id: state.workspace.sprints };
    if (name === 'user_id') return state.profile.id;
    return sources[name]?.[0]?.id || '00000000-0000-0000-0000-000000000000';
  }
  return '';
}
async function commandExplorer() {
  state.schema ||= await api('/api/schema.json');
  const commandSchema = resolveSchema(state.schema.components?.schemas?.Command);
  const variants = (commandSchema?.oneOf || commandSchema?.anyOf || []).map(resolveSchema).filter(Boolean);
  const actions = variants.map(schema => ({ schema, name: schema.properties?.type?.enum?.[0] || schema.properties?.type?.const })).filter(action => action.name);
  if (!actions.length) { $('#command-explorer').innerHTML = '<a href="/api/schema.json">Open API schema</a>'; return; }
  $('#command-explorer').innerHTML = `<form id="command-form">${select('action', 'action', actions.map(action => ({ id: action.name, name: action.name.replaceAll('_', ' ') })), actions[0].name)}<label><span>JSON</span><textarea name="command" rows="14" spellcheck="false"></textarea></label><button>${t('run')}</button></form>`;
  const form = $('#command-form');
  const update = () => { form.elements.command.value = JSON.stringify(schemaExample(actions.find(action => action.name === form.elements.action.value).schema), null, 2); };
  form.elements.action.addEventListener('change', update); update();
  handle(form, async form => { await command(JSON.parse(formValue(form, 'command'))); });
}
function signedOut() {
  state.profile = null; state.workspace = null; state.csrf = ''; state.filter = {};
  sessionStorage.removeItem('blackwall-csrf');
  $('#application').hidden = true; $('#auth').hidden = false; $('#logout').hidden = true; $('#identity').textContent = '';
}
handle($('#auth-form'), async form => {
  const input = { email: formValue(form, 'email'), password: formValue(form, 'password') };
  if (state.register) input.display_name = formValue(form, 'display_name');
  const result = await api(`/api/auth/${state.register ? 'register' : 'login'}`, 'POST', input);
  state.csrf = result.csrf_token; sessionStorage.setItem('blackwall-csrf', state.csrf);
  form.reset(); await session(result.profile);
});
click('#auth-mode', () => {
  state.register = !state.register;
  $('#name-field').hidden = !state.register;
  $('#auth-form').elements.display_name.required = state.register;
  $('#auth-form').elements.password.minLength = state.register ? 12 : 1;
  $('#auth-form').elements.password.autocomplete = state.register ? 'new-password' : 'current-password';
  $('#auth-form button[type=submit]').textContent = t(state.register ? 'register' : 'sign_in');
  $('#auth-mode').textContent = t(state.register ? 'sign_in' : 'register');
});
handle($('#reset-request'), async form => { await api('/api/auth/reset-request', 'POST', { email: formValue(form, 'email') }); notice(t('recovery_sent')); });
handle($('#reset-password'), async form => { await api('/api/auth/reset', 'POST', { token: formValue(form, 'token'), password: formValue(form, 'password') }); form.reset(); notice(t('saved')); });
click('#logout', async () => { await api('/api/auth/logout', 'POST', {}); signedOut(); });
click('#new-workspace', async () => { const name = prompt(t('name')); if (name) { const result = await api('/api/workspaces', 'POST', { name }); await loadWorkspaces(result.id || result.workspace?.id); } });
click('#new-issue', createIssue);
click('#refresh', () => state.workspace ? loadWorkspace() : loadWorkspaces());
setInterval(() => { if (state.profile && state.workspace && state.view === 'inbox' && $('#detail').hidden && document.visibilityState === 'visible') show('inbox').catch(error => notice(error.message, true)); }, 30000);
handle($('#join-workspace'), async form => {
  const id = formValue(form, 'workspace_id').trim();
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error(t('failed'));
  await api(`/api/workspaces/${id}/invitations/accept`, 'POST', { token: formValue(form, 'token') });
  await loadWorkspaces(id); notice(t('saved'));
});
click('[data-view]', button => show(button.dataset.view));
$('#workspace').addEventListener('change', async () => { state.filter = {}; try { await loadWorkspace(); } catch (error) { notice(error.message, true); } });
$('#search').addEventListener('keydown', async event => {
  if (event.key !== 'Enter' || !state.workspace) return;
  try {
    const result = await api(workspacePath(`/search?q=${encodeURIComponent(event.target.value)}`));
    $('#detail').hidden = true; $('#filters').hidden = true; $('#content').hidden = false; $('#page-title').textContent = t('search');
    $('#content').innerHTML = `<h2>${t('issues')}</h2><ul class="plain-list">${(result.issues || []).map(issue => `<li><button class="secondary" data-issue="${issue.id}">#${issue.number} ${escape(issue.title)}</button></li>`).join('')}</ul><h2>${t('members')}</h2><ul class="plain-list">${(result.members || result.people || []).map(profile => `<li>${escape(profile.display_name)} · ${escape(profile.email)}<p class="profile-contact">${escape(profile.contact)}</p><p class="muted">${state.workspace.teams.filter(team => team.members.includes(profile.id)).map(team => escape(team.name)).join(', ')}</p></li>`).join('')}</ul>`;
    click('[data-issue]', button => issueDetail(button.dataset.issue));
  } catch (error) { notice(error.message, true); }
});
(async () => {
  preferences();
  try { await session(await api('/api/me')); }
  catch (error) { if (error.status === 401) signedOut(); else { signedOut(); notice(error.message, true); } }
})();
