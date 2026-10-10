'use strict';

(function initLibraryRemovalDialog(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LibraryRemovalDialog = api;
}(typeof window !== 'undefined' ? window : globalThis, function libraryRemovalDialogFactory() {
  const IMAGE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="2"/><circle cx="15.5" cy="8.5" r="1.5"/><path d="m5.5 17 4.5-5 3.5 3.5 2.5-2.5 2.5 4"/></svg>';
  const FOLDER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z"/></svg>';
  const TRASH = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4h10M6 2.5h4M4 4l.6 9.5h6.8L12 4M6.5 6.5v4.5M9.5 6.5v4.5"/></svg>';
  const CLOSE = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

  function create({ document, reply }) {
    let active = null;
    const element = (tag, className, text) => {
      const node = document.createElement(tag);
      node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    function close(requestId, confirmed, sendReply = true) {
      if (!active || active.requestId !== requestId) return;
      const current = active;
      active = null;
      document.removeEventListener('keydown', current.keydown, true);
      document.removeEventListener('keyup', current.keyup, true);
      current.modal.close();
      current.modal.remove();
      if (current.previous && current.previous.isConnected) current.previous.focus({ preventScroll: true });
      if (sendReply) Promise.resolve(reply(requestId, confirmed === true)).catch(() => {});
    }
    function show(question) {
      if (!question || typeof question.requestId !== 'string') return;
      if (active) {
        if (active.requestId !== question.requestId) Promise.resolve(reply(question.requestId, false)).catch(() => {});
        return;
      }
      const id = question.requestId;
      const previous = document.activeElement;
      const modal = element('dialog', 'lib-modal library-remove-dialog');
      modal.setAttribute('aria-labelledby', 'libraryRemoveTitle');
      modal.setAttribute('aria-describedby', 'libraryRemoveMessage libraryRemoveDetail');
      const head = element('header', 'library-remove-head');
      const title = element('h2', '', question.title);
      title.id = 'libraryRemoveTitle';
      const x = element('button', 'lib-modal-close');
      x.type = 'button';
      x.setAttribute('aria-label', question.closeLabel || question.cancelLabel);
      x.innerHTML = CLOSE;
      head.append(title, x);
      const body = element('div', 'library-remove-body');
      const message = element('p', 'library-remove-sr', question.message);
      message.id = 'libraryRemoveMessage';
      const count = element('p', 'library-remove-count', question.countLabel);
      const list = element('ul', 'boxed-list library-remove-names');
      // Keyboard users can scroll long names without moving onto the destructive button.
      list.tabIndex = 0;
      list.setAttribute('aria-label', question.countLabel);
      for (const item of (question.names || []).slice(0, 10)) {
        const row = element('li', 'row');
        const icon = element('span', 'library-remove-icon');
        icon.innerHTML = item.type === 'folder' ? FOLDER : IMAGE;
        const name = element('span', 'library-remove-name', item.name);
        row.append(icon, name);
        list.append(row);
      }
      const detail = element('p', 'library-remove-detail');
      detail.id = 'libraryRemoveDetail';
      const trash = element('span', '');
      trash.innerHTML = TRASH;
      detail.append(trash, element('span', '', question.detail));
      body.append(message, count, list);
      if (question.more > 0) body.append(element('p', 'library-remove-more', '… +' + question.more));
      body.append(detail);
      const foot = element('footer', 'library-remove-foot');
      const cancel = element('button', 'pill library-remove-cancel', question.cancelLabel);
      const yes = element('button', 'pill danger', question.yesLabel);
      cancel.type = yes.type = 'button';
      foot.append(cancel, yes);
      modal.append(head, body, foot);
      const finish = (confirmed) => close(id, confirmed);
      x.addEventListener('click', () => finish(false));
      cancel.addEventListener('click', () => finish(false));
      yes.addEventListener('click', () => finish(true));
      modal.addEventListener('cancel', (event) => { event.preventDefault(); finish(false); });
      modal.addEventListener('click', (event) => {
        if (event.target !== modal) return;
        const rect = modal.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) finish(false);
      });
      const focusable = [x, list, cancel, yes];
      const keydown = (event) => {
        // Prevent the library's document shortcuts (selection/delete/navigation)
        // from acting behind the top-layer dialog. Button Enter remains native.
        event.stopImmediatePropagation();
        if (event.key === 'Escape') { event.preventDefault(); finish(false); }
        else if (event.key === 'Tab') {
          event.preventDefault();
          const index = focusable.indexOf(document.activeElement);
          focusable[(index + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length].focus();
        } else if (event.key === 'Enter' && ![x, cancel, yes].includes(document.activeElement)) {
          event.preventDefault(); finish(false);
        }
      };
      const keyup = (event) => event.stopImmediatePropagation();
      active = { requestId: id, modal, previous, keydown, keyup };
      document.body.append(modal);
      document.addEventListener('keydown', keydown, true);
      document.addEventListener('keyup', keyup, true);
      try { modal.showModal(); cancel.focus({ preventScroll: true }); }
      catch { close(id, false); }
    }
    return { show, dismiss: (id) => close(id, false, false) };
  }
  return { create };
}));
