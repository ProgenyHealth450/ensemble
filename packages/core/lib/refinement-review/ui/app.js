/* Refinement Review SPA logic — talks to /api/* on the same-origin
   server. Authentication: the ?token=... query param is captured at
   load; every fetch() sends it as Authorization: Bearer <token>,
   and the EventSource URL appends ?token=... (header-based auth is
   unavailable on EventSource). */
(function () {
  'use strict';

  function $(id) {
    return document.getElementById(id);
  }

  function token() {
    const u = new URL(window.location.href);
    return u.searchParams.get('token') || '';
  }

  function authHeaders(extra) {
    const h = Object.assign({}, extra || {});
    h['Authorization'] = 'Bearer ' + token();
    return h;
  }

  /** In-memory model. { session, questionIndex, author, comments, lastError }. */
  const state = {
    session: null,
    documentMd: '',
    documentEtag: null,
    questionIndex: 0,
    author: '',
    lastError: null,
    pendingAnchor: null,
    saveInflight: false,
  };

  /** Renders the persisted session envelope into state and the page. */
  function setSession(envelope, opts) {
    state.session = envelope;
    state.lastError = null;
    renderDocument();
    renderQuestions();
    renderComments();
    renderInlineComments();
    renderMeta();
    if (opts && opts.bumpQuestionIndex) {
      // Keep the index on the user, but skip a deleted question.
      skipDeleted();
    }
  }

  function skipDeleted() {
    if (!state.session) return;
    const total = state.session.questions.length;
    while (state.questionIndex < total && currentQuestion().status === 'answered') {
      state.questionIndex++;
    }
  }

  function currentQuestion() {
    if (!state.session) return null;
    return state.session.questions[state.questionIndex];
  }

  function renderMeta() {
    if (!state.session) return;
    $('rr-document-kind').textContent = state.session.document.kind.toUpperCase();
    $('rr-revision').textContent = `rev ${state.session.revision}`;
    $('rr-status').textContent = state.session.completedAt ? 'completed' : 'live';
    document.title = `Refinement Review (${state.session.document.kind.toUpperCase()})`;
  }

  function renderDocument() {
    const body = $('rr-document');
    body.innerHTML = window.RRMarkdown.render(state.documentMd);
  }

  function renderQuestions() {
    if (!state.session) return;
    const total = state.session.questions.length;
    const q = currentQuestion();
    const wrap = $('rr-question');
    if (!q) {
      wrap.innerHTML = '<div class="rr-context">All questions answered.</div>';
      $('rr-question-progress').textContent = '0 / 0';
      $('rr-prev').disabled = true;
      $('rr-next').disabled = true;
      $('rr-skip').disabled = true;
      $('rr-save').disabled = true;
      return;
    }
    $('rr-question-progress').textContent = `${state.questionIndex + 1} / ${total}`;
    $('rr-prev').disabled = state.questionIndex === 0;
    $('rr-next').disabled = state.questionIndex === total - 1;
    const pill = `<span class="rr-status-pill ${q.status}">${q.status}</span>`;
    wrap.innerHTML = `
      ${pill}
      <div class="rr-prompt">${escapeHtml(q.prompt)}</div>
      ${q.context ? `<div class="rr-context">${escapeHtml(q.context)}</div>` : ''}
      <textarea id="rr-question-answer">${escapeHtml(q.answer || '')}</textarea>
    `;
  }

  function renderComments() {
    if (!state.session) return;
    const cs = state.session.comments;
    const root = $('rr-comments');
    if (cs.length === 0) {
      root.innerHTML = '<div class="rr-context">No comments yet.</div>';
      return;
    }
    root.innerHTML = cs
      .map((c) => {
        const anchor = c.anchor
          ? `<div class="rr-comment-anchor">line ${c.anchor.lineStart}${
              c.anchor.lineEnd && c.anchor.lineEnd !== c.anchor.lineStart
                ? '–' + c.anchor.lineEnd
                : ''
            }${c.anchor.section ? ' · ' + escapeHtml(c.anchor.section) : ''}${
              c.anchor.selectedText ? '<br>“' + escapeHtml(c.anchor.selectedText.slice(0, 120)) + '”' : ''
            }</div>`
          : '';
        return `
          <div class="rr-comment ${c.resolvedAt ? 'resolved' : ''}" data-comment-id="${c.id}">
            <div class="rr-comment-meta">${escapeHtml(c.author || 'unknown')} · ${formatDate(c.createdAt)}</div>
            <div class="rr-comment-body">${escapeHtml(c.body)}</div>
            ${anchor}
            <div class="rr-comment-actions">
              <button data-act="jump" data-id="${c.id}">Jump</button>
              <button data-act="toggle-resolved" data-id="${c.id}">${
                c.resolvedAt ? 'Reopen' : 'Resolve'
              }</button>
            </div>
          </div>
        `;
      })
      .join('');
  }

  function renderInlineComments() {
    if (!state.session) return;
    const root = $('rr-inline-comments');
    // Remove previously placed anchors.
    const doc = $('rr-document');
    doc.querySelectorAll('.rr-anchor-target').forEach((el) => {
      el.classList.remove('rr-anchor-target');
    });
    root.innerHTML = '';
    state.session.comments
      .filter((c) => c.anchor && c.anchor.lineStart)
      .forEach((c) => {
        const sel = `[data-source-line="${c.anchor.lineStart}"]`;
        const target = doc.querySelector(sel);
        if (!target) return;
        target.classList.add('rr-anchor-target');
        const div = document.createElement('div');
        div.className = 'rr-inline-comment' + (c.resolvedAt ? ' resolved' : '');
        div.innerHTML = `<strong>${escapeHtml(c.author || '?')}</strong>: ${escapeHtml(c.body)}`;
        target.insertAdjacentElement('afterend', div);
      });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatDate(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      return d.toLocaleString();
    } catch (_) {
      return iso;
    }
  }

  async function loadDocument() {
    const headers = authHeaders();
    if (state.documentEtag) headers['If-None-Match'] = `"${state.documentEtag}"`;
    const res = await fetch('/api/document', { headers });
    if (res.status === 304) return; // still current
    if (!res.ok) throw new Error('document load failed: ' + res.status);
    state.documentMd = await res.text();
    const etag = res.headers.get('etag') || '';
    state.documentEtag = etag.replace(/^"|"$/g, '');
    renderDocument();
  }

  async function loadSession() {
    const res = await fetch('/api/session', { headers: authHeaders() });
    if (!res.ok) throw new Error('session load failed: ' + res.status);
    const envelope = await res.json();
    setSession(envelope, { bumpQuestionIndex: true });
  }

  function showStale(currentRevision) {
    state.lastError = `Your view was stale (server is at rev ${currentRevision}). Refreshed automatically — please re-apply your last edit.`;
    const banner = document.createElement('div');
    banner.className = 'rr-stale-banner';
    banner.textContent = state.lastError;
    const pane = document.querySelector('.rr-document');
    if (pane && pane.parentNode) {
      pane.parentNode.insertBefore(banner, pane);
      setTimeout(() => banner.remove(), 8000);
    }
  }

  async function saveQuestion() {
    if (state.saveInflight) return;
    const q = currentQuestion();
    if (!q) return;
    const text = ($('rr-question-answer') || {}).value || '';
    const author = state.author.trim();
    if (!author) {
      alert('Please enter your name above before saving.');
      return;
    }
    state.saveInflight = true;
    $('rr-save').disabled = true;
    try {
      const res = await fetch('/api/questions/' + encodeURIComponent(q.id), {
        method: 'PATCH',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          revision: state.session.revision,
          status: text.trim() ? 'answered' : 'open',
          answer: text,
          author,
        }),
      });
      if (res.status === 409) {
        const err = await res.json();
        showStale(err.currentRevision);
        await loadSession();
        return;
      }
      if (!res.ok) throw new Error('save failed: ' + res.status);
      const env = await res.json();
      setSession(env);
      if (state.questionIndex < state.session.questions.length - 1) {
        state.questionIndex++;
      }
      renderQuestions();
    } catch (e) {
      alert('Save failed: ' + e.message);
    } finally {
      state.saveInflight = false;
      $('rr-save').disabled = false;
    }
  }

  function skipQuestion() {
    if (state.saveInflight) return;
    const q = currentQuestion();
    if (!q) return;
    if (q.status === 'skipped') {
      // unskip by jumping to next
      if (state.questionIndex < state.session.questions.length - 1) {
        state.questionIndex++;
      }
      renderQuestions();
      return;
    }
    const author = state.author.trim();
    if (!author) {
      alert('Please enter your name above.');
      return;
    }
    state.saveInflight = true;
    fetch('/api/questions/' + encodeURIComponent(q.id), {
      method: 'PATCH',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        revision: state.session.revision,
        status: 'skipped',
        answer: q.answer || '',
        author,
      }),
    })
      .then((res) => {
        if (res.status === 409)
          return res.json().then((err) => {
            showStale(err.currentRevision);
            return loadSession();
          });
        return res.json().then((env) => {
          setSession(env);
          if (state.questionIndex < state.session.questions.length - 1) {
            state.questionIndex++;
          }
          renderQuestions();
        });
      })
      .catch((e) => alert('Skip failed: ' + e.message))
      .finally(() => {
        state.saveInflight = false;
      });
  }

  async function postComment(body, anchor) {
    const author = state.author.trim();
    if (!author) {
      alert('Please enter your name above.');
      return;
    }
    const res = await fetch('/api/comments', {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        revision: state.session.revision,
        body,
        anchor,
        author,
      }),
    });
    if (res.status === 409) {
      const err = await res.json();
      showStale(err.currentRevision);
      await loadSession();
      return;
    }
    if (!res.ok) throw new Error('comment failed: ' + res.status);
    const env = await res.json();
    setSession(env);
  }

  async function patchComment(id, patch) {
    const res = await fetch('/api/comments/' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(Object.assign({ revision: state.session.revision }, patch)),
    });
    if (res.status === 409) {
      const err = await res.json();
      showStale(err.currentRevision);
      await loadSession();
      return;
    }
    if (!res.ok) throw new Error('update failed: ' + res.status);
    const env = await res.json();
    setSession(env);
  }

  async function complete() {
    const author = state.author.trim();
    if (!author) {
      alert('Please enter your name above.');
      return;
    }
    if (!confirm('Mark this refinement review complete? You will not be able to add more questions or comments.')) return;
    const res = await fetch('/api/complete', {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        revision: state.session.revision,
        author,
      }),
    });
    if (res.status === 409) {
      const err = await res.json();
      showStale(err.currentRevision);
      await loadSession();
      return;
    }
    if (!res.ok) {
      alert('Complete failed: ' + res.status);
      return;
    }
    const data = await res.json();
    setSession(data.session);
    $('rr-add-comment').disabled = true;
    $('rr-complete').disabled = true;
    $('rr-save').disabled = true;
    $('rr-skip').disabled = true;
    $('rr-prev').disabled = true;
    $('rr-next').disabled = true;
    const banner = document.createElement('div');
    banner.className = 'rr-banner';
    banner.textContent = `Refinement review complete. Artifact written to ${data.artifactPath}.`;
    document.body.insertBefore(banner, document.body.firstChild);
  }

  function openCommentDialog(anchor) {
    const dlg = $('rr-comment-dialog');
    $('rr-comment-body').value = '';
    state.pendingAnchor = anchor || null;
    const summary = $('rr-comment-anchor');
    if (anchor && (anchor.lineStart || anchor.selectedText)) {
      summary.innerHTML = `<div>Line ${anchor.lineStart}${
        anchor.lineEnd && anchor.lineEnd !== anchor.lineStart ? '–' + anchor.lineEnd : ''
      }${anchor.section ? ' · ' + escapeHtml(anchor.section) : ''}</div>${
        anchor.selectedText
          ? '<div>“' + escapeHtml(anchor.selectedText.slice(0, 240)) + '”</div>'
          : ''
      }`;
    } else {
      summary.innerHTML = '<div class="rr-no-anchor">No anchor — general comment on the document.</div>';
    }
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  }

  function closeCommentDialog() {
    const dlg = $('rr-comment-dialog');
    if (typeof dlg.close === 'function') dlg.close();
    else dlg.removeAttribute('open');
    state.pendingAnchor = null;
  }

  function selectionAnchor() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    let node = range.startContainer;
    while (node && node.nodeType !== 1) node = node.parentNode;
    let block = node;
    while (block && !block.dataset || !block.dataset.sourceLine) {
      block = block.parentNode;
      if (!block || block === document.body) break;
    }
    const startLine = block && block.dataset && block.dataset.sourceLine
      ? parseInt(block.dataset.sourceLine, 10)
      : null;
    let endLine = startLine;
    let endNode = range.endContainer;
    while (endNode && endNode.nodeType !== 1) endNode = endNode.parentNode;
    let endBlock = endNode;
    while (endBlock && (!endBlock.dataset || !endBlock.dataset.sourceLine)) {
      endBlock = endBlock.parentNode;
      if (!endBlock || endBlock === document.body) break;
    }
    if (endBlock && endBlock.dataset && endBlock.dataset.sourceLine) {
      endLine = parseInt(endBlock.dataset.sourceLine, 10);
    }
    const section = blockHeading(block);
    return {
      section,
      lineStart: startLine,
      lineEnd: endLine && endLine !== startLine ? endLine : startLine,
      selectedText: sel.toString().slice(0, 2000),
    };
  }

  function blockHeading(block) {
    if (!block) return null;
    const siblings = [];
    let n = block;
    while (n && n !== document.body) {
      if (n.previousElementSibling && /^H[1-6]$/.test(n.previousElementSibling.tagName)) {
        siblings.unshift(n.previousElementSibling.textContent);
        break;
      }
      if (n.previousElementSibling) {
        siblings.unshift(n.previousElementSibling.textContent);
      }
      n = n.parentElement;
      if (n && n.dataset && n.dataset.sourceLine && siblings.length === 0) {
        // walk further back until we hit a heading
        let cursor = n;
        while (cursor) {
          if (/^H[1-6]$/.test(cursor.tagName)) {
            siblings.unshift(cursor.textContent);
            break;
          }
          cursor = cursor.previousElementSibling;
        }
        break;
      }
    }
    return siblings.join(' / ') || null;
  }

  function bind() {
    $('rr-prev').addEventListener('click', () => {
      if (state.questionIndex > 0) {
        state.questionIndex--;
        renderQuestions();
      }
    });
    $('rr-next').addEventListener('click', () => {
      if (state.session && state.questionIndex < state.session.questions.length - 1) {
        state.questionIndex++;
        renderQuestions();
      }
    });
    $('rr-skip').addEventListener('click', skipQuestion);
    $('rr-save').addEventListener('click', saveQuestion);

    $('rr-add-comment').addEventListener('click', () => {
      const anchor = selectionAnchor();
      openCommentDialog(anchor);
    });
    $('rr-comment-cancel').addEventListener('click', closeCommentDialog);

    $('rr-comment-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const body = $('rr-comment-body').value;
      if (!body.trim()) return;
      postComment(body, state.pendingAnchor)
        .then(() => closeCommentDialog())
        .catch((err) => alert('Comment failed: ' + err.message));
    });

    $('rr-comments').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const id = btn.getAttribute('data-id');
      if (btn.getAttribute('data-act') === 'jump') {
        const c = state.session.comments.find((x) => x.id === id);
        if (!c || !c.anchor) return;
        const sel = `[data-source-line="${c.anchor.lineStart}"]`;
        const t = document.querySelector(sel);
        if (t) t.scrollIntoView({ block: 'center' });
      } else if (btn.getAttribute('data-act') === 'toggle-resolved') {
        const c = state.session.comments.find((x) => x.id === id);
        if (!c) return;
        patchComment(id, {
          author: state.author.trim() || c.author,
          resolved: !c.resolvedAt,
        }).catch((err) => alert('Update failed: ' + err.message));
      }
    });

    $('rr-author').addEventListener('input', (e) => {
      state.author = e.target.value;
      try {
        localStorage.setItem('rr.author', state.author);
      } catch (_) {
        /* no-op */
      }
    });

    $('rr-complete').addEventListener('click', complete);

    // Keyboard navigation: Cmd/Ctrl+Enter saves, Esc cancels dialog.
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        const dlg = $('rr-comment-dialog');
        if (dlg.hasAttribute('open')) {
          $('rr-comment-form').requestSubmit();
        } else {
          saveQuestion();
        }
      }
      if (e.key === 'Escape') {
        const dlg = $('rr-comment-dialog');
        if (dlg.hasAttribute('open')) closeCommentDialog();
      }
    });

    try {
      state.author = localStorage.getItem('rr.author') || '';
      $('rr-author').value = state.author;
    } catch (_) {
      /* no-op */
    }
  }

  function subscribe() {
    if (typeof EventSource === 'undefined') return;
    const es = new EventSource('/api/events?token=' + encodeURIComponent(token()));
    es.addEventListener('session', (ev) => {
      try {
        const env = JSON.parse(ev.data);
        setSession(env, { bumpQuestionIndex: true });
      } catch (_) {
        /* ignore */
      }
    });
    es.addEventListener('error', () => {
      $('rr-status').textContent = 'disconnected';
    });
  }

  async function main() {
    bind();
    await loadSession();
    await loadDocument();
    renderInlineComments();
    subscribe();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
})();
