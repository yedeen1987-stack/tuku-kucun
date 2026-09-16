// 工人手机端。核心要求：仓库里信号差也能干活。
//
// 操作只有两个：
//   [-] X/N [+]  改已拿几卷，每点一次自动保存，不用再点保存
//   [Pronto]     这一款做完了。拿齐了直接完成；没拿齐会先问一句，
//                确认以后就是缺货回执，不用再单独点一次「发送缺货」。
//
// 所有操作先改界面、排进 localStorage 队列，再慢慢往服务器发。
// 每条带一个 client_uuid，服务器有唯一约束，断网重发不会重复记账。
(function () {
  'use strict';
  var QUEUE_KEY = 'picking-queue-v2';
  var csrf = document.body.dataset.csrf || '';
  var badge = document.getElementById('sync-badge');
  var zoom = document.getElementById('zoom');
  var confirmBox = document.getElementById('short-confirm');
  var flushing = false;
  var pendingFinish = null;

  function readQueue() {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch (e) { return []; }
  }
  function writeQueue(queue) {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(queue)); } catch (e) { /* 隐私模式：丢了也不能卡住界面 */ }
  }
  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'x' + Date.now() + Math.random().toString(16).slice(2);
  }
  function round(n) { return Math.round(n * 1000) / 1000; }

  function setBadge(state, text) {
    if (!badge) return;
    badge.dataset.state = state;
    badge.textContent = text;
  }

  function refreshTotals() {
    var cards = document.querySelectorAll('.pick-card');
    var doneItems = 0, rollsGot = 0, rollsNeed = 0;
    cards.forEach(function (card) {
      if (card.dataset.done === '1') doneItems++;
      rollsGot += Number(card.dataset.taken);
      rollsNeed += Number(card.dataset.qty);
    });
    var a = document.getElementById('progress-items');
    var b = document.getElementById('progress-rolls');
    if (a) a.textContent = doneItems;
    if (b) b.textContent = round(rollsGot);

    document.querySelectorAll('.floor-group').forEach(function (group) {
      var rows = group.querySelectorAll('.pick-card');
      var hit = 0;
      rows.forEach(function (card) { if (card.dataset.done === '1') hit++; });
      var label = group.querySelector('[data-floor-count]');
      if (label) label.textContent = hit + '/' + rows.length;
    });
  }

  function paint(card) {
    var qty = Number(card.dataset.qty);
    var taken = Number(card.dataset.taken);
    var done = card.dataset.done === '1';
    var short = done && taken < qty;

    card.classList.toggle('is-done', done && !short);
    card.classList.toggle('is-short', short);

    var label = card.querySelector('[data-taken-label]');
    if (label) label.textContent = round(taken);

    var finish = card.querySelector('[data-finish]');
    if (finish) finish.textContent = done ? (short ? 'Faltou ' + round(qty - taken) : 'Pronto ✓') : 'Pronto';
    refreshTotals();
  }

  function push(card, action, taken) {
    var queue = readQueue();
    queue.push({client_uuid: uuid(), item_id: Number(card.dataset.item), action: action, qty: taken});
    writeQueue(queue);
    flush();
  }

  // 改数量。已经完成的再动数量，就自动退回未完成——
  // 免得出现「已完成」但数字又变了的矛盾状态。
  function setTaken(card, next) {
    var qty = Number(card.dataset.qty);
    next = round(Math.max(0, Math.min(qty, next)));
    card.dataset.taken = String(next);
    if (card.dataset.done === '1') card.dataset.done = '0';
    paint(card);
    push(card, 'qty', next);
  }

  function finish(card) {
    var qty = Number(card.dataset.qty);
    var taken = Number(card.dataset.taken);

    if (card.dataset.done === '1') {          // 再点一次 = 撤销完成
      card.dataset.done = '0';
      paint(card);
      push(card, 'undone', taken);
      return;
    }
    if (taken >= qty) {                        // 拿齐了，直接完成
      card.dataset.done = '1';
      paint(card);
      push(card, 'done', taken);
      return;
    }
    askShortage(card, qty, taken);             // 没拿齐，先问一句
  }

  function askShortage(card, qty, taken) {
    var gap = round(qty - taken);
    pendingFinish = card;
    document.getElementById('short-title').textContent = 'Faltam ' + gap + ' rolos';
    document.getElementById('short-text').textContent =
      'Você pegou ' + round(taken) + ' de ' + qty + '. Concluir assim?';
    confirmBox.querySelector('[data-ok]').textContent = 'Confirmar falta de ' + gap;
    confirmBox.hidden = false;
  }

  function closeConfirm() { confirmBox.hidden = true; pendingFinish = null; }

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
      var sent = {};
      batch.forEach(function (event) { sent[event.client_uuid] = true; });
      writeQueue(readQueue().filter(function (event) { return !sent[event.client_uuid]; }));

      // 用服务器返回的值校正界面（比如另一个工人也动了同一项）
      (data.applied || []).forEach(function (row) {
        var card = document.querySelector('.pick-card[data-item="' + row.item_id + '"]');
        if (!card) return;
        card.dataset.taken = String(row.taken_qty);
        card.dataset.done = row.done ? '1' : '0';
        paint(card);
      });

      flushing = false;
      if (readQueue().length) flush(); else setBadge('ok', 'online');
    }).catch(function (error) {
      flushing = false;
      if (error.message === 'auth') { setBadge('err', 'sessão expirou'); return; }
      setBadge('wait', readQueue().length + ' na fila');
      setTimeout(flush, 8000);
    });
  }

  document.addEventListener('click', function (event) {
    if (confirmBox && !confirmBox.hidden) {
      if (event.target.closest('[data-ok]')) {
        var card = pendingFinish;
        closeConfirm();
        if (card) {
          card.dataset.done = '1';
          paint(card);
          push(card, 'done', Number(card.dataset.taken));   // 缺货回执立刻排队上传
        }
        return;
      }
      if (event.target.closest('[data-cancel]') || event.target === confirmBox) { closeConfirm(); return; }
    }

    var step = event.target.closest('[data-step]');
    if (step) {
      var stepCard = step.closest('.pick-card');
      setTaken(stepCard, Number(stepCard.dataset.taken) + Number(step.dataset.step));
      return;
    }

    var done = event.target.closest('[data-finish]');
    if (done) { finish(done.closest('.pick-card')); return; }

    var photo = event.target.closest('[data-zoom]');
    if (photo && zoom) { zoom.querySelector('img').src = photo.dataset.zoom; zoom.hidden = false; return; }

    if (zoom && !zoom.hidden && (event.target === zoom || event.target.closest('.zoom-close'))) {
      zoom.hidden = true;
      zoom.querySelector('img').src = '';
    }
  });

  window.addEventListener('online', flush);
  window.addEventListener('offline', function () { setBadge('wait', readQueue().length + ' na fila'); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) flush(); });

  refreshTotals();
  flush();
})();
