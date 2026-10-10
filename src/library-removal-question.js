'use strict';

// LIB-019. The main process owns the pending removal. A reply only answers the
// question sent to this exact WebContents; stale/repeated replies cannot remove
// another selection. Thinking about a question never holds the library lock.
function createLibraryRemovalQuestion({ getWindow, nextId }) {
  let pending = null;

  function ask(question) {
    const win = getWindow();
    if (pending || !win || win.isDestroyed() || win.webContents.isDestroyed()) return Promise.resolve(false);
    const contents = win.webContents;
    return new Promise((resolve) => {
      const listeners = [];
      const listen = (target, name, handler) => {
        target.on(name, handler);
        listeners.push([target, name, handler]);
      };
      const id = nextId();
      const finish = (confirmed) => {
        if (!pending || pending.id !== id) return;
        pending = null;
        for (const [target, name, handler] of listeners) target.removeListener(name, handler);
        try { if (!contents.isDestroyed()) contents.send('library-removal-question-closed', id); } catch { /* already gone */ }
        resolve(confirmed === true);
      };
      pending = { id, contents, finish };
      const cancel = () => finish(false);
      listen(win, 'hide', cancel);
      listen(win, 'closed', cancel);
      listen(contents, 'destroyed', cancel);
      listen(contents, 'render-process-gone', cancel);
      listen(contents, 'did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) cancel();
      });
      try { contents.send('library-removal-question', { ...question, requestId: id }); }
      catch { cancel(); }
    });
  }

  function answer(sender, requestId, confirmed) {
    if (!pending || pending.contents !== sender || pending.id !== requestId || typeof confirmed !== 'boolean') return false;
    pending.finish(confirmed);
    return true;
  }

  return { ask, answer, cancel: () => { if (pending) pending.finish(false); } };
}

module.exports = { createLibraryRemovalQuestion };
