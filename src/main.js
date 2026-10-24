// Unity Explorer for Unity WebGL (IL2CPP) games: entry point.
import { installHooks, waitForModule, detectUnity, EXPLORER_HOST_ID } from './hook.js';

installHooks();

import { UI } from './odium/index.js';
import { Il2Cpp } from './il2cpp/runtime.js';
import { UnityApi } from './il2cpp/unity.js';
import { ValueFormatter, hexAddr } from './il2cpp/values.js';
import { SceneView } from './ui/scene.js';
import { ClassesView } from './ui/classes.js';
import { ConsoleView } from './ui/console.js';
import { I } from './ui/icons.js';
import { h } from './ui/dom.js';
import css from 'bundle-text:./ui/explorer.css';

const VERSION = '1.1.0';
const SETTINGS_KEY = 'unity-explorer:settings';

function loadSettings() {
  const def = { autoProps: 'engine', showAccessors: false };
  try { return { ...def, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch (_) { return def; }
}

class App {
  constructor() {
    this.settings = loadSettings();
    this.logLines = [];
    this.ui = new UI();
    this.ui.createWindow('UNITY EXPLORER', { subtitle: 'v' + VERSION, width: 1060, height: 680, toggleKey: 'F7' });
    this.ui.host.id = EXPLORER_HOST_ID;
    const style = document.createElement('style');
    style.textContent = css;
    this.ui.root.getRootNode().appendChild(style);
    const foot = this.ui.win.querySelector('.foot span');
    if (foot) foot.textContent = 'Unity Explorer';

    this.tabs = {};
    this.tabs.scene = this._fillTab('Scene', 'Explore', I.cube);
    this.tabs.classes = this._fillTab('Classes', 'Explore', I.klass);
    this.tabs.console = this._fillTab('Console', 'Tools', I.terminal);
    this.tabs.status = this.ui.addTab('Status', { group: 'Tools', icon: I.info });
    this._buildStatus();
    this.settingsTab = this.ui.addSettingsTab('Settings', { group: 'System' });
    this._buildOptions();
    this.ui.selectTab(this.tabs.scene);

    const loading = (msg) => h('div.ue-loading', h('div', h('div.sp', { style: { margin: '0 auto 14px' } }), h('div', { text: msg })));
    this.tabs.scene.page.replaceChildren(loading('Waiting for the Unity game to load…'));
    this.tabs.classes.page.replaceChildren(loading('Waiting for the Unity game to load…'));
    this.tabs.console.page.replaceChildren(loading('Waiting for the Unity game to load…'));

    waitForModule((s) => this.status.setValue(s)).then((M) => this.start(M));
  }

  _fillTab(name, group, icon) {
    const t = this.ui.addTab(name, { group, icon });
    t.page.classList.add('ue-fill');
    return t;
  }

  log(msg, type = 'info') {
    this.logLines.push(`[${type}] ${msg}`);
    if (this.logCtl) this.logCtl.log(msg, type);
    (type === 'error' ? console.error : console.log)('[UnityExplorer]', msg);
  }

  shadowActive() {
    try { return this.ui.root.getRootNode().activeElement; } catch (_) { return null; }
  }

  focusTab(id) {
    const t = this.tabs[id];
    if (t && this.ui.active !== t) this.ui.selectTab(t);
  }

  start(Module, attempt = 0) {
    this.Module = Module;
    this.status.setValue('Reading IL2CPP metadata…');
    let il;
    try {
      il = new Il2Cpp(Module, (m) => this.log(m));
      il.init();
    } catch (e) {
      // metadata is loaded a moment after the runtime starts; retry for a while
      if (attempt < 40 && /metadata not found/.test(e.message)) {
        setTimeout(() => this.start(Module, attempt + 1), 1000);
        return;
      }
      this.fail(e);
      return;
    }
    this.il = il;
    try {
      this.unity = new UnityApi(il);
    } catch (e) {
      this.fail(e);
      return;
    }
    this.fmt = new ValueFormatter(il, this.unity);

    this.scene = new SceneView(this);
    this.classes = new ClassesView(this, this.scene);
    this.console = new ConsoleView(this);
    this.tabs.scene.page.replaceChildren(this.scene.el);
    this.tabs.classes.page.replaceChildren(this.classes.el);
    this.tabs.console.page.replaceChildren(this.console.el);
    this.classes.load();
    this.scene.refresh();
    this._fillStatus();
    this.status.setValue('Ready');
    this.ui.notify('Unity Explorer ready · F7 to toggle', 'success', 2500);

    window.UnityExplorer = { app: this, il, unity: this.unity, inspect: (x) => this.inspect(x), version: VERSION };
  }

  fail(e) {
    console.error('[UnityExplorer]', e);
    this.status.setValue('Error');
    this.log(e.stack || String(e), 'error');
    const msg = h('div.ue-note.warn', { html: `<b>Couldn't attach to this game.</b><br>${String(e.message || e).replace(/</g, '&lt;')}<br><br>Open the <b>Status</b> tab and use <b>Copy diagnostics</b> to report it.` });
    for (const k of ['scene', 'classes', 'console']) this.tabs[k].page.replaceChildren(msg.cloneNode(true));
  }

  /** Open anything in the right place: GameObject, object pointer or type name. */
  inspect(x) {
    const { il, unity } = this;
    if (typeof x === 'string') {
      const td = il.findType(x);
      if (td < 0) throw new Error('type not found: ' + x);
      this.classes.reveal(td);
      return td;
    }
    if (typeof x === 'number' && x) {
      if (unity.td.GameObject >= 0 && il.tdOfKlass(il.klassOf(x)) === unity.td.GameObject) this.scene.select(x);
      else { this.focusTab('scene'); this.scene.inspector.show({ kind: 'obj', ptr: x }); }
      return hexAddr(x);
    }
    throw new Error('inspect() takes a type name or an object address');
  }

  _buildStatus() {
    const t = this.tabs.status;
    t.createSection('Status');
    this.status = t.createStat('State', 'Starting…');
    this.stats = {
      unity: t.createStat('Unity', '–'),
      meta: t.createStat('Metadata', '–'),
      types: t.createStat('Types / methods', '–'),
      modules: t.createStat('Code modules', '–'),
      layout: t.createStat('Class layout', '–'),
    };
    t.createSection('Log');
    this.logCtl = t.createLog('Explorer log', { height: 180, max: 300 });
    for (const l of this.logLines) this.logCtl.log(l.replace(/^\[\w+\] /, ''), 'info');
    const [a, b] = t.createColumns(2);
    a.createButton('Copy diagnostics', () => {
      const text = this.diagnostics();
      try { navigator.clipboard.writeText(text); this.ui.notify('Diagnostics copied', 'success'); } catch (_) { this.ui.prompt('Diagnostics', { value: text, multiline: true }); }
    });
    b.createButton('Refresh hierarchy', () => this.scene && this.scene.refresh());
  }

  _fillStatus() {
    const il = this.il;
    const uv = this._unityVersion();
    this.stats.unity.setValue(uv || 'unknown');
    this.stats.meta.setValue(`v${il.md.version} @ ${hexAddr(il.md.base)}`);
    this.stats.types.setValue(`${il.md.typeCount.toLocaleString()} / ${il.md.methodCount.toLocaleString()}`);
    this.stats.modules.setValue(String(il.reg.modules.size));
    const L = il.layout;
    this.stats.layout.setValue(`name@${L.name} parent@${L.parent} fields@${L.fields} static@${L.staticFields}`);
  }

  _unityVersion() {
    if (this._uv !== undefined) return this._uv;
    this._uv = null;
    try {
      const m = this.il.findMethod('UnityEngine.Application', 'get_unityVersion', 0);
      if (m) this._uv = this.il.call(m, 0);
    } catch (_) { /* ignore */ }
    if (!this._uv) {
      // the version string is embedded in the wasm data segment
      try {
        const mem = this.il.mem.views();
        const end = Math.min(this.il.reg.meta.addr + 0x400000, 64 << 20, mem.size);
        const text = new TextDecoder('latin1').decode(mem.u8.subarray(0, end));
        const counts = new Map();
        for (const x of text.matchAll(/\b(20[1-9]\d|6\d{3})\.\d{1,2}\.\d{1,3}[abfp]\d{1,2}\b/g)) counts.set(x[0], (counts.get(x[0]) || 0) + 1);
        this._uv = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
      } catch (_) { /* ignore */ }
    }
    return this._uv;
  }

  diagnostics() {
    const lines = [`Unity Explorer ${VERSION}`, `URL: ${location.origin}${location.pathname}`, `UA: ${navigator.userAgent}`];
    if (this.il) {
      const il = this.il;
      lines.push(`Unity: ${this._unityVersion()}`, `Metadata: v${il.md.version} types=${il.md.typeCount} methods=${il.md.methodCount} tdSize=${il.md.tdSize} mdSize=${il.md.mdSize}`,
        `Registrations: meta@${hexAddr(il.reg.meta.addr)} modules=${il.reg.modules.size}`, `Layout: ${JSON.stringify(il.layout)} classTable=${il.classTable ? hexAddr(il.classTable) : 'none'}`);
      if (this.unity) {
        const avail = Object.keys(this.unity.constructor.CANDIDATES).map((k) => `${k}:${this.unity.has(k) ? 'y' : 'n'}`).join(' ');
        lines.push(`Unity API: ${avail}`);
      }
    }
    lines.push('', ...this.logLines.slice(-60));
    return lines.join('\n');
  }

  _buildOptions() {
    const t = this.settingsTab;
    const save = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch (_) { /* ignore */ } };
    t.createSection('Inspector');
    const modes = ['Engine types only', 'All types', 'Never (click to get)'];
    const keys = ['engine', 'all', 'none'];
    t.createDropdown(modes, (v) => { this.settings.autoProps = keys[modes.indexOf(v)] || 'engine'; save(); }, { label: 'Evaluate properties automatically', selected: Math.max(0, keys.indexOf(this.settings.autoProps)), save: false })
      .setTooltip('Property getters run game code. Engine getters are safe; game getters may have side effects.');
    t.createToggle('Show property / event accessor methods', (v) => { this.settings.showAccessors = v; save(); }, this.settings.showAccessors, { save: false });
  }
}

// Only show up on pages that actually run a Unity WebGL build.
detectUnity().then(() => {
  const boot = () => {
    if (window.__unityExplorer) return;
    window.__unityExplorer = new App();
  };
  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot, { once: true });
});
