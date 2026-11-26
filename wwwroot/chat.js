'use strict';
const $ = id => document.getElementById(id);
const fragment = new URLSearchParams(location.hash.slice(1));
let token = fragment.get('key') || sessionStorage.getItem('chatKey');
if (fragment.has('key')) {
  history.replaceState(null, '', location.pathname);
}
let connected = false;
let sid = null;
let retryAttempt = null;
let correctionTarget = null;
let correctionOpening = 0;
let learningRequest = 0;
let evaluationRequest = 0;
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
let models = {};
let selection = null;
let selecting = false;
let modelRevision = 0;
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
function showStatus(text) {
  if ($('status').textContent !== text) $('status').textContent = text;
}
function elapsedText(value) {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - value));
  return seconds < 60 ? seconds + ' 秒' : Math.floor(seconds / 60) + ' 分 ' + (seconds % 60) + ' 秒';
}
function draftNotice(text) { $('draft-status').textContent = text; }
function showModel(selected, refresh = false) {
  const limits = models[selected?.id];
  if (!limits || (!refresh && selection?.id === selected.id && selection.batch === selected.batch)) return;
  selection = selected;
  const control = $('model-select');
  const options = Object.entries(models).map(([id, model]) => {
    const unavailable = model.available === false;
    const option = element('option', model.label + (unavailable ? '（權重未就緒）' : ''));
    option.value = id;
    option.disabled = unavailable;
    return option;
  });
  if (selected.batch) {
    const option = element('option', limits.label + ' · LoRA ' + selected.batch.slice(0, 8));
    option.value = 'active-lora';
    options.push(option);
  }
  control.replaceChildren(...options);
  control.value = selected.batch ? 'active-lora' : selected.id;
  const format = value => value.toLocaleString('zh-TW');
  const quota = [`輸入 ≤ ${format(limits.input_tokens)}`, `回覆 ≤ ${format(limits.output_tokens)}`];
  if (limits.context_tokens) quota.unshift(`上下文 ${format(limits.context_tokens)}`);
  $('model-quota').textContent = quota.join(' · ') + ' tokens／輪';
  $('model-quota').title = '輸入額度含系統提示與帶入的對話。本機模型無服務商的每日訊息額度。';
}
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
  const inProgress = pending || preparingDraft || switching || selecting || Boolean(job && job.running);
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
  $('chat-power').disabled = $('training-power').disabled = !connected || switching || mode === 'stopping';
  $('model-select').disabled = !connected || !selection || inProgress || mode === 'stopping';
  $('force-off').hidden = mode !== 'stopping' || switching || !connected;
  $('mode-status').textContent = !connected ? '桌面連線未就緒' : switching ?
    (requestedMode === 'off' ? '正在強制關閉…' : '正在切換…') :
    {off: '使用模型與訓練已關閉', chat: '使用模型已開啟 · 可送出訊息',
      training: '訓練已開啟 · 可安排微調', stopping: '正在確認模型程序退出'}[mode] || '';
  $('stop').hidden = !inProgress;
  const timer = $('stage-time');
  timer.hidden = !(job?.running && job.kind === 'chat' &&
    Number.isFinite(job.stage_started_at) && Number.isFinite(job.started_at));
  if (!timer.hidden) {
    const load = job.stage === 'chat_loading' && Number.isInteger(job.load_percent) &&
      job.load_percent >= 0 && job.load_percent <= 100 ? `權重載入 ${job.load_percent}% · ` : '';
    timer.textContent = load + '本階段 ' + elapsedText(job.stage_started_at) + ' · 本輪共 ' + elapsedText(job.started_at);
  } else {
    timer.textContent = '';
  }
  $('stop-learning').hidden = !(job?.running && job.kind === 'learning');
  $('start-learning').disabled = !connected || inProgress || mode !== 'training';
}
function timingNotes(timing) {
  if (!timing) return [];
  const seconds = milliseconds => milliseconds < 100 ? '少於 0.1 秒' :
    (milliseconds / 1000).toLocaleString('zh-TW', {maximumFractionDigits: 1}) + ' 秒';
  const notes = ['本輪耗時 ' + seconds(timing.total_ms), ...timing.stages.map(phase => {
    const label = (stages[phase.stage] || phase.stage).replace(/^正在/, '');
    return label + ' · ' + seconds(phase.elapsed_ms);
  })];
  if (timing.inference) {
    notes.push('模型實測 · 處理輸入 ' + seconds(timing.inference.input_ms) +
      ' · 生成回覆 ' + seconds(timing.inference.generation_ms));
  }
  return notes;
}
function messageNode(row, sourceSid, retry = null) {
  const article = element('article', undefined, 'message ' + row.role);
  const name = row.role === 'user' ? '你' : '助理';
  const label = row.source?.label ? name + ' · ' + row.source.label : name;
  const notes = [row.source?.detail].filter(Boolean);
  if (row.source?.usage) {
    const {input_tokens, output_tokens, model_calls} = row.source.usage;
    const input = input_tokens.toLocaleString('zh-TW');
    const output = output_tokens.toLocaleString('zh-TW');
    notes.push(`本輪用量 · 輸入 ${input} tokens · 回覆 ${output} tokens`);
    if (model_calls > 1) notes.push('模型呼叫 ' + model_calls + ' 次');
  }
  notes.push(...timingNotes(row.source?.timing));
  if (notes.length) {
    const source = element('details', undefined, 'message-source');
    source.append(element('summary', label, 'speaker'), element('div', notes.join('\n'), 'source-detail'));
    article.append(source);
  } else {
    article.append(element('div', label, 'speaker'));
  }
  article.append(element('p', row.content));
  if (retry && row.role === 'user' && row.id === retry.user_message_id) {
    const reason = retry.feedback_changed ? '本輪帶入的更正已撤回或改版' :
      {cancelled: '回答已停止', interrupted: '回答曾中斷', failed: '回答未完成'}[retry.status];
    article.append(element('small', reason + ' · 可重試', 'message-state'));
    if (retry.timing) {
      const timing = element('details', undefined, 'message-source');
      timing.append(element('summary', '查看本輪耗時', 'speaker'),
        element('div', [retry.source, ...timingNotes(retry.timing)].filter(Boolean).join('\n'), 'source-detail'));
      article.append(timing);
    }
  }
  if (row.correctable) {
    article.append(action('更正這則回答', () => openCorrection(sourceSid, row.id)));
  }
  return article;
}
function correctionState(state) {
  return {new: '尚未確認更正', ready: '已確認', withdrawn: '已撤回', needs_review: '來源已變更'}[state] || state;
}
function readCorrection(target) {
  return api('correction?' + new URLSearchParams({sid:target.sid, message_id:target.message_id}));
}
async function openCorrection(sourceSid, id) {
  const opening = ++correctionOpening;
  const target = {sid: sourceSid, message_id: id};
  try {
    const saved = await readCorrection(target);
    if (opening !== correctionOpening || sid !== sourceSid || viewLoading) return;
    correctionTarget = {...target, version:saved.version};
    $('correct-question').value = saved.prompt;
    $('correct-answer').value = saved.answer;
    const state = saved.state === 'withdrawn' && saved.can_withdraw ? 'training-only' : saved.state;
    $('correction-status').textContent = {
      'training-only': '已移出訓練佇列，這筆更正仍會用於後續聊天。',
      withdrawn: '這筆更正已撤回。再次確認後才會生效。',
      needs_review: '更正來源已有變更，請核對目前內容。'
    }[state] || '';
    $('correction-review').hidden = $('correction-refresh').hidden = true;
    $('confirm-correction').disabled = false;
    $('withdraw-correction').hidden = !saved.can_withdraw;
    $('withdraw-correction').disabled = false;
    $('correction-dialog').showModal();
  } catch (error) {
    if (opening === correctionOpening && sid === sourceSid) showStatus(error.message);
  }
}
async function load(targetSid = sid, confirmed = null) {
  if (preparingDraft) return;
  const revision = ++viewRevision;
  const powerAtRequest = powerRevision;
  const modelAtRequest = modelRevision;
  viewLoading = true;
  olderLoading = false;
  busyState();
  try {
    if (!(await flushDraft()) || revision !== viewRevision) return;
    const state = await api('view' + (targetSid ? '?sid=' + encodeURIComponent(targetSid) : ''));
    if (revision !== viewRevision) return;
    connected = true;
    const justSubmitted = confirmed && draftSubmission === confirmed && state.sid === confirmed.sid;
    if (justSubmitted) draftSubmission = null;
    showView(state, powerAtRequest, modelAtRequest);
    if (justSubmitted && !state.draft.content) draftNotice('訊息已送出');
  } catch (error) {
    if (revision === viewRevision) throw error;
  } finally {
    if (revision === viewRevision) {
      viewLoading = false;
      busyState();
    }
  }
}
function showView(state, powerAtRequest, modelAtRequest) {
  sid = state.sid;
  retryAttempt = state.retry;
  acknowledgeDraft(draftSubmission?.sid === sid ? draftSubmission.snapshot : state.draft);
  historyCursor = state.before;
  if (!switching && powerAtRequest === powerRevision) mode = state.mode;
  models = state.models || {};
  if (!selecting && modelAtRequest === modelRevision) showModel(state.selection, true);
  busyState();
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
  $('messages').replaceChildren(...state.messages.map(row => messageNode(row, state.sid, retryAttempt)));
  $('history').scrollTop = $('history').scrollHeight;
  $('retry').hidden = !retryAttempt;
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
  prepared: '尚未開始', queued: '等待本機程序', answering: '本機模型正在回答',
  chat_context: '正在整理對話與輸入',
  chat_checking: '正在核對模型設定與本機資源',
  chat_launch: '正在啟動本機推理程序',
  chat_runtime: '正在初始化推理環境',
  chat_assets: '正在核對模型權重檔案',
  chat_tokenizing: '正在套用提示格式並計算 token',
  chat_loading: '正在將模型載入 RAM 與顯存',
  chat_prefill: '正在處理輸入並建立快取',
  chat_generating: '正在逐步生成回覆',
  chat_completing: '正在處理輸入與生成回覆',
  chat_finalizing: '正在檢查並保存回覆',
  waiting: '等候電腦連續閒置 10 分鐘', baseline: '正在量測微調前的回答',
  training: '正在本機微調 LoRA', converting: '正在轉成 GGUF',
  checking: '正在重載並驗收', validated: '候選已通過驗收',
  needs_chat_validation: '待依目前聊天設定驗收',
  source_changed: '確認更正已撤回或改版', candidate_unavailable: '適配器資料無法核對',
  rejected: '候選未通過保留題或控制題', already_correct: '底座已答對保留題',
  stale: '確認更正已變更', done: '已完成', failed: '本次未完成', cancelled: '已停止', interrupted: '已中斷'
};
const interruptedStages = {
  waiting: '閒置等待', baseline: '基準測試', training: 'LoRA 微調', converting: '格式轉換', checking: '重載驗收'
};
async function poll() {
  const powerAtRequest = powerRevision;
  const modelAtRequest = modelRevision;
  try {
    job = await api('status');
    if (!switching && powerAtRequest === powerRevision) mode = job.mode;
    if (!selecting && modelAtRequest === modelRevision) showModel(job.selection);
    const state = job.running && job.draft_submitted === false ? '正在整理輸入與對話背景' :
      (job.stage ? stages[job.stage] || job.stage : '');
    const submitted = !viewLoading && job.id === draftSubmission?.id ? draftSubmission : null;
    let refreshed = false;
    if (submitted && job.draft_submitted === true) {
      if (sid === submitted.sid) {
        await load(submitted.sid, submitted);
        refreshed = draftSubmission !== submitted;
      } else {
        draftSubmission = null;
      }
    } else if (submitted && !job.running) {
      draftSubmission = null;
      if (sid === submitted.sid) {
        try {
          const saved = await api('draft?sid=' + encodeURIComponent(sid));
          if (sid === submitted.sid && !viewLoading) {
            if (saved.revision !== submitted.snapshot.revision) {
              flagDraftError(Object.assign(new Error('本次草稿未確認送出，請先核對並選擇要保留的版本。'), {status:409}));
            } else {
              draftNotice('訊息尚未送出，草稿已保存');
            }
          }
        } catch (error) { flagDraftError(error); }
      }
    }
    if (job.id && (job.running || lastJob !== job.id || submitted)) {
      const lastPhase = !job.running && job.kind === 'chat' && ['failed', 'cancelled'].includes(job.stage)
        ? stages[job.last_active_stage] : null;
      const notice = [state, lastPhase ? '最後階段 ' + lastPhase : null, job.error].filter(Boolean).join(' · ');
      showStatus(notice);
      if (job.kind === 'learning') $('learning-status').textContent = notice;
      if (!job.running) {
        lastJob = job.id;
        if (!viewLoading && !refreshed) await load();
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
    if (route === 'retry' && error.status === 409 && sid === data.sid && !viewLoading) {
      await load(data.sid).catch(() => {});
    }
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
  const expectedModel = selection;
  preparingDraft = true;
  busyState();
  try {
    if (!(await flushDraft()) || sid !== sourceSid || viewLoading) return;
    const snapshot = draftBase;
    const accepted = await start('ask', {sid: sourceSid, question, draft_revision: snapshot.revision,
      expected_model: expectedModel});
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
$('retry').addEventListener('click', () => {
  if (retryAttempt) start('retry', {sid, expected_run_id: retryAttempt.id, expected_model: selection});
});
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
async function saveCorrection(route, details, notice) {
  const target = correctionTarget;
  const confirm = $('confirm-correction');
  const withdraw = $('withdraw-correction');
  if (!target?.version || confirm.disabled) return;
  confirm.disabled = withdraw.disabled = true;
  try {
    await api(route, {...target, ...details});
    if (target === correctionTarget) $('correction-dialog').close();
    showStatus(notice);
    await load();
  } catch (error) {
    if (target !== correctionTarget) return;
    if (error.status === 409) {
      correctionTarget.version = null;
      $('correction-refresh').hidden = false;
      $('correction-review').hidden = true;
    }
    $('correction-status').textContent = error.message;
  } finally {
    if (target === correctionTarget) confirm.disabled = withdraw.disabled = !target.version;
  }
}
$('correction-form').addEventListener('submit', event => {
  event.preventDefault();
  saveCorrection('confirm', {prompt: $('correct-question').value.trim(), answer: $('correct-answer').value.trim()},
    '確認更正已加入本機學習佇列。');
});
$('withdraw-correction').addEventListener('click', () => {
  saveCorrection('withdraw-correction', {}, '已從後續聊天及微調撤回這筆更正。');
});
$('correction-refresh').addEventListener('click', async () => {
  const target = correctionTarget;
  const button = $('correction-refresh');
  button.disabled = true;
  try {
    const saved = await readCorrection(target);
    if (target !== correctionTarget || !$('correction-dialog').open) return;
    $('correction-saved').textContent = [correctionState(saved.state), saved.prompt, saved.answer].join('\n\n');
    $('correction-review').hidden = false;
    $('correction-review').open = true;
    $('correction-status').textContent = '請比較本機版本與目前輸入。按確認才會保存目前輸入。';
    target.version = saved.version;
    $('confirm-correction').disabled = false;
    $('withdraw-correction').hidden = !saved.can_withdraw;
    $('withdraw-correction').disabled = false;
  } catch (error) {
    $('correction-status').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
async function learningData() {
  const request = ++learningRequest;
  const state = await api('learning');
  if (request !== learningRequest) return;
  const selected = new Map([...$('examples').querySelectorAll(':checked')]
    .map(node => [node.value, node.dataset.revision]));
  let kept = 0;
  const examples = state.examples.map(row => {
    const line = element('div', undefined, 'example');
    const label = element('label', row.prompt);
    const box = element('input');
    box.type = 'checkbox';
    box.value = row.id;
    box.dataset.revision = row.revision;
    box.checked = selected.get(row.id) === box.dataset.revision;
    if (box.checked) kept++;
    label.prepend(box);
    label.append(element('small', '已確認 · 版本 ' + row.revision));
    line.append(label, action('移出訓練佇列', async () => {
      try { await api('withdraw', {id: row.id, revision: row.revision}); await learningData(); }
      catch (error) { $('learning-status').textContent = error.message; }
    }, 'withdraw'));
    return line;
  });
  $('examples').replaceChildren(...(examples.length ? examples : [element('p', '可在聊天回答下方確認更正。')]));
  if (kept < selected.size) $('learning-status').textContent = '已改版或撤回的例子已取消選取。請重新核對。';
  const candidates = state.jobs.map(row => {
    const line = element('div', undefined, 'candidate');
    const phase = row.status === 'interrupted' ? interruptedStages[row.interrupted_stage] : '';
    const label = [row.id === state.active ? '目前選用' : null,
      phase ? phase + '時中斷' : (stages[row.status] || row.status), row.id.slice(0, 8)];
    line.append(element('span', label.filter(Boolean).join(' · ')));
    if (row.status === 'rejected' && row.error) line.append(element('small', row.error));
    const buttons = element('div', undefined, 'candidate-actions');
    buttons.append(action('驗收明細', () => openEvaluation(row.id)));
    if (row.status === 'validated' && row.id !== state.active) {
      buttons.append(action('選用', () => selectVersion(row.id)));
    }
    line.append(buttons);
    return line;
  });
  if (state.active) candidates.unshift(action('改用原始 BF16 底座', () => selectVersion(null)));
  $('candidates').replaceChildren(...candidates);
}
function evaluationResult(result) {
  if (!result) return '尚無紀錄';
  return (result.matches ? '答對' : '未答對') + (result.model_calls === 0 ? '（未呼叫模型）' : '');
}
function evaluationCase(row) {
  const kind = {holdout: '未見題', control: '舊技能對照', example: '確認更正'}[row.kind];
  const label = kind + (row.kind === 'example' ? ' · 版本 ' + row.revision : '');
  const entry = element('details', undefined, 'evaluation-case');
  entry.append(element('summary', [label, '底座 ' + evaluationResult(row.baseline),
    '重載後 ' + evaluationResult(row.candidate)].join(' · ')));
  entry.append(element('h3', '題目'), element('p', row.question), element('h3', '預期答案'), element('p', row.expected));
  for (const [name, result] of [['底座回覆', row.baseline], ['重載後回覆', row.candidate]]) {
    entry.append(element('h3', name), element('p', result?.answer ?? '尚無紀錄'));
    if (result) entry.append(element('small', result.model_calls == null ? '模型呼叫數未記錄' : '模型呼叫 ' + result.model_calls + ' 次'));
  }
  return entry;
}
async function openEvaluation(id) {
  const request = ++evaluationRequest;
  const dialog = $('evaluation-dialog');
  $('evaluation-title').textContent = '驗收明細 · ' + id.slice(0, 8);
  $('evaluation-status').textContent = '正在讀取本機紀錄…';
  $('evaluation-cases').replaceChildren();
  if (!dialog.open) dialog.showModal();
  try {
    const detail = await api('learning?' + new URLSearchParams({job:id}));
    if (request !== evaluationRequest || !dialog.open) return;
    if (detail.id !== id) throw new Error('驗收批次不符。');
    $('evaluation-cases').replaceChildren(...detail.cases.map(evaluationCase));
    $('evaluation-status').textContent = '';
  } catch (error) {
    if (request === evaluationRequest && dialog.open) $('evaluation-status').textContent = error.message;
  }
}
async function selectVersion(id) {
  try {
    if (!(await changeModel({id}))) return;
    await learningData();
    $('learning-status').textContent = '已儲存模型選擇。';
  } catch (error) {
    if ($('learning-dialog').open) await learningData().catch(() => {});
    $('learning-status').textContent = error.message;
  }
}
async function changeModel(body) {
  if (!connected || selecting || switching || pending || preparingDraft || job?.running || mode === 'stopping') return false;
  modelRevision++;
  selecting = true;
  busyState();
  try {
    const state = await api('select', body);
    showModel(state.selection);
    return true;
  } finally {
    selecting = false;
    modelRevision++;
    $('model-select').value = selection?.batch ? 'active-lora' : selection?.id || '';
    busyState();
  }
}
$('model-select').addEventListener('change', async event => {
  const selected = event.target.value;
  if (!models[selected]) return;
  try {
    if (await changeModel({model: selected})) showStatus('已儲存聊天模型。');
  } catch (error) { showStatus(error.message); }
});
$('learning').addEventListener('click', async () => {
  $('learning-dialog').showModal();
  try { await learningData(); }
  catch (error) { $('learning-status').textContent = error.message; }
});
$('refresh-learning').addEventListener('click', () => learningData().catch(error => {
  $('learning-status').textContent = error.message;
}));
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
  if (requested === 'off' || job?.running) showStatus('正在強制停止本機模型程序…');
  try {
    mode = (await api('mode', {mode: requested})).mode;
    showStatus({off: '模型與訓練已關閉', chat: '可開始本機對話', training: '可安排閒置微調'}[mode]);
  } catch (error) {
    try {
      const current = await api('status');
      mode = current.mode;
    } catch {}
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
$('force-off').addEventListener('click', () => changePower('off'));
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
