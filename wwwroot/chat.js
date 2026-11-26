'use strict';
const $ = id => document.getElementById(id);
const fragment = new URLSearchParams(location.hash.slice(1));
let token = fragment.get('key') || sessionStorage.getItem('chatKey');
if (fragment.has('key')) {
  history.replaceState(null, '', location.pathname);
}
let connected = false;
let sid = null;
let correctionTarget = null;
let viewRevision = 0;
let viewLoading = false;
let historyCursor = null;
let olderLoading = false;
let job = null;
let lastJob = null;
let pending = false;
let mode = 'off';
let switching = false;
let requestedMode = null;
let powerRevision = 0;
let draftBase = null;
let draftTimer = null;
let draftWrite = null;
let draftConflict = false;
let draftReview = null;
let draftSubmission = null;
let preparingDraft = false;

async function api(route, data) {
  const headers = token ? {Authorization: 'Bearer ' + token} : {};
  const options = {headers};
  if (data !== undefined) {
    headers['Content-Type'] = 'application/json';
    Object.assign(options, {method: 'POST', body: JSON.stringify(data)});
  }
  const response = await fetch('/api/' + route, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) {
      connected = false;
      $('connect-notice').textContent = '此分頁尚未連線。請從桌面「個人助理對話」開啟一次。';
      busyState();
    }
    const error = new Error(payload.error || ('本機網站回報 HTTP ' + response.status + '。'));
    error.status = response.status;
    throw error;
  }
  return payload;
}
function element(tag, text, css) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (css) node.className = css;
  return node;
}
function action(text, fn, css) {
  const button = element('button', text, css);
  button.type = 'button';
  button.addEventListener('click', fn);
  return button;
}
function showStatus(text) { $('status').textContent = text; }
function draftNotice(text) { $('draft-status').textContent = text; }
function hasDraftEdit() { return draftBase && $('question').value !== draftBase.content; }
function acknowledgeDraft(snapshot) {
  draftBase = snapshot;
  draftConflict = false;
  $('question').value = snapshot.content;
  draftNotice(snapshot.content ? '草稿已存本機' : '');
}
function flagDraftError(error) {
  if (error.status === 409) draftConflict = true;
  draftNotice(error.message);
  busyState();
}
function queueDraft() {
  clearTimeout(draftTimer);
  if (!draftConflict && hasDraftEdit()) {
    draftNotice('草稿尚未保存…');
    draftTimer = setTimeout(() => flushDraft(), 350);
  }
}
async function flushDraft() {
  clearTimeout(draftTimer);
  while (draftWrite) {
    if (!(await draftWrite)) return false;
  }
  if (draftConflict) return false;
  if (!hasDraftEdit()) return true;
  if (!connected || !sid) return false;
  const text = $('question').value;
  draftWrite = (async () => {
    try {
      draftBase = await api('draft', {sid, revision: draftBase.revision, content: text});
      draftNotice(text ? '草稿已存本機' : '');
      return true;
    } catch (error) {
      flagDraftError(error);
      return false;
    } finally {
      draftWrite = null;
    }
  })();
  if (!(await draftWrite)) return false;
  if (hasDraftEdit()) {
    if (viewLoading || preparingDraft) return flushDraft();
    queueDraft();
    return false;
  }
  return true;
}
function busyState() {
  const inProgress = pending || preparingDraft || switching || Boolean(job && job.running);
  $('connect-notice').hidden = connected;
  $('send').disabled = !connected || inProgress || viewLoading || draftConflict || mode !== 'chat';
  $('retry').disabled = !connected || inProgress || viewLoading || mode !== 'chat';
  $('question').readOnly = !connected || viewLoading || preparingDraft || draftSubmission?.sid === sid;
  $('draft-review').hidden = !draftConflict;
  $('draft-review').disabled = !connected || viewLoading || preparingDraft || draftSubmission?.sid === sid;
  $('new-chat').disabled = !connected || inProgress;
  $('trash-current').disabled = !connected || inProgress || viewLoading;
  $('trash-list').disabled = $('learning').disabled = !connected;
  $('older-messages').hidden = !historyCursor;
  $('older-messages').disabled = !connected || viewLoading || olderLoading;
  const shownMode = requestedMode ?? mode;
  $('chat-power').checked = shownMode === 'chat';
  $('training-power').checked = shownMode === 'training';
  $('chat-power').disabled = $('training-power').disabled = !connected || switching;
  $('mode-status').textContent = !connected ? '桌面連線未就緒' : switching ? '正在切換…' :
    {off: '使用模型與訓練已關閉', chat: '使用模型已開啟 · 可送出訊息',
      training: '訓練已開啟 · 可安排微調', stopping: '正在確認模型程序退出'}[mode] || '';
  $('stop').hidden = !inProgress;
  $('stop-learning').hidden = !(job?.running && job.kind === 'learning');
  $('start-learning').disabled = !connected || inProgress || mode !== 'training';
}
function messageNode(row, sourceSid) {
  const article = element('article', undefined, 'message ' + row.role);
  article.append(element('div', row.role === 'user' ? '你' : '助理', 'speaker'));
  article.append(element('p', row.content));
  if (row.correctable) {
    article.append(action('更正這則回答', () => {
      correctionTarget = {sid: sourceSid, message_id: row.id};
      $('correct-question').value = row.question;
      $('correct-answer').value = row.correction || '';
      $('correction-status').textContent = '';
      $('correction-dialog').showModal();
    }));
  }
  return article;
}
async function load(targetSid = sid) {
  if (preparingDraft) return;
  const revision = ++viewRevision;
  const powerAtRequest = powerRevision;
  viewLoading = true;
  olderLoading = false;
  busyState();
  try {
    if (!(await flushDraft()) || revision !== viewRevision) return;
    const state = await api('view' + (targetSid ? '?sid=' + encodeURIComponent(targetSid) : ''));
    if (revision !== viewRevision) return;
    connected = true;
    showView(state, powerAtRequest);
  } catch (error) {
    if (revision === viewRevision) throw error;
  } finally {
    if (revision === viewRevision) {
      viewLoading = false;
      busyState();
    }
  }
}
function showView(state, powerAtRequest) {
  sid = state.sid;
  acknowledgeDraft(draftSubmission?.sid === sid ? draftSubmission.snapshot : state.draft);
  historyCursor = state.before;
  if (!switching && powerAtRequest === powerRevision) mode = state.mode;
  busyState();
  $('model').textContent = state.model;
  if (state.warning) showStatus(state.warning);
  $('title').textContent = state.title;
  $('sessions').replaceChildren(...state.sessions.map(row => {
    const button = action(row.title, async () => {
      $('sidebar').classList.remove('open');
      await load(row.id).catch(error => showStatus(error.message));
    }, 'session');
    button.setAttribute('aria-current', String(row.id === sid));
    button.title = row.title;
    return button;
  }));
  $('messages').replaceChildren(...state.messages.map(row => messageNode(row, state.sid)));
  $('history').scrollTop = $('history').scrollHeight;
  $('retry').hidden = !state.can_retry;
}
$('older-messages').addEventListener('click', async () => {
  if (viewLoading || olderLoading || !historyCursor) return;
  const revision = viewRevision;
  const sourceSid = sid;
  const query = new URLSearchParams({sid: sourceSid, before: historyCursor});
  olderLoading = true;
  busyState();
  try {
    const page = await api('view?' + query);
    if (revision !== viewRevision) return;
    if (page.sid !== sourceSid) throw new Error('這段歷史的來源已變更，請重開對話。');
    const panel = $('history');
    const oldHeight = panel.scrollHeight;
    const oldPosition = panel.scrollTop;
    $('messages').prepend(...page.messages.map(row => messageNode(row, sourceSid)));
    historyCursor = page.before;
    busyState();
    panel.scrollTop = oldPosition + panel.scrollHeight - oldHeight;
  } catch (error) {
    if (revision === viewRevision) showStatus(error.message);
  } finally {
    if (revision === viewRevision) {
      olderLoading = false;
      busyState();
      if (!historyCursor) $('history').focus();
    }
  }
});
const stages = {
  queued: '等待本機程序', answering: '本機模型正在回答',
  waiting: '等候電腦連續閒置 10 分鐘', baseline: '正在量測微調前的回答',
  training: '正在本機微調 LoRA', converting: '正在轉成 GGUF',
  checking: '正在重載並驗收', validated: '候選已通過驗收',
  rejected: '候選未通過保留題或控制題', already_correct: '底座已答對保留題',
  stale: '確認更正已變更', done: '已完成', failed: '本次未完成', cancelled: '已停止'
};
async function poll() {
  const powerAtRequest = powerRevision;
  try {
    job = await api('status');
    if (!switching && powerAtRequest === powerRevision) mode = job.mode;
    const state = job.stage ? stages[job.stage] || job.stage : '';
    const finishedDraft = !viewLoading && draftSubmission && !job.running && job.id === draftSubmission.id ? draftSubmission : null;
    if (finishedDraft) {
      draftSubmission = null;
      if (sid === finishedDraft.sid && !viewLoading) {
        if (job.draft_submitted === true) {
          acknowledgeDraft({revision: finishedDraft.snapshot.revision + 1, content: ''});
        } else {
          try {
            const saved = await api('draft?sid=' + encodeURIComponent(sid));
            if (sid === finishedDraft.sid && !viewLoading && saved.revision !== finishedDraft.snapshot.revision) {
              flagDraftError(Object.assign(new Error('本次草稿未確認送出，請先核對並選擇要保留的版本。'), {status:409}));
            }
          } catch (error) { flagDraftError(error); }
        }
      }
    }
    if (job.id && (job.running || lastJob !== job.id || finishedDraft)) {
      const notice = [state, job.error].filter(Boolean).join(' · ');
      showStatus(notice);
      if (job.kind === 'learning') $('learning-status').textContent = notice;
      if (!job.running) {
        lastJob = job.id;
        if (!viewLoading) await load();
        if ($('learning-dialog').open) await learningData();
      }
    }
    busyState();
  } catch (error) {
    showStatus(error.message);
  } finally {
    if (connected) setTimeout(poll, 900);
  }
}
async function start(route, data) {
  pending = true;
  busyState();
  try {
    job = await api(route, data);
    showStatus(stages[job.stage] || '');
    return job;
  } catch (error) {
    if (route === 'ask' && error.status === 409) flagDraftError(error);
    showStatus(error.message);
    return false;
  } finally {
    pending = false;
    busyState();
  }
}
$('chat-form').addEventListener('submit', async event => {
  event.preventDefault();
  const question = $('question').value.trim();
  if (!connected || !question || pending || preparingDraft || draftConflict || viewLoading || job?.running || mode !== 'chat') return;
  if ([...question].length > 16000) {
    draftNotice('訊息最多 16000 字，請先縮短。');
    return;
  }
  const sourceSid = sid;
  preparingDraft = true;
  busyState();
  try {
    if (!(await flushDraft()) || sid !== sourceSid || viewLoading) return;
    const snapshot = draftBase;
    const accepted = await start('ask', {sid: sourceSid, question, draft_revision: snapshot.revision});
    if (accepted) {
      draftSubmission = {id: accepted.id, sid: sourceSid, snapshot};
      if (sid === sourceSid) draftNotice('正在等候送出確認…');
    }
  } finally {
    preparingDraft = false;
    busyState();
  }
});
$('question').addEventListener('input', queueDraft);
$('draft-review').addEventListener('click', async () => {
  const sourceSid = sid;
  try {
    const saved = await api('draft?sid=' + encodeURIComponent(sourceSid));
    if (sourceSid !== sid || viewLoading || preparingDraft) return;
    draftReview = {sid: sourceSid, editor: $('question').value, saved};
    $('draft-editor-copy').value = draftReview.editor;
    $('draft-saved-copy').value = saved.content;
    $('draft-review-status').textContent = '';
    $('draft-dialog').showModal();
  } catch (error) { flagDraftError(error); }
});
async function resolveDraft(keepEditor) {
  const review = draftReview;
  if (!review || review.sid !== sid || review.editor !== $('question').value) return;
  $('draft-use-saved').disabled = $('draft-keep-editor').disabled = true;
  try {
    const snapshot = keepEditor
      ? await api('draft', {sid, revision: review.saved.revision, content: review.editor})
      : await api('draft?sid=' + encodeURIComponent(sid));
    if (!keepEditor && snapshot.revision !== review.saved.revision) {
      throw new Error('本機版本已再次變更，請關閉後重新核對。');
    }
    if (review.sid === sid && review.editor === $('question').value) {
      acknowledgeDraft(snapshot);
      $('draft-dialog').close();
      busyState();
    }
  } catch (error) {
    $('draft-review-status').textContent = error.message;
  } finally {
    $('draft-use-saved').disabled = $('draft-keep-editor').disabled = false;
  }
}
$('draft-use-saved').addEventListener('click', () => resolveDraft(false));
$('draft-keep-editor').addEventListener('click', () => resolveDraft(true));
window.addEventListener('beforeunload', event => {
  if (hasDraftEdit() || draftConflict) {
    event.preventDefault();
    event.returnValue = '';
  }
});
$('question').addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
    event.preventDefault();
    $('chat-form').requestSubmit();
  }
});
$('retry').addEventListener('click', () => start('retry', {sid}));
$('new-chat').addEventListener('click', async () => {
  try {
    if (!(await flushDraft())) return;
    const created = (await api('new', {})).sid;
    $('sidebar').classList.remove('open');
    await load(created);
    $('question').focus();
  } catch (error) { showStatus(error.message); }
});
async function stop() {
  try { await api('stop', {}); showStatus('正在等待本機程序結束'); }
  catch (error) { showStatus(error.message); }
}
$('stop').addEventListener('click', stop);
$('stop-learning').addEventListener('click', stop);
$('open-sidebar').addEventListener('click', () => $('sidebar').classList.toggle('open'));
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => $(button.dataset.close).close()));
$('correction-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    await api('confirm', {...correctionTarget, prompt: $('correct-question').value.trim(),
      answer: $('correct-answer').value.trim()});
    $('correction-dialog').close();
    showStatus('確認更正已加入本機學習佇列。');
    await load();
  } catch (error) {
    $('correction-status').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
async function learningData() {
  const state = await api('learning');
  const selected = new Set([...$('examples').querySelectorAll(':checked')].map(node => node.value));
  const examples = state.examples.map(row => {
    const line = element('div', undefined, 'example');
    const label = element('label', row.prompt);
    const box = element('input');
    box.type = 'checkbox';
    box.value = row.id;
    box.dataset.revision = row.revision;
    box.checked = selected.has(row.id);
    label.prepend(box);
    label.append(element('small', '已確認 · 版本 ' + row.revision));
    line.append(label, action('撤回', async () => {
      try { await api('withdraw', {id: row.id, revision: row.revision}); await learningData(); }
      catch (error) { $('learning-status').textContent = error.message; }
    }, 'withdraw'));
    return line;
  });
  $('examples').replaceChildren(...(examples.length ? examples : [element('p', '可在聊天回答下方確認更正。')]));
  const candidates = state.jobs.map(row => {
    const line = element('div', undefined, 'candidate');
    line.append(element('span', (stages[row.status] || row.status) + ' · ' + row.id.slice(0, 8)));
    if (row.status === 'validated' && row.id !== state.active) {
      line.append(action('選用', () => selectVersion(row.id)));
    }
    return line;
  });
  if (state.active) candidates.unshift(action('改用原始 BF16 底座', () => selectVersion(null)));
  $('candidates').replaceChildren(...candidates);
}
async function selectVersion(id) {
  try {
    await api('select', {id});
    await load();
    await learningData();
    $('learning-status').textContent = '已儲存模型選擇。';
  } catch (error) { $('learning-status').textContent = error.message; }
}
$('learning').addEventListener('click', async () => {
  $('learning-dialog').showModal();
  try { await learningData(); }
  catch (error) { $('learning-status').textContent = error.message; }
});
$('learning-form').addEventListener('submit', async event => {
  event.preventDefault();
  const selection = [...$('examples').querySelectorAll(':checked')]
    .map(node => ({id: node.value, revision: Number(node.dataset.revision)}));
  try {
    job = await api('learn', {selection, holdout: {prompt: $('holdout-question').value.trim(),
      answer: $('holdout-answer').value.trim()}});
    $('learning-status').textContent = stages[job.stage] || '';
    busyState();
  } catch (error) { $('learning-status').textContent = error.message; }
});
async function changePower(requested) {
  if (!connected || switching) return;
  powerRevision++;
  switching = true;
  requestedMode = requested;
  busyState();
  if (job?.running) showStatus('正在停止本機模型程序');
  try {
    mode = (await api('mode', {mode: requested})).mode;
    showStatus({off: '模型與訓練已關閉', chat: '可開始本機對話', training: '可安排閒置微調'}[mode]);
  } catch (error) {
    showStatus(error.message);
  } finally {
    powerRevision++;
    switching = false;
    requestedMode = null;
    busyState();
  }
}
$('chat-power').addEventListener('change', event => changePower(event.target.checked ? 'chat' : 'off'));
$('training-power').addEventListener('change', event => changePower(event.target.checked ? 'training' : 'off'));
$('trash-current').addEventListener('click', async () => {
  const sourceSid = sid;
  if (!sourceSid || viewLoading || !confirm('將目前對話移到回收筒？之後可以還原。')) return;
  try {
    if (!(await flushDraft()) || sid !== sourceSid || viewLoading) return;
    await api('trash', {sid: sourceSid});
    if (!viewLoading) await load(sid === sourceSid ? null : sid);
  }
  catch (error) { showStatus(error.message); }
});
async function loadTrash() {
  const history = await api('trash');
  const records = history.sessions.map(row => {
    const line = element('div', undefined, 'candidate');
    const buttons = element('div', undefined, 'dialog-actions');
    buttons.append(action('還原', () => editTrash('restore', row.id)));
    buttons.append(action('永久刪除', () => {
      if (confirm('永久刪除這段對話在主資料庫的聊天內容與回答紀錄？備份及另存資料需個別處理。')) {
        editTrash('purge', row.id);
      }
    }));
    line.append(element('span', row.title), buttons);
    return line;
  });
  $('trash-items').replaceChildren(...(records.length ? records : [element('p', '回收筒是空的。')]));
}
async function editTrash(route, id) {
  try {
    await api(route, {sid: id});
    $('trash-status').textContent = route === 'restore' ? '對話已還原' : '主資料庫的聊天內容已刪除';
    await loadTrash();
    await load();
  } catch (error) { $('trash-status').textContent = error.message; }
}
$('trash-list').addEventListener('click', async () => {
  $('trash-status').textContent = '';
  $('trash-dialog').showModal();
  try { await loadTrash(); }
  catch (error) { $('trash-status').textContent = error.message; }
});
busyState();
async function connectDesktop() {
  try {
    if (token) {
      await api('connect', {});
      sessionStorage.removeItem('chatKey');
      token = null;
    }
    await load();
    poll();
  } catch (error) {
    if (!connected) $('connect-notice').textContent = error.message;
  }
}
connectDesktop();
