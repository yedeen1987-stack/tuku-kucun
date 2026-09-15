// 你自己用的电脑端。
(function () {
  'use strict';
  var csrf = document.body.dataset.csrf || '';

  // ---------- 新建拣货单弹窗 ----------
  var dialog = document.getElementById('new-list-dialog');
  var open = document.getElementById('new-list');
  if (open && dialog) {
    open.addEventListener('click', function () { dialog.showModal(); });
    dialog.addEventListener('click', function (event) {
      if (event.target.hasAttribute('data-close') || event.target === dialog) dialog.close();
    });
  }

  // ---------- 改卷数 ----------
  // 客人要 2 卷、3 卷是常事，所以用 − ＋ 直接点，改完自动保存，不用按保存按钮。
  // 中间的数字也能直接打字，应付偶尔要 20 卷的情况。
  function clean(value) {
    var n = Number(String(value).replace(',', '.'));
    return isFinite(n) && n > 0 ? Math.round(n * 1000) / 1000 : 1;
  }

  function save(box) {
    var input = box.querySelector('.qty-input');
    var qty = clean(input.value);
    input.value = qty;
    box.classList.add('is-saving');

    fetch('/api/items/' + box.dataset.item + '/qty', {
      method: 'POST',
      body: new URLSearchParams({csrf_token: csrf, qty: String(qty)})
    }).then(function (res) {
      if (!res.ok) throw new Error('save');
      return res.json();
    }).then(function (data) {
      box.classList.remove('is-saving');
      box.classList.add('is-saved');
      setTimeout(function () { box.classList.remove('is-saved'); }, 900);
      input.value = data.qty;
      box.dataset.taken = data.taken_qty;
      var state = document.querySelector('[data-state-for="' + box.dataset.item + '"]');
      if (state) {
        state.textContent = data.taken_qty >= data.qty ? '已拿' : data.taken_qty + '/' + data.qty;
        box.closest('.item-row').classList.toggle('is-done', data.taken_qty >= data.qty);
      }
      refreshDone();
    }).catch(function () {
      box.classList.remove('is-saving');
      box.classList.add('is-error');
      setTimeout(function () { box.classList.remove('is-error'); }, 2000);
    });
  }

  // 改完数量，顶部「已拿 X/Y」要跟着变，不然要刷新才对得上
  function refreshDone() {
    var label = document.getElementById('list-done');
    if (!label) return;
    var done = 0;
    document.querySelectorAll('.item-row').forEach(function (row) {
      if (row.classList.contains('is-done')) done++;
    });
    label.textContent = done;
  }

  document.addEventListener('click', function (event) {
    var step = event.target.closest('[data-qty-step]');
    if (!step) return;
    var box = step.closest('.item-qty');
    var input = box.querySelector('.qty-input');
    input.value = Math.max(1, clean(input.value) + Number(step.dataset.qtyStep));
    save(box);
  });

  document.addEventListener('change', function (event) {
    if (event.target.classList.contains('qty-input')) save(event.target.closest('.item-qty'));
  });

  // 按回车直接保存，不要提交外面的表单
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && event.target.classList.contains('qty-input')) {
      event.preventDefault();
      event.target.blur();
    }
  });
})();
