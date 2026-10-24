// Runs at document-start, before the game's loader: keeps keystrokes typed into the explorer
// away from the game's key handlers. (Finding the game, the Module and the wasm is the shared
// bootstrap's job: see src/bootstrap.)

const HOST_ID = 'unity-explorer-host';

export function installHooks() {
  const P = EventTarget.prototype;
  if (P.__ueAdd) return;
  const add = P.addEventListener;
  const remove = P.removeEventListener;
  P.__ueAdd = add;
  P.__ueRemove = remove;
  const wrapped = new WeakMap();
  const KEYS = new Set(['keydown', 'keyup', 'keypress']);
  const fromUs = (e) => {
    const t = e.target;
    return !!(t && t.id === HOST_ID);
  };
  P.addEventListener = function (type, fn, opts) {
    if (KEYS.has(type) && typeof fn === 'function' && (this === window || this === document || this instanceof HTMLCanvasElement)) {
      let w = wrapped.get(fn);
      if (!w) {
        w = function (e) { if (fromUs(e)) return undefined; return fn.call(this, e); };
        wrapped.set(fn, w);
      }
      return add.call(this, type, w, opts);
    }
    return add.call(this, type, fn, opts);
  };
  P.removeEventListener = function (type, fn, opts) {
    const w = typeof fn === 'function' && wrapped.get(fn);
    return remove.call(this, type, w || fn, opts);
  };
}

export const EXPLORER_HOST_ID = HOST_ID;
