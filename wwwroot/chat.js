'use strict';
const $ = id => document.getElementById(id);
const fragment = new URLSearchParams(location.hash.slice(1));
const token = fragment.get('key') || sessionStorage.getItem('chatKey');
if (fragment.has('key')) {
  sessionStorage.setItem('chatKey', token);
  history.replaceState(null, '', location.pathname);
}
let sid = null;
let correctionId = null;
let job = null;
let lastJob = null;
let pending = false;
let mode = 'off';
let switching = false;

async function api(route, data) {
  const headers = {Authorization: 'Bearer ' + token};
  const options = {headers};
  if (data !== undefined) {
    headers['Content-Type'] = 'application/json';
    Object.assign(options, {method: 'POST', body: JSON.stringify(data)});
  }
  const response = await fetch('/api/' + route, options);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || '本機助理未完成這次操作。');
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
function busyState() {
  const inProgress = pending || switching || Boolean(job && job.running);
  $('send').disabled = $('retry').disabled = inProgress || mode !== 'chat';
  $('trash-current').disabled = $('new-chat').disabled = inProgress;
  $('chat-power').checked = mode === 'chat';
  $('training-power').checked = mode === 'training';
  $('chat-power').disabled = $('training-power').disabled = switching;
  $('stop').hidden = !inProgress;
  $('stop-learning').hidden = !(job?.running && job.kind === 'learning');
  $('start-learning').disabled = inProgress || mode !== 'training';
}
function showMessage(row) {
  const article = element('article', undefined, 'message ' + row.role);
  article.append(element('div', row.role === 'user' ? '你' : '助理', 'speaker'));
  article.append(element('p', row.content));
  if (row.correctable) {
    article.append(action('更正這則回答', () => {
      correctionId = row.id;
      $('correct-question').value = row.question;
      $('correct-answer').value = row.correction || '';
      $('correction-status').textContent = '';
      $('correction-dialog').showModal();
    }));
  }
  $('history').append(article);
}
async function load() {
  const state = await api('view' + (sid ? '?sid=' + encodeURIComponent(sid) : ''));
  sid = state.sid;
  if (!switching) mode = state.mode;
  busyState();
  $('model').textContent = state.model;
  if (state.warning) showStatus(state.warning);
  $('title').textContent = state.title;
  $('sessions').replaceChildren(...state.sessions.map(row => {
    const button = action(row.title, async () => {
      sid = row.id;
      $('sidebar').classList.remove('open');
      await load().catch(error => showStatus(error.message));
    }, 'session');
    button.setAttribute('aria-current', String(row.id === sid));
    button.title = row.title;
    return button;
  }));
  $('history').replaceChildren();
  state.messages.forEach(showMessage);
  $('history').scrollTop = $('history').scrollHeight;
  $('retry').hidden = !state.can_retry;
}
const stages = {
  queued: '等待本機程序', answering: '本機模型正在回答',
  waiting: '等候電腦連續閒置 10 分鐘', baseline: '正在量測微調前的回答',
  training: '正在本機微調 LoRA', converting: '正在轉成 GGUF',
  checking: '正在重載並驗收', validated: '候選已通過驗收',
  rejected: '候選未通過保留題或控制題', already_correct: '底座已答對保留題',
  stale: '確認更正已變更', done: '已完成', failed: '本次未完成', cancelled: '已停止'
};
async function poll() {
  try {
    job = await api('status');
    if (!switching) mode = job.mode;
    const state = job.stage ? stages[job.stage] || job.stage : '';
    if (job.id && (job.running || lastJob !== job.id)) {
      const notice = [state, job.error].filter(Boolean).join(' · ');
      showStatus(notice);
      if (job.kind === 'learning') $('learning-status').textContent = notice;
      if (!job.running) {
        lastJob = job.id;
        await load();
        if ($('learning-dialog').open) await learningData();
      }
    }
    busyState();
  } catch (error) {
    showStatus(error.message);
  } finally {
    setTimeout(poll, 900);
  }
}
async function start(route, data) {
  pending = true;
  busyState();
  try {
    job = await api(route, data);
    showStatus(stages[job.stage] || '');
    return true;
  } catch (error) {
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
  if (!question || pending || job?.running || mode !== 'chat') return;
  if (await start('ask', {sid, question})) {
    $('question').value = '';
    showMessage({role: 'user', content: question});
    $('history').scrollTop = $('history').scrollHeight;
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
    sid = (await api('new', {})).sid;
    $('sidebar').classList.remove('open');
    await load();
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
    await api('confirm', {sid, message_id: correctionId, prompt: $('correct-question').value.trim(),
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
  if (switching) return;
  switching = true;
  busyState();
  if (job?.running) showStatus('正在停止本機模型程序');
  try {
    mode = (await api('mode', {mode: requested})).mode;
    showStatus({off: '模型與訓練已關閉', chat: '可開始本機對話', training: '可安排閒置微調'}[mode]);
  } catch (error) {
    showStatus(error.message);
  } finally {
    switching = false;
    busyState();
  }
}
$('chat-power').addEventListener('change', event => changePower(event.target.checked ? 'chat' : 'off'));
$('training-power').addEventListener('change', event => changePower(event.target.checked ? 'training' : 'off'));
$('trash-current').addEventListener('click', async () => {
  if (!sid || !confirm('將目前對話移到回收筒？之後可以還原。')) return;
  try { await api('trash', {sid}); sid = null; await load(); }
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
showStatus('模型與訓練已關閉');
busyState();
load().catch(error => showStatus(error.message));
poll();
