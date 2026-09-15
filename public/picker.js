// 工人手机端。核心要求：仓库里信号差也能干活。
// 点「已拿」先改界面、把操作排进 localStorage 队列，再慢慢往服务器发。
// 每条操作带一个 client_uuid，服务器那边有唯一约束，所以重发不会重复记账。
(function () {
  'use strict';
  var QUEUE_KEY = 'picking-queue-v1';
  var csrf = document.body.dataset.csrf || '';
  var badge = document.getElementById('sync-badge');
  var zoom = document.getElementById('zoom');
  var flushing = false;

  function readQueue() {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch (e) { return []; }
  }
  function writeQueue(queue) {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(queue)); } catch (e) { /* 隐私模式等：丢了也不能卡住界面 */ }
  }
  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'x' + Date.now() + Math.random().toString(16).slice(2);
  }

  function setBadge(state, text) {
    if (!badge) return;
    badge.dataset.state = state;
    badge.textContent = text;
  }

  function refreshCounts() {
    var cards = document.querySelectorAll('.pick-card');
    var done = 0;
    cards.forEach(function (card) {
      if (Number(card.dataset.taken) >= Number(card.dataset.qty)) done++;
    });
    var total = document.getElementById('progress-done');
    if (total) total.textContent = done;

    document.querySelectorAll('.floor-group').forEach(function (group) {
      var rows = group.querySelectorAll('.pick-card');
      var hit = 0;
      rows.forEach(function (card) {
        if (Number(card.dataset.taken) >= Number(card.dataset.qty)) hit++;
      });
      var label = group.querySelector('[data-floor-count]');
      if (label) label.textContent = hit + '/' + rows.length;
    });
  }

  function paint(card) {
    var qty = Number(card.dataset.qty), taken = Number(card.dataset.taken);
    var done = taken >= qty;
    card.classList.toggle('is-done', done);
    var label = card.querySelector('[data-taken-label]');
    if (label) label.textContent = taken;
    var toggle = card.querySelector('[data-toggle]');
    if (toggle) toggle.textContent = done ? 'Peguei ✓' : 'Peguei';
    refreshCounts();
  }

  function record(card, nextQty) {
    var qty = Number(card.dataset.qty);
    nextQty = Math.max(0, Math.min(qty, nextQty));
    card.dataset.taken = String(nextQty);
    paint(card);

    var queue = readQueue();
    queue.push({
      client_uuid: uuid(),
      item_id: Number(card.dataset.item),
      action: nextQty > 0 ? 'taken' : 'untaken',
      qty: nextQty
    });
    writeQueue(queue);
    flush();
  }

  function flush() {
    if (flushing) return;
    var queue = readQueue();
    if (!queue.length) { setBadge('ok', 'online'); return; }
    if (!navigator.onLine) { setBadge('wait', queue.length + ' na fila'); return; }

    flushing = true;
    setBadge('sync', 'enviando…');
    var batch = queue.slice(0, 50);

    fetch('/api/events', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({csrf_token: csrf, events: batch})
    }).then(function (res) {
      if (res.status === 401 || res.status === 403) throw new Error('auth');
      if (!res.ok) throw new Error('http');
      return res.json();
    }).then(function (data) {
      // 只删掉确认送达的那批，剩下的留着下次发
      var sent = {};
      batch.forEach(function (event) { sent[event.client_uuid] = true; });
      writeQueue(readQueue().filter(function (event) { return !sent[event.client_uuid]; }));

      // 用服务器返回的值校正界面（比如别人也拣了同一项）
      (data.applied || []).forEach(function (row) {
        var card = document.querySelector('.pick-card[data-item="' + row.item_id + '"]');
        if (card) { card.dataset.taken = String(row.taken_qty); paint(card); }
      });

      flushing = false;
      if (readQueue().length) flush(); else setBadge('ok', 'online');
    }).catch(function (error) {
      flushing = false;
      if (error.message === 'auth') {
        setBadge('err', 'sessão expirou');
        return;
      }
      setBadge('wait', readQueue().length + ' na fila');
      setTimeout(flush, 8000);
    });
  }

  document.addEventListener('click', function (event) {
    var toggle = event.target.closest('[data-toggle]');
    if (toggle) {
      var card = toggle.closest('.pick-card');
      var qty = Number(card.dataset.qty), taken = Number(card.dataset.taken);
      record(card, taken >= qty ? 0 : qty);
      return;
    }

    var step = event.target.closest('[data-step]');
    if (step) {
      var stepCard = step.closest('.pick-card');
      record(stepCard, Number(stepCard.dataset.taken) + Number(step.dataset.step));
      return;
    }

    var photo = event.target.closest('[data-zoom]');
    if (photo && zoom) {
      zoom.querySelector('img').src = photo.dataset.zoom;
      zoom.hidden = false;
      return;
    }

    if (zoom && !zoom.hidden && (event.target === zoom || event.target.closest('.zoom-close'))) {
      zoom.hidden = true;
      zoom.querySelector('img').src = '';
    }
  });

  window.addEventListener('online', flush);
  window.addEventListener('offline', function () { setBadge('wait', readQueue().length + ' na fila'); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) flush(); });

  refreshCounts();
  flush();
})();
