(function () {
  'use strict';

  const S = window.SETTINGS;
  const STORE_KEY = 'wedding-puzzle-v2';
  const LOCK_IDS = Object.keys(S.locks);
  const SERIAL_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 去掉容易看錯的 0/O、1/I/L

  let POSTS = []; // 依 posts.json 的順序
  let SORT = null; // { answer: [正確順序的文章 id], pool: [一開始打亂的順序] }
  let selectedPhoto = null;

  // ---------- 狀態（存在 localStorage，重新整理不會掉進度） ----------
  function freshState() {
    return {
      started: false, startAt: null, finishAt: null,
      solved: {}, hintLevel: {}, wrong: {},
      sortSlots: null, claim: null,
    };
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
  const isLocked = (lockId) => !!lockId && !state.solved[lockId];
  const hintsUsed = () => Object.values(state.hintLevel).reduce((a, b) => a + b, 0);

  // ---------- 小工具 ----------
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
  // 「2011/6/20 9:05」這種沒補零的寫法也能正確比較先後
  function dateKey(d) {
    return (String(d).match(/\d+/g) || []).map((n, i) => n.padStart(i === 0 ? 4 : 2, '0')).join('-');
  }

  // ---------- 載入文章 ----------
  async function fetchText(url) {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`${url}（${r.status}）`);
    return r.text();
  }

  function parsePhoto(v) {
    if (!v) return null;
    v = v.trim();
    if (/\.(jpe?g|png|gif|webp|avif)$/i.test(v)) {
      return { src: v.includes('/') ? v : 'photos/' + v };
    }
    // 還沒有照片時：「🎂 生日蛋糕」= 表情符號 + 說明文字當佔位
    const [ph, ...rest] = v.split(/\s+/);
    return { ph, label: rest.join(' ') };
  }

  function mdToHtml(md) {
    return md.trim().split(/\n\s*\n/).map((block) => {
      block = block.trim();
      if (/^<(p|div|h\d|ul|ol|figure|img|iframe|blockquote)\b/i.test(block)) return block;
      return '<p>' + block.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>') + '</p>';
    }).join('');
  }

  function parsePost(file, raw) {
    raw = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    const meta = {};
    let body = raw;
    const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (m) {
      m[1].split('\n').forEach((line) => {
        const i = line.search(/[:：]/);
        if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      });
      body = m[2];
    }
    const lock = meta['上鎖'] || null;
    const showIf = meta['出現條件'] || null;
    [lock, showIf].forEach((id) => {
      if (id && !S.locks[id]) console.warn(`${file}：找不到關卡「${id}」，請檢查 settings.js 的 locks`);
    });
    return {
      id: file.replace(/\.md$/i, ''),
      title: meta['標題'] || file,
      date: meta['日期'] || '',
      mood: meta['心情'] || '',
      photo: parsePhoto(meta['照片']),
      pinned: /^(是|yes|true)$/i.test(meta['置頂'] || ''),
      lock,
      showIf,
      html: mdToHtml(body),
    };
  }

  // 固定的亂數，讓每個人看到的初始順序都一樣，而且不會剛好是正確答案
  function shuffled(ids) {
    let seed = 20111014;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let tries = 0; tries < 50; tries++) {
      const a = ids.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      if (a.length < 2 || a.every((id, i) => id !== ids[i])) return a;
    }
    return ids.slice().reverse();
  }

  async function loadContent() {
    const files = JSON.parse(await fetchText('content/posts.json'));
    POSTS = await Promise.all(files.map(async (f) => parsePost(f, await fetchText('content/posts/' + f))));
    const answer = POSTS.filter((p) => p.photo)
      .sort((a, b) => dateKey(a.date).localeCompare(dateKey(b.date)))
      .map((p) => p.id);
    SORT = { answer, pool: shuffled(answer) };
    const ok = Array.isArray(state.sortSlots) && state.sortSlots.length === answer.length &&
      state.sortSlots.every((id) => id === null || answer.includes(id));
    if (!ok) state.sortSlots = answer.map(() => null);
  }

  const postById = (id) => POSTS.find((p) => p.id === id);
  const isVisible = (p) => !p.showIf || state.solved[p.showIf];

  // ---------- 答案判定 ----------
  function normalize(lock, s) {
    s = String(s || '').normalize('NFKC');
    if (lock.normalize === 'digits') return s.replace(/\D/g, '');
    return s.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
  }
  function checkAnswer(lockId, input) {
    const lock = S.locks[lockId];
    const v = normalize(lock, input);
    const eq = (a) => normalize(lock, a) === v;
    if (!v) return { ok: false, msg: '先輸入密碼喔～' };
    if (lock.answers.some(eq)) return { ok: true };
    for (const nm of lock.nearMisses || []) {
      if (nm.answers.some(eq)) return { ok: false, near: true, msg: nm.msg };
    }
    return { ok: false, msg: '密碼錯誤，再想想看～' };
  }

  // ---------- 外框 ----------
  const app = document.getElementById('app');
  document.title = S.blogTitle;

  function renderShell() {
    app.innerHTML = `
      <div class="wrap">
        <header class="banner">
          <h1 class="glitter">${S.blogTitle}</h1>
          <p class="subtitle">${S.blogSubtitle}</p>
        </header>
        <div class="marquee" aria-hidden="true"><span>${S.marquee}</span></div>
        <nav class="tabs">
          <a href="#/" data-tab="home">網誌</a>
          <a href="#/album" data-tab="album">相簿</a>
          <a href="#/guestbook" data-tab="guestbook">留言板</a>
          <a href="#/profile" data-tab="profile">關於我</a>
          <button type="button" class="keys-pill" id="keysPill" aria-label="秘密進度"></button>
        </nav>
        <div class="layout">
          <main id="main"><p class="muted">載入中……</p></main>
          <aside id="side"></aside>
        </div>
        <footer class="foot">© 2011 ${S.blogTitle}・本網誌最佳瀏覽解析度 1024×768</footer>
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
    const P = S.profile;
    const lockList = LOCK_IDS.map((id) => {
      const L = S.locks[id];
      return `<li><a href="${L.where}">${state.solved[id] ? '✅' : '🔒'} ${L.name}</a></li>`;
    }).join('');
    const latest = S.guestbook.filter((g) => !g.private).slice(0, 3).map((g) =>
      `<li><a href="#/guestbook">${g.avatar} ${g.name}：${stripHtml(g.text).slice(0, 12)}</a></li>`).join('');
    $('#side').innerHTML = `
      <section class="box">
        <h3>☆ 版主</h3>
        <div class="side-avatar">${P.avatar}</div>
        <p class="center"><b>${S.groom}</b></p>
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
        <p class="small">今日人氣：${S.visitors.today}<br>總人氣：<span class="counter">${S.visitors.total}</span></p>
      </section>`;
  }

  // ---------- 頁面 ----------
  function photoHtml(p) {
    if (!p) return '';
    if (p.src) return `<img class="photo-img" src="${p.src}" alt="" loading="lazy" draggable="false">`;
    return `<div class="photo-ph"><span class="ph-emoji">${p.ph || '📷'}</span>${p.label ? `<span class="ph-label">${p.label}</span>` : ''}</div>`;
  }

  function lockBox(lockId) {
    const L = S.locks[lockId];
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
    // 置頂在最前面，其餘照 posts.json 的順序（故意不照時間排）
    const visible = POSTS.filter(isVisible);
    return visible.filter((p) => p.pinned).concat(visible.filter((p) => !p.pinned));
  }

  function viewHome() {
    const items = sortedPosts().map((p) => {
      const locked = isLocked(p.lock);
      const excerpt = locked
        ? '<span class="muted">🔒 這篇文章已加密，需要密碼才能閱讀。</span>'
        : esc(stripHtml(p.html).slice(0, 60)) + '……';
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
    const p = postById(id);
    if (!p || !isVisible(p)) return notFound();
    const locked = isLocked(p.lock);
    let body = locked ? lockBox(p.lock) : `<div class="post-body">${p.html}</div>`;
    if (!locked && p.lock === S.finalLock) body += endingBlock();
    return `
      <a class="back" href="#/">« 回文章列表</a>
      <article class="post-full">
        <div class="post-meta">${p.date}・心情 ${p.mood}</div>
        <h2 class="post-title">${p.pinned ? '<span class="pin">[置頂]</span> ' : ''}${p.title}</h2>
        ${body}
        <div class="post-foot">回應(0)｜引用(0)｜推薦 ♥</div>
      </article>`;
  }

  function viewAlbums() {
    const items = S.albums.map((a) => {
      const locked = isLocked(a.lock);
      const count = a.sortLock ? SORT.answer.length : a.photos.length;
      return `
        <a class="album-card" href="#/album/${a.id}">
          <div class="album-cover">${locked ? '🔒' : a.cover}</div>
          <div class="album-name">${a.title}</div>
          <div class="small muted">${locked ? '已上鎖' : count + ' 張'}・${a.desc}</div>
        </a>`;
    }).join('');
    return `<h2 class="section-title">☆ 相簿</h2><div class="album-grid">${items}</div>`;
  }

  function viewAlbum(id) {
    const a = S.albums.find((x) => x.id === id);
    if (!a) return notFound();
    let body;
    if (isLocked(a.lock)) {
      body = lockBox(a.lock);
    } else if (a.sortLock && isLocked(a.sortLock)) {
      body = sortBox(a.sortLock);
    } else if (a.sortLock) {
      body = `<p class="solved-note">${a.solvedNote || ''}</p>` + photoGrid(SORT.answer.map((pid) => {
        const p = postById(pid);
        return { photo: p.photo, date: p.date.split(' ')[0], caption: `〈<a href="#/post/${p.id}">${p.title}</a>〉` };
      }));
    } else {
      body = photoGrid(a.photos.map((p) => ({ photo: p.src ? { src: p.src } : { ph: p.ph }, date: p.date, caption: p.caption })));
    }
    return `
      <a class="back" href="#/album">« 回相簿列表</a>
      <h2 class="section-title">☆ 相簿：${a.title}</h2>
      <p class="small muted">${a.desc}</p>
      ${body}`;
  }

  function photoGrid(items) {
    return '<div class="photo-grid">' + items.map((it) => `
      <figure class="photo">
        ${photoHtml(it.photo)}
        <figcaption>${it.date ? `<span class="photo-date">${it.date}</span>` : ''}${it.caption || ''}</figcaption>
      </figure>`).join('') + '</div>';
  }

  // ----- 照片排序 -----
  function sortCard(id) {
    const p = postById(id);
    return `
      <div class="sort-card${selectedPhoto === id ? ' selected' : ''}" data-photo="${id}" tabindex="0" role="button" aria-label="照片">
        ${photoHtml(p.photo)}
        <button type="button" class="zoom" data-zoom="${id}" aria-label="放大照片">🔍</button>
      </div>`;
  }

  function sortBox(lockId) {
    const slots = state.sortSlots;
    const pool = SORT.pool.filter((id) => !slots.includes(id));
    const full = slots.every(Boolean);
    const showHint = (state.wrong[lockId] || 0) >= 2;
    return `
      <div class="sort-box" data-lock="${lockId}">
        <p class="sort-tip">🧩 這些照片好像有一定的順序……<br>把照片<b>拖曳</b>到下面的格子排好，再按「確認」。<br><span class="small muted">（也可以先點一下照片，再點一下格子）</span></p>
        <div class="sort-pool" data-zone="pool">
          ${pool.map(sortCard).join('') || '<p class="small muted pool-empty">照片都放進格子了，可以把照片拖回這裡</p>'}
        </div>
        <div class="sort-slots">
          ${slots.map((id, i) => `
            <div class="slot${id ? ' filled' : ''}" data-zone="slot" data-index="${i}">
              <span class="slot-no">${i + 1}</span>${id ? sortCard(id) : ''}
            </div>`).join('')}
        </div>
        <div class="sort-actions">
          <button type="button" class="btn btn-big" id="sortConfirm" ${full ? '' : 'disabled'}>確認</button>
        </div>
        <p class="lock-msg" role="status">${full ? '' : `<span class="muted">還有 ${slots.filter((x) => !x).length} 格是空的</span>`}</p>
        <button type="button" class="link-btn need-hint" ${showHint ? '' : 'hidden'}>需要提示嗎？</button>
      </div>`;
  }

  function placePhoto(id, zone) {
    const slots = state.sortSlots;
    const from = slots.indexOf(id);
    if (zone.dataset.zone === 'pool') {
      if (from >= 0) slots[from] = null;
    } else {
      const to = Number(zone.dataset.index);
      if (to !== from) {
        const occupant = slots[to];
        slots[to] = id;
        if (from >= 0) slots[from] = occupant; // 從格子拖到格子：兩張交換
      }
    }
    selectedPhoto = null;
    saveState();
    route();
  }

  function tapPhoto(id, card) {
    const slot = card.closest('.slot');
    if (selectedPhoto && selectedPhoto !== id && slot) return placePhoto(selectedPhoto, slot);
    selectedPhoto = selectedPhoto === id ? null : id;
    route();
  }

  function bindSort(box) {
    const lockId = box.dataset.lock;
    let drag = null;
    const zoneAt = (x, y) => {
      const el = document.elementFromPoint(x, y);
      return el && box.contains(el) ? el.closest('[data-zone]') : null;
    };
    const highlight = (x, y) => {
      const z = zoneAt(x, y);
      $$('.over', box).forEach((el) => { if (el !== z) el.classList.remove('over'); });
      if (z) z.classList.add('over');
    };
    // 手機畫面放不下全部格子：拖到螢幕上下緣時自動捲動
    const autoScroll = () => {
      if (!drag || !drag.moved) return;
      const edge = 80;
      const y = drag.lastY;
      const h = window.innerHeight;
      let dy = 0;
      if (y < edge) dy = -Math.ceil((edge - y) / 10);
      else if (y > h - edge) dy = Math.ceil((y - (h - edge)) / 10);
      if (dy) {
        window.scrollBy(0, dy);
        highlight(drag.lastX, drag.lastY);
      }
      drag.raf = requestAnimationFrame(autoScroll);
    };
    const cleanup = (d) => {
      cancelAnimationFrame(d.raf);
      if (d.ghost) d.ghost.remove();
      d.card.classList.remove('dragging');
      $$('.over', box).forEach((el) => el.classList.remove('over'));
    };

    box.addEventListener('pointerdown', (e) => {
      if (e.button > 0 || e.target.closest('.zoom')) return;
      const card = e.target.closest('.sort-card');
      if (!card) return;
      drag = { id: card.dataset.photo, card, x: e.clientX, y: e.clientY, moved: false, ghost: null, pid: e.pointerId };
      card.setPointerCapture(e.pointerId);
    });
    box.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.pid) return;
      if (!drag.moved) {
        if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 8) return;
        drag.moved = true;
        const r = drag.card.getBoundingClientRect();
        drag.offX = drag.x - r.left;
        drag.offY = drag.y - r.top;
        drag.ghost = drag.card.cloneNode(true);
        drag.ghost.classList.add('ghost');
        drag.ghost.style.width = r.width + 'px';
        drag.ghost.style.height = r.height + 'px';
        document.body.appendChild(drag.ghost);
        drag.card.classList.add('dragging');
        drag.raf = requestAnimationFrame(autoScroll);
      }
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
      drag.ghost.style.transform = `translate(${e.clientX - drag.offX}px, ${e.clientY - drag.offY}px)`;
      highlight(e.clientX, e.clientY);
    });
    box.addEventListener('pointerup', (e) => {
      if (!drag || e.pointerId !== drag.pid) return;
      const d = drag;
      drag = null;
      cleanup(d);
      if (!d.moved) return tapPhoto(d.id, d.card);
      const z = zoneAt(e.clientX, e.clientY);
      if (z) placePhoto(d.id, z);
    });
    box.addEventListener('pointercancel', () => {
      if (drag) cleanup(drag);
      drag = null;
    });
    box.addEventListener('keydown', (e) => {
      const card = e.target.closest('.sort-card');
      if (card && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        tapPhoto(card.dataset.photo, card);
      }
    });
    box.addEventListener('click', (e) => {
      const zoom = e.target.closest('.zoom');
      if (zoom) return openPhoto(zoom.dataset.zoom);
      if (e.target.closest('.sort-card')) return; // 已由 pointer 事件處理
      const zone = e.target.closest('[data-zone]');
      if (zone && selectedPhoto) placePhoto(selectedPhoto, zone);
    });

    const msg = $('.lock-msg', box);
    $('#sortConfirm', box).addEventListener('click', () => {
      if (state.sortSlots.every((id, i) => id === SORT.answer[i])) return solve(lockId);
      msg.innerHTML = '<span class="bad">順序不對喔～再想想看是什麼順序</span>';
      box.classList.remove('shake');
      void box.offsetWidth;
      box.classList.add('shake');
      state.wrong[lockId] = (state.wrong[lockId] || 0) + 1;
      saveState();
      if (state.wrong[lockId] >= 2) $('.need-hint', box).hidden = false;
    });
    $('.need-hint', box).addEventListener('click', () => openHints(lockId));
  }

  function openPhoto(id) {
    const p = postById(id);
    openModal(`
      <div class="lightbox">${photoHtml(p.photo)}</div>
      <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>關閉</button></div>`);
  }

  // ----- 結局與抽獎 -----
  function endingBlock() {
    const E = S.ending;
    const video = E.youtubeId
      ? `<div class="video"><iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(E.youtubeId)}" title="感謝影片" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe></div>`
      : '<div class="video video-ph">🎬<br>感謝影片（待放上）</div>';
    return `
      <section class="ending">
        <h3>${E.title}</h3>
        ${video}
        <p>${E.html}</p>
        <p class="sign">${E.sign}</p>
        ${state.claim ? certificate() : claimForm()}
      </section>`;
  }

  function claimForm() {
    return `
      <form class="claim-form" novalidate>
        <h4>🧧 登記抽獎</h4>
        <p class="small">輸入你的名字，拿到專屬的抽獎序號！</p>
        <div class="lock-row">
          <input name="name" type="text" maxlength="20" autocomplete="name" placeholder="你的名字" aria-label="你的名字">
          <button type="submit" class="btn">登記</button>
        </div>
        <p class="lock-msg" role="status"></p>
      </form>`;
  }

  function claimStatus() {
    if (!S.sheetUrl) return '（尚未設定抽獎登記網址，序號只存在這支手機）';
    return state.claim.sent ? '✅ 已登記抽獎' : '⏳ 登記中……網路不穩也沒關係，會自動重試';
  }

  function certificate() {
    const c = state.claim;
    return `
      <div class="certificate">
        <div>🎉 <b>破關證明</b> 🎉</div>
        <div class="cert-name">${esc(c.name)}</div>
        <div class="cert-serial">${c.serial}</div>
        <div class="small">解謎時間：${c.duration}｜使用提示：${c.hints} 次</div>
        <div class="small muted">${new Date(c.at).toLocaleString('zh-TW')}</div>
        <p class="cert-status small">${claimStatus()}</p>
        <p class="cert-shot">📸 請<b>截圖</b>這個畫面，抽獎時要核對序號喔！</p>
      </div>`;
  }

  function makeSerial() {
    const buf = new Uint32Array(5);
    (window.crypto || window.msCrypto).getRandomValues(buf);
    return Array.from(buf, (n) => SERIAL_CHARS[n % SERIAL_CHARS.length]).join('');
  }

  let sending = false;
  function sendClaim() {
    const c = state.claim;
    if (!c || c.sent || !S.sheetUrl || sending) return;
    sending = true;
    // Apps Script 不回傳 CORS 標頭，用 no-cors 送出；請求有送到就算成功
    fetch(S.sheetUrl, {
      method: 'POST',
      mode: 'no-cors',
      body: JSON.stringify({ name: c.name, serial: c.serial, duration: c.duration, hints: c.hints }),
    }).then(() => {
      c.sent = true;
      saveState();
      const el = $('.cert-status');
      if (el) el.textContent = claimStatus();
    }).catch(() => {
      setTimeout(sendClaim, 15000);
    }).finally(() => {
      sending = false;
    });
  }

  function bindClaim(form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = $('input', form).value.trim();
      if (!name) {
        $('.lock-msg', form).textContent = '先輸入名字喔～';
        return;
      }
      state.claim = {
        name: name.slice(0, 20),
        serial: makeSerial(),
        at: Date.now(),
        duration: state.finishAt && state.startAt ? fmtDuration(state.finishAt - state.startAt) : '',
        hints: hintsUsed(),
        sent: false,
      };
      saveState();
      route();
      sendClaim();
    });
  }

  function viewGuestbook() {
    const items = S.guestbook.map((g) => `
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
    const P = S.profile;
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
      post: () => viewPost(decodeURIComponent(id || '')),
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
    $$('.sort-box').forEach(bindSort);
    $$('form.claim-form').forEach(bindClaim);
    const reset = $('#resetBtn');
    if (reset) {
      reset.addEventListener('click', () => {
        if (!confirm('確定要清除進度、重新開始嗎？\n（已登記的抽獎序號也會從這支手機上消失）')) return;
        state = freshState();
        state.sortSlots = SORT.answer.map(() => null);
        saveState();
        location.hash = '#/';
        refresh();
        showIntro();
      });
    }
  }

  function solve(lockId) {
    state.solved[lockId] = true;
    if (lockId === S.finalLock && !state.finishAt) state.finishAt = Date.now();
    saveState();
    refresh();
    if (lockId === S.finalLock) return showEnding();
    const revealed = POSTS.filter((p) => p.showIf === lockId);
    toast(revealed.length
      ? `🔑 解開了！網誌出現了一篇新文章（${solvedCount()}/${LOCK_IDS.length}）`
      : `🔑 解開了！（${solvedCount()}/${LOCK_IDS.length}）`);
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
    const I = S.intro;
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

  function sortAnswerHtml() {
    const list = SORT.answer.map((id) => {
      const p = postById(id);
      const pic = p.photo.src
        ? `<img class="answer-thumb" src="${p.photo.src}" alt="">`
        : esc(p.photo.label || p.photo.ph || '照片');
      return `<li>${pic}〈${p.title}〉${p.date.split(' ')[0]}</li>`;
    }).join('');
    return `正確順序：<ol class="answer-list">${list}</ol><button type="button" class="btn" id="autoSort">幫我排好</button>`;
  }

  function openHints(lockId) {
    lockId = lockId || LOCK_IDS.find((id) => !state.solved[id]) || LOCK_IDS[0];
    const L = S.locks[lockId];
    const lvl = state.hintLevel[lockId] || 0;
    const last = L.hints.length - 1;
    const tabs = LOCK_IDS.map((id) =>
      `<button type="button" class="htab ${id === lockId ? 'on' : ''}" data-id="${id}">${state.solved[id] ? '✅' : '🔒'} ${S.locks[id].name}</button>`).join('');
    const shown = L.hints.slice(0, lvl).map((h, i) => `
      <div class="hint ${i === last ? 'answer' : ''}">
        <b>${i === last ? '答案' : '提示 ' + (i + 1)}</b>
        <div>${h === '{{sortAnswer}}' ? sortAnswerHtml() : h}</div>
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
      ${state.solved[lockId] ? '<p class="small ok">這一關已經解開了 👍</p>' : ''}
      <div class="hints">${shown || '<p class="small muted">先自己找找看，真的想不到再點下面的按鈕 ^^</p>'}</div>
      <div class="modal-actions">
        ${more}
        <a class="btn btn-ghost" href="${L.where}" data-close>前往這一關</a>
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
    const auto = $('#autoSort', card);
    if (auto) {
      auto.addEventListener('click', () => {
        state.sortSlots = SORT.answer.slice();
        saveState();
        closeModal();
        if (location.hash !== L.where) location.hash = L.where;
        else route();
      });
    }
  }

  function showEnding() {
    const elapsed = state.finishAt && state.startAt ? fmtDuration(state.finishAt - state.startAt) : '';
    openModal(`
      <div class="hearts" aria-hidden="true">${'<span>💗</span>'.repeat(12)}</div>
      <h3 class="center">🎉 恭喜破關！</h3>
      <p class="center">你解開了${S.groom}藏了好多年的秘密 💍</p>
      ${elapsed ? `<p class="center small">解謎時間：${elapsed}</p>` : ''}
      <p class="center">往下看看新人想對你說的話，<br>還可以<b>登記抽小紅包</b> 🧧</p>
      <div class="modal-actions">
        <button type="button" class="btn btn-big" data-close>繼續閱讀</button>
      </div>`, () => {
      const where = S.locks[S.finalLock].where;
      if (location.hash !== where) location.hash = where;
      else route();
    });
  }

  let toastTimer;
  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3000);
  }

  // ---------- 啟動 ----------
  renderShell();
  renderProgress();
  renderSide();
  loadContent().then(() => {
    window.addEventListener('hashchange', () => { route(); window.scrollTo(0, 0); });
    window.addEventListener('online', sendClaim);
    route();
    if (!state.started) showIntro();
    sendClaim(); // 上次沒送成功的話，重新送一次
  }).catch((err) => {
    console.error(err);
    $('#main').innerHTML = `
      <div class="load-error">
        <p><b>文章載入失敗 (・_・;)</b></p>
        <p class="small">如果你是直接雙擊 index.html 開啟，瀏覽器不允許讀取文章檔案，
        請改用資料夾裡的 <b>start.bat</b> 開啟（說明見 README）。</p>
        <p class="small muted">${esc(err.message)}</p>
      </div>`;
  });
})();
