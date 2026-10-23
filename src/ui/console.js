// Console tab: a JavaScript REPL with the bridge in scope.
import { h } from './dom.js';
import { hexAddr } from '../il2cpp/values.js';

const HELP = `Helpers in scope:
  il            the IL2CPP bridge (il.findType, il.findMethod, il.call, il.readString, …)
  unity         UnityEngine helpers (unity.hierarchy(), unity.components(go), unity.name(obj), …)
  type(name)    type definition index, e.g. type('UnityEngine.Camera')
  method(t, n, sig?)  method record, e.g. method('UnityEngine.Time', 'get_timeScale', 0)
  call(m, self, ...args)  call a method record with JS values
  find(name)    GameObjects whose name contains the text
  objects(t)    live objects of a UnityEngine.Object type, e.g. objects('UnityEngine.Camera')
  inspect(x)    open a GameObject / object address / type name in the inspector
  str(ptr)      read a System.String
  hex(n)        format an address
Example:  call(method('UnityEngine.Time', 'set_timeScale', 1), 0, 0.5)`;

export class ConsoleView {
  constructor(app) {
    this.app = app;
    this.hist = [];
    this.hpos = 0;
    this.out = h('div.con-out');
    this.input = h('textarea.ue-in', { placeholder: 'JavaScript — Enter to run, Shift+Enter for a new line, ↑ for history', spellcheck: false, rows: 1 });
    this.input.addEventListener('keydown', (e) => this.key(e));
    this.input.addEventListener('input', () => { this.input.style.height = 'auto'; this.input.style.height = Math.min(160, this.input.scrollHeight) + 'px'; });
    this.el = h('div.con', this.out, h('div.con-in', this.input, h('button.ue-btn.pri', { on: { click: () => this.run() } }, 'Run')));
    this.print(HELP, 'dim');
  }

  print(text, cls = '') {
    this.out.append(h('div.l' + (cls ? '.' + cls : ''), { text }));
    while (this.out.childElementCount > 500) this.out.firstChild.remove();
    this.out.scrollTop = this.out.scrollHeight;
  }

  key(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.run(); }
    else if (e.key === 'ArrowUp' && !this.input.value.includes('\n') && this.hist.length) {
      e.preventDefault();
      this.hpos = Math.max(0, this.hpos - 1);
      this.input.value = this.hist[this.hpos] || '';
    } else if (e.key === 'ArrowDown' && !this.input.value.includes('\n') && this.hist.length) {
      e.preventDefault();
      this.hpos = Math.min(this.hist.length, this.hpos + 1);
      this.input.value = this.hist[this.hpos] || '';
    }
  }

  scope() {
    const app = this.app;
    const { il, unity } = app;
    return {
      il, unity,
      type: (n) => il.findType(n),
      method: (t, n, s) => il.findMethod(t, n, s),
      call: (m, self, ...a) => il.call(m, self, ...a),
      find: (q) => { const d = unity.hierarchy(); const out = []; const walk = (n) => { if (n.name.toLowerCase().includes(String(q).toLowerCase())) out.push(n.go); n.children.forEach(walk); }; d.roots.forEach(walk); return out; },
      objects: (t) => unity.objectsOfType(typeof t === 'number' ? t : il.findType(t)),
      inspect: (x) => app.inspect(x),
      str: (p) => il.readString(p),
      hex: hexAddr,
      app,
    };
  }

  run() {
    const code = this.input.value.trim();
    if (!code) return;
    this.hist.push(code);
    this.hpos = this.hist.length;
    this.input.value = '';
    this.input.style.height = '';
    this.print(code, 'cmd');
    const s = this.scope();
    const keys = Object.keys(s);
    let fn;
    try { fn = new Function(...keys, `return (${code}\n);`); } catch (_) {
      try { fn = new Function(...keys, code); } catch (e) { this.print(String(e), 'err'); return; }
    }
    try {
      const r = fn(...keys.map((k) => s[k]));
      Promise.resolve(r).then((v) => this.print(this.show(v)), (e) => this.print(String(e && e.message || e), 'err'));
    } catch (e) {
      this.print(String(e && e.message || e), 'err');
    }
  }

  show(v) {
    if (v === undefined) return 'undefined';
    if (typeof v === 'number' && Number.isInteger(v) && v > 0x10000 && this.app.il.mem.valid(v) && this.app.il.mem.valid(this.app.il.klassOf(v))) {
      try { return `${v} (${hexAddr(v)}) → ${this.app.fmt.objectSummary(v)}`; } catch (_) { /* fall through */ }
    }
    if (typeof v === 'bigint') return v.toString() + 'n';
    if (typeof v === 'string') return JSON.stringify(v);
    try {
      return JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() + 'n' : x), 2) ?? String(v);
    } catch (_) {
      return String(v);
    }
  }
}
