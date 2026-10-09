(function () {
  'use strict';

  const G = window.GAME;
  const STORE_KEY = 'wedding-puzzle-v1';
  const LOCK_IDS = Object.keys(G.locks);

  // ---------- 狀態（存在 localStorage，重新整理不會掉進度） ----------
  function freshState() {
    return { started: false, startAt: null, finishAt: null, solved: {}, hintLevel: {}, wrong: {} };
  }
  function loadState() {
    const s = freshState();
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) Object.assign(s, JSON.parse(raw));
    } catch (e) { /* 無痕模式等情況：用記憶體裡的狀態就好 */ }
    return s;
  }
  function saveState() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }

  let state = loadState();
  if (/[?&]reset\b/.test(location.search)) {
    state = freshState();
    saveState();
    history.replaceState(null, '', location.pathname + location.hash);
  }

  const solvedCount = () => LOCK_IDS.filter((id) => state.solved[id]).length;
  const isLocked = (lockId) => lockId && !state.solved[lockId];

  // ---------- 小工具 ----------
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function markKeys(text) {
    return text.replace(/\{(.+?)\}/g, '<span class="key">$1</span>');
  }
  function stripHtml(html) {
    const d = document.createElement('div');
    d.innerHTML = html;
    return d.textContent || '';
  }
  function fmtDuration(ms) {
    const sec = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m ? `${m} 分 ${s} 秒` : `${s} 秒`;
  }
  function photoHtml(p) {
    if (p.src) return `<img class="photo-img" src="${p.src}" alt="${p.label || ''}" loading="lazy">`;
    return `<div class="photo-ph" aria-hidden="true">${p.ph || '📷'}</div>`;
  }

  const KEYBOARD = [
    ['1ㄅ', '2ㄉ', '3ˇ', '4ˋ', '5ㄓ', '6ˊ', '7˙', '8ㄚ', '9ㄞ', '0ㄢ', '-ㄦ'],
    ['qㄆ', 'wㄊ', 'eㄍ', 'rㄐ', 'tㄔ', 'yㄗ', 'uㄧ', 'iㄛ', 'oㄟ', 'pㄣ'],
    ['aㄇ', 'sㄋ', 'dㄎ', 'fㄑ', 'gㄕ', 'hㄘ', 'jㄨ', 'kㄜ', 'lㄠ', ';ㄤ'],
    ['zㄈ', 'xㄌ', 'cㄏ', 'vㄒ', 'bㄖ', 'nㄙ', 'mㄩ', ',ㄝ', '.ㄡ', '/ㄥ'],
  ];
  function keyboardHtml() {
    return '<div class="kb">' + KEYBOARD.map((row) =>
      '<div class="kb-row">' + row.map((k) =>
        `<span class="kb-key"><i>${k[0]}</i>${k.slice(1)}</span>`).join('') + '</div>').join('') + '</div>';
  }
  function fmtHint(h) {
    return h.replace('{{keyboard}}', keyboardHtml());
  }

  // ---------- 答案判定 ----------
  function normalize(lock, s) {
    s = String(s || '').normalize('NFKC');
    if (lock.normalize === 'digits') return s.replace(/\D/g, '');
    return s.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
  }
  function checkAnswer(lockId, input) {
    const lock = G.locks[lockId];
    const v = normalize(lock, input);
    const eq = (a) => normalize(lock, a) === v;
    if (!v) return { ok: false, msg: '先輸入密碼喔～' };
    if (lock.answers.some(eq)) return { ok: true };
    for (const nm of lock.nearMisses || []) {
      if (nm.answers.some(eq)) return { ok: false, near: true, msg: nm.msg };
    }
    if (lock.anagramMsg) {
      const sorted = (x) => Array.from(x).sort().join('');
      if (sorted(v) === sorted(normalize(lock, lock.answers[0]))) return { ok: false, near: true, msg: lock.anagramMsg };
    }
    return { ok: false, msg: '密碼錯誤，再想想看～' };
  }

  // ---------- 外框 ----------
  const app = document.getElementById('app');
  document.title = G.blogTitle;

  function renderShell() {
    app.innerHTML = `
      <div class="wrap">
        <header class="banner">
          <h1 class="glitter">${G.blogTitle}</h1>
          <p class="subtitle">${G.blogSubtitle}</p>
        </header>
        <div class="marquee" aria-hidden="true"><span>${G.marquee}</span></div>
        <nav class="tabs">
          <a href="#/" data-tab="home">網誌</a>
          <a href="#/album" data-tab="album">相簿</a>
          <a href="#/guestbook" data-tab="guestbook">留言板</a>
          <a href="#/profile" data-tab="profile">關於我</a>
          <button type="button" class="keys-pill" id="keysPill" aria-label="秘密進度"></button>
        </nav>
        <div class="layout">
          <main id="main"></main>
          <aside id="side"></aside>
        </div>
        <footer class="foot">© 2011 ${G.blogTitle}・本網誌最佳瀏覽解析度 1024×768</footer>
      </div>
      <button type="button" class="hint-fab" id="hintFab">💡 卡住了嗎？</button>
      <div class="modal" id="modal" hidden><div class="modal-card" role="dialog" aria-modal="true"></div></div>
      <div class="toast" id="toast" hidden></div>`;

    $('#hintFab').addEventListener('click', () => openHints());
    $('#keysPill').addEventListener('click', () => openHints());
    $('#modal').addEventListener('click', (e) => {
      if (e.target.id === 'modal') closeModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('#modal').hidden) closeModal();
    });
  }

  function renderProgress() {
    $('#keysPill').textContent = `🔑 ${solvedCount()}/${LOCK_IDS.length}`;
  }

  function renderSide() {
    const P = G.profile;
    const lockList = LOCK_IDS.map((id) => {
      const L = G.locks[id];
      return `<li><a href="${L.where}">${state.solved[id] ? '✅' : '🔒'} ${L.name}</a></li>`;
    }).join('');
    const latest = G.guestbook.filter((g) => !g.private).slice(0, 3).map((g) =>
      `<li><a href="#/guestbook">${g.avatar} ${g.name}：${stripHtml(g.text).slice(0, 12)}</a></li>`).join('');
    $('#side').innerHTML = `
      <section class="box">
        <h3>☆ 版主</h3>
        <div class="side-avatar">${P.avatar}</div>
        <p class="center"><b>${G.groom}</b></p>
        <p class="center small">心情：${P.mood}</p>
      </section>
      <section class="box">
        <h3>🔑 秘密進度 ${solvedCount()}/${LOCK_IDS.length}</h3>
        <ul class="plain">${lockList}</ul>
      </section>
      <section class="box">
        <h3>☆ 最新留言</h3>
        <ul class="plain">${latest}</ul>
      </section>
      <section class="box">
        <h3>☆ 好友名單</h3>
        <ul class="plain">${P.friends.map((f) => `<li>${f}</li>`).join('')}</ul>
      </section>
      <section class="box">
        <h3>☆ 人氣</h3>
        <p class="small">今日人氣：${G.visitors.today}<br>總人氣：<span class="counter">${G.visitors.total}</span></p>
      </section>`;
  }

  // ---------- 頁面 ----------
  function lockBox(lockId) {
    const L = G.locks[lockId];
    const numeric = L.normalize === 'digits';
    const showHint = (state.wrong[lockId] || 0) >= 2;
    return `
      <form class="lock-box" data-lock="${lockId}" novalidate>
        <div class="lock-icon">🔒</div>
        <p class="lock-prompt">${L.prompt}</p>
        <div class="lock-row">
          <input name="pw" type="text" ${numeric ? 'inputmode="numeric"' : ''} autocomplete="off"
                 autocapitalize="off" spellcheck="false" placeholder="輸入密碼" aria-label="密碼">
          <button type="submit" class="btn">解鎖</button>
        </div>
        <p class="lock-msg" role="status"></p>
        <button type="button" class="link-btn need-hint" ${showHint ? '' : 'hidden'}>需要提示嗎？</button>
      </form>`;
  }

  function sortedPosts() {
    return G.posts.slice().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.date.localeCompare(a.date));
  }

  function viewHome() {
    const items = sortedPosts().map((p) => {
      const locked = isLocked(p.lock);
      const excerpt = locked
        ? '<span class="muted">🔒 這篇文章已加密，需要密碼才能閱讀。</span>'
        : stripHtml(p.content).slice(0, 60) + '……';
      return `
        <article class="post-card">
          <div class="post-meta">${p.date}・心情 ${p.mood}</div>
          <h2 class="post-title"><a href="#/post/${p.id}">${p.pinned ? '<span class="pin">[置頂]</span> ' : ''}${locked ? '🔒 ' : ''}${p.title}</a></h2>
          <p class="excerpt">${excerpt}</p>
          <a class="more" href="#/post/${p.id}">繼續閱讀 »</a>
        </article>`;
    }).join('');
    return `<h2 class="section-title">☆ 網誌文章</h2>${items}`;
  }

  function viewPost(id) {
    const p = G.posts.find((x) => x.id === id);
    if (!p) return notFound();
    const locked = isLocked(p.lock);
    let body = locked ? lockBox(p.lock) : `<div class="post-body">${p.content}</div>`;
    if (!locked && p.lock === G.finalLock) body += endingBlock();
    return `
      <a class="back" href="#/">« 回文章列表</a>
      <article class="post-full">
        <div class="post-meta">${p.date}・心情 ${p.mood}</div>
        <h2 class="post-title">${p.pinned ? '<span class="pin">[置頂]</span> ' : ''}${p.title}</h2>
        ${body}
        <div class="post-foot">回應(0)｜引用(0)｜推薦 ♥</div>
      </article>`;
  }

  function endingBlock() {
    const E = G.ending;
    const elapsed = state.finishAt && state.startAt ? fmtDuration(state.finishAt - state.startAt) : '';
    return `
      <section class="ending">
        <h3>${E.title}</h3>
        <div class="ending-photo">${photoHtml(E.photo)}</div>
        <p>${E.html}</p>
        <p class="sign">${E.sign}</p>
        <div class="certificate">
          🎉 <b>破關證明</b> 🎉<br>
          ${elapsed ? `解謎時間：${elapsed}<br>` : ''}
          <span class="small">${state.finishAt ? new Date(state.finishAt).toLocaleString('zh-TW') : ''}</span>
        </div>
      </section>`;
  }

  function viewAlbums() {
    const items = G.albums.map((a) => `
      <a class="album-card" href="#/album/${a.id}">
        <div class="album-cover">${isLocked(a.lock) ? '🔒' : a.cover}</div>
        <div class="album-name">${a.title}</div>
        <div class="small muted">${isLocked(a.lock) ? '已上鎖' : a.photos.length + ' 張'}・${a.desc}</div>
      </a>`).join('');
    return `<h2 class="section-title">☆ 相簿</h2><div class="album-grid">${items}</div>`;
  }

  function viewAlbum(id) {
    const a = G.albums.find((x) => x.id === id);
    if (!a) return notFound();
    let body;
    if (isLocked(a.lock)) {
      body = lockBox(a.lock);
    } else {
      body = '<div class="photo-grid">' + a.photos.map((p) => `
        <figure class="photo">
          ${photoHtml(p)}
          <figcaption><span class="photo-date">${p.date}</span>${markKeys(p.caption)}</figcaption>
        </figure>`).join('') + '</div>';
    }
    return `
      <a class="back" href="#/album">« 回相簿列表</a>
      <h2 class="section-title">☆ 相簿：${a.title}</h2>
      <p class="small muted">${a.desc}</p>
      ${body}`;
  }

  function viewGuestbook() {
    const items = G.guestbook.map((g) => `
      <div class="gb-item ${g.private ? 'private' : ''}">
        <div class="gb-head"><span class="gb-avatar">${g.avatar}</span><b>${g.name}</b><span class="small muted">${g.date}</span></div>
        <div class="gb-text">${g.text}</div>
        ${g.reply ? `<div class="gb-reply"><b>版主回覆：</b>${g.reply}</div>` : ''}
      </div>`).join('');
    return `
      <h2 class="section-title">☆ 留言板</h2>
      <p class="small muted">有來就留言～留言必回踩！</p>
      ${items}`;
  }

  function viewProfile() {
    const P = G.profile;
    const rows = P.rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('');
    return `
      <h2 class="section-title">☆ 關於我</h2>
      <div class="profile">
        <div class="profile-avatar">${P.avatar}</div>
        <table class="profile-table">${rows}</table>
      </div>
      <p>${P.about}</p>
      <p class="reset-row"><button type="button" class="link-btn" id="resetBtn">重新開始遊戲</button></p>`;
  }

  function notFound() {
    return '<p>找不到這個頁面耶 (・_・;)</p><p><a href="#/">« 回首頁</a></p>';
  }

  // ---------- 路由 ----------
  function route() {
    const [page, id] = (location.hash.replace(/^#\/?/, '') || 'home').split('/');
    const views = {
      home: viewHome,
      post: () => viewPost(id),
      album: () => (id ? viewAlbum(id) : viewAlbums()),
      guestbook: viewGuestbook,
      profile: viewProfile,
    };
    $('#main').innerHTML = (views[page] || notFound)();
    $$('.tabs a').forEach((a) => {
      const tab = a.dataset.tab;
      a.classList.toggle('on', tab === page || (tab === 'home' && page === 'post'));
    });
    bindPage();
  }

  function bindPage() {
    $$('form.lock-box').forEach((form) => {
      const lockId = form.dataset.lock;
      const input = $('input', form);
      const msg = $('.lock-msg', form);
      const hintBtn = $('.need-hint', form);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const r = checkAnswer(lockId, input.value);
        if (r.ok) return solve(lockId);
        msg.textContent = r.msg;
        msg.className = 'lock-msg ' + (r.near ? 'near' : 'bad');
        form.classList.remove('shake');
        void form.offsetWidth; // 重新觸發動畫
        form.classList.add('shake');
        state.wrong[lockId] = (state.wrong[lockId] || 0) + 1;
        saveState();
        if (state.wrong[lockId] >= 2) hintBtn.hidden = false;
      });
      hintBtn.addEventListener('click', () => openHints(lockId));
    });
    const reset = $('#resetBtn');
    if (reset) {
      reset.addEventListener('click', () => {
        if (!confirm('確定要清除進度、重新開始嗎？')) return;
        state = freshState();
        saveState();
        location.hash = '#/';
        refresh();
        showIntro();
      });
    }
  }

  function solve(lockId) {
    state.solved[lockId] = true;
    if (lockId === G.finalLock && !state.finishAt) state.finishAt = Date.now();
    saveState();
    refresh();
    if (lockId === G.finalLock) {
      showEnding();
    } else {
      toast(`🔑 解開了！（${solvedCount()}/${LOCK_IDS.length}）`);
    }
  }

  function refresh() {
    renderProgress();
    renderSide();
    route();
  }

  // ---------- 彈出視窗 ----------
  function openModal(html, onClose) {
    const modal = $('#modal');
    const card = $('.modal-card', modal);
    $('#toast').hidden = true;
    card.innerHTML = html;
    modal.hidden = false;
    modal._onClose = onClose;
    $$('[data-close]', card).forEach((b) => b.addEventListener('click', closeModal));
    return card;
  }
  function closeModal() {
    const modal = $('#modal');
    if (modal.hidden) return;
    modal.hidden = true;
    const cb = modal._onClose;
    modal._onClose = null;
    if (cb) cb();
  }

  function showIntro() {
    const I = G.intro;
    openModal(`
      <h3>${I.title}</h3>
      <p>${I.html}</p>
      <button type="button" class="btn btn-big" data-close>開始探索 ✨</button>`, () => {
      if (!state.started) {
        state.started = true;
        state.startAt = Date.now();
        saveState();
      }
    });
  }

  function openHints(lockId) {
    lockId = lockId || LOCK_IDS.find((id) => !state.solved[id]) || LOCK_IDS[0];
    const L = G.locks[lockId];
    const lvl = state.hintLevel[lockId] || 0;
    const last = L.hints.length - 1;
    const tabs = LOCK_IDS.map((id) =>
      `<button type="button" class="htab ${id === lockId ? 'on' : ''}" data-id="${id}">${state.solved[id] ? '✅' : '🔒'} ${G.locks[id].name}</button>`).join('');
    const shown = L.hints.slice(0, lvl).map((h, i) => `
      <div class="hint ${i === last ? 'answer' : ''}">
        <b>${i === last ? '答案' : '提示 ' + (i + 1)}</b>
        <div>${fmtHint(h)}</div>
      </div>`).join('');
    let more = '';
    if (lvl <= last) {
      const label = lvl === last ? '直接看答案' : lvl === 0 ? '給我一點提示' : '再給我一點提示';
      more = `<button type="button" class="btn" id="moreHint">${label}</button>`;
    }
    const card = openModal(`
      <h3>💡 提示</h3>
      <p class="small">目標：解開置頂文章〈給未來的妳〉。選一個你卡住的地方：</p>
      <div class="htabs">${tabs}</div>
      ${state.solved[lockId] ? '<p class="small ok">這道鎖已經解開了 👍</p>' : ''}
      <div class="hints">${shown || '<p class="small muted">先自己找找看，真的想不到再點下面的按鈕 ^^</p>'}</div>
      <div class="modal-actions">
        ${more}
        <a class="btn btn-ghost" href="${L.where}" data-close>前往這道鎖</a>
        <button type="button" class="btn btn-ghost" data-close>關閉</button>
      </div>`);
    $$('.htab', card).forEach((b) => b.addEventListener('click', () => openHints(b.dataset.id)));
    const mb = $('#moreHint', card);
    if (mb) {
      mb.addEventListener('click', () => {
        state.hintLevel[lockId] = lvl + 1;
        saveState();
        openHints(lockId);
      });
    }
  }

  function showEnding() {
    const elapsed = state.finishAt && state.startAt ? fmtDuration(state.finishAt - state.startAt) : '';
    openModal(`
      <div class="hearts" aria-hidden="true">${'<span>💗</span>'.repeat(12)}</div>
      <h3 class="center">🎉 恭喜破關！</h3>
      <p class="center">你解開了${G.groom}藏了好多年的秘密 💍</p>
      ${elapsed ? `<p class="center small">解謎時間：${elapsed}</p>` : ''}
      <div class="modal-actions">
        <button type="button" class="btn btn-big" data-close>閱讀〈${G.locks[G.finalLock].name.replace(/^.*〈|〉.*$/g, '')}〉</button>
      </div>`, () => {
      location.hash = G.locks[G.finalLock].where;
      route();
    });
  }

  let toastTimer;
  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2500);
  }

  // ---------- 啟動 ----------
  renderShell();
  window.addEventListener('hashchange', () => { route(); window.scrollTo(0, 0); });
  refresh();
  if (!state.started) showIntro();
})();
