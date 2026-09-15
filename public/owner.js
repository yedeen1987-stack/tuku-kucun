// 你自己用的电脑端，只有一点点交互：新建拣货单的弹窗。
(function () {
  'use strict';
  var dialog = document.getElementById('new-list-dialog');
  var open = document.getElementById('new-list');
  if (open && dialog) {
    open.addEventListener('click', function () { dialog.showModal(); });
    dialog.addEventListener('click', function (event) {
      if (event.target.hasAttribute('data-close') || event.target === dialog) dialog.close();
    });
  }
})();
