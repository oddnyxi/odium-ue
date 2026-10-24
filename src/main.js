// Unity Explorer for Unity WebGL (IL2CPP) games: entry point.
//
// The shared bootstrap goes first: it has to see the page's Unity loader, build files and
// WebAssembly compile happen (and shows the loading screen while they do).
import { getBootstrap, prepareIl2Cpp } from './bootstrap/index.js';
import { installHooks, EXPLORER_HOST_ID } from './hook.js';

const boot = getBootstrap();
installHooks();

import { UI } from './odium/index.js';
import { Il2Cpp } from './il2cpp/runtime.js';
import { UnityApi } from './il2cpp/unity.js';
import { ValueFormatter, hexAddr } from './il2cpp/values.js';
import { Interop } from './il2cpp/interop.js';
import { Completer } from './il2cpp/complete.js';
import { SceneView } from './ui/scene.js';
import { ClassesView } from './ui/classes.js';
import { ConsoleView } from './ui/console.js';
import { I } from './ui/icons.js';
import { h } from './ui/dom.js';
import css from 'bundle-text:./ui/explorer.css';
import { liveDump, liveMetadata, zip } from './dumper/live.js';
import { download as saveFile } from './dumper/zip.js';

const VERSION = '1.3.0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SETTINGS_KEY = 'unity-explorer:settings';

function loadSettings() {
  const def = { autoProps: 'engine', showAccessors: false };
  try { return { ...def, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch (_) { return def; }
}

class App {
  constructor(boot) {
    this.boot = boot;
    this.client = boot.client({ id: 'unity-explorer', name: 'Unity Explorer', version: VERSION, color: '#e11d2e', expectedSteps: 8 });
    this.settings = loadSettings();
    this.logLines = [];
    this.ui = new UI();
    this.ui.createWindow('UNITY EXPLORER', { subtitle: 'v' + VERSION, width: 1060, height: 680, toggleKey: 'F7' });
    boot.deferWindow(this.ui); // appears when the loading screen folds away
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

    this.status.setValue(boot.Module ? 'Game is starting…' : 'Waiting for the Unity game to load…');
    boot.whenModule().then(() => { if (!this.il) this.status.setValue('Game is starting…'); });
    boot.whenRuntime().then(() => this.start(boot.Module));
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

  // not async-returning the Module anywhere: on Unity 2018 – 2020 it's a thenable (see bootstrap/core.js)
  async start(Module) {
    this.Module = Module;
    const c = this.client;
    if (this.boot.state.unsupported) { const e = new Error(this.boot.state.unsupported); c.fail(e); this.fail(e); return; }
    this.status.setValue('Reading IL2CPP metadata…');
    let hints;
    try {
      const prep = c.step('prepare', 'Prepare the IL2CPP bridge');
      hints = await prepareIl2Cpp(this.boot, prep);
      prep.done(hints.fnTables ? `fastcomp build · ${hints.fnTables.size} per-signature function tables` : hints.flavor === 'fastcomp' ? 'fastcomp build · function tables unavailable' : 'LLVM build · direct function pointers');
    } catch (e) { c.fail(e); this.fail(e); return; }
    let il;
    for (let attempt = 0; ; attempt++) {
      try {
        il = new Il2Cpp(Module, (m) => this.log(m), hints);
        await il.initAsync(c);
        break;
      } catch (e) {
        // metadata is loaded a moment after the runtime starts on some builds; retry for a while
        if (attempt < 40 && /metadata not found/.test(e.message)) {
          c.step('metadata', 'Locate global-metadata.dat').wait(`not in memory yet, retrying (${attempt + 1})`);
          await sleep(1000);
          continue;
        }
        c.fail(e);
        this.fail(e);
        return;
      }
    }
    this.il = il;
    try {
      c.run('unity', 'Resolve the UnityEngine API', (note) => {
        this.unity = new UnityApi(il);
        const keys = Object.keys(UnityApi.CANDIDATES);
        note(`${keys.filter((k) => this.unity.has(k)).length}/${keys.length} engine methods available`);
      });
    } catch (e) {
      c.fail(e);
      this.fail(e);
      return;
    }
    this.fmt = new ValueFormatter(il, this.unity);
    this.interop = new Interop(il, this.unity, this.fmt);
    this.Il2Cpp = this.interop.api();
    this.completer = new Completer({ il, index: this.interop.index, api: this.Il2Cpp });
    const uv = this._unityVersion();
    this.boot.fact('Unity', uv);
    this.boot.fact('IL2CPP', `metadata v${il.md.versionLabel}`);

    try {
      c.run('ui', 'Build the explorer views', (note) => {
        this.scene = new SceneView(this);
        this.classes = new ClassesView(this, this.scene);
        this.console = new ConsoleView(this);
        this.tabs.scene.page.replaceChildren(this.scene.el);
        this.tabs.classes.page.replaceChildren(this.classes.el);
        this.tabs.console.page.replaceChildren(this.console.el);
        this.classes.load();
        this.scene.refresh();
        note('Scene, Classes, Console');
      });
    } catch (e) {
      c.fail(e);
      this.fail(e);
      return;
    }
    this._fillStatus();
    this.status.setValue('Ready');
    c.ready(`${il.md.typeCount.toLocaleString()} types · press F7`);
    this.ui.notify('Unity Explorer ready · F7 to toggle', 'success', 2500);

    window.UnityExplorer = { app: this, il, unity: this.unity, inspect: (x) => this.inspect(x), version: VERSION, bootstrap: this.boot };
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
    t.createSection('Bootstrap');
    this.bootStats = {
      loader: t.createStat('Loader', '–'),
      wasm: t.createStat('WebAssembly', '–'),
      timing: t.createStat('Boot time', '–'),
    };
    const [ba, bb] = t.createColumns(2);
    ba.createButton('Show loading screen', () => this.boot.ui && this.boot.ui.reopen());
    bb.createButton('Copy bootstrap report', () => {
      const text = this.boot.report();
      try { navigator.clipboard.writeText(text); this.ui.notify('Bootstrap report copied', 'success'); } catch (_) { this.ui.prompt('Bootstrap report', { value: text, multiline: true }); }
    });
    this.boot.on(() => this._fillBoot());

    t.createSection('Log');
    this.logCtl = t.createLog('Explorer log', { height: 180, max: 300 });
    for (const l of this.logLines) this.logCtl.log(l.replace(/^\[\w+\] /, ''), 'info');
    const [a, b] = t.createColumns(2);
    a.createButton('Copy diagnostics', () => {
      const text = this.diagnostics();
      try { navigator.clipboard.writeText(text); this.ui.notify('Diagnostics copied', 'success'); } catch (_) { this.ui.prompt('Diagnostics', { value: text, multiline: true }); }
    });
    b.createButton('Refresh hierarchy', () => this.scene && this.scene.refresh());

    t.createSection('Dump');
    t.createLabel('dump.cs, a .wasm with C# function names (DevTools, Ghidra), script.json, methods.json and global-metadata.dat, as one zip. The same output as Odium Dumper, from the running game.');
    let named = true;
    t.createToggle('Named .wasm (downloads the game\'s wasm again)', (v) => { named = v; }, true, { save: false });
    const [c, d] = t.createColumns(2);
    let busy = false;
    c.createButton('Dump game (.zip)', async () => {
      if (!this.il || busy) return;
      busy = true;
      const t0 = performance.now();
      this.ui.notify('Dumping… the game may pause for a few seconds', 'info', 3000);
      try {
        const r = await liveDump(this.il, { named, log: (m) => this.log(m), wasmBytes: this.boot.wasmBytes || null });
        let product = '';
        try { product = this.il.call(this.il.findMethod('UnityEngine.Application', 'get_productName', 0), 0) || ''; } catch (_) { /* stripped */ }
        product = product || document.title || location.hostname || 'game';
        saveFile(`${String(product).replace(/[^\w.-]+/g, '_')}-dump.zip`, zip(r.files), 'application/zip');
        this.ui.notify(`Dumped ${r.summary.types.toLocaleString()} types in ${((performance.now() - t0) / 1000).toFixed(1)} s${r.wasm ? '' : ' (wasm unavailable: no function names)'}`, 'success', 5000);
      } catch (e) {
        this.ui.notify('Dump failed: ' + (e.message || e), 'error');
      } finally { busy = false; }
    });
    d.createButton('global-metadata.dat', () => { if (this.il) saveFile('global-metadata.dat', liveMetadata(this.il)); });
  }

  _fillBoot() {
    if (!this.bootStats || this._bootT) return;
    this._bootT = setTimeout(() => {
      this._bootT = null;
      const b = this.boot; const s = b.state; const w = s.wasm;
      this.bootStats.loader.setValue(s.loader ? `${s.loader.label} · ${s.loader.era}` : '–');
      this.bootStats.wasm.setValue(w ? `${w.bytes ? (w.bytes / 1048576).toFixed(1) + ' MB · ' : ''}${w.flavor === 'fastcomp' ? 'fastcomp' : 'LLVM'}${w.ms != null ? ' · ' + Math.round(w.ms) + ' ms' : ''}` : 'not seen (attached late)');
      this.bootStats.timing.setValue(b.finishedAt != null ? `${(b.finishedAt / 1000).toFixed(2)} s from document-start` : s.runtime && s.runtime.startedAt != null ? `runtime at ${(s.runtime.startedAt / 1000).toFixed(2)} s` : 'loading…');
    }, 250);
  }

  _fillStatus() {
    const il = this.il;
    const uv = this._unityVersion();
    this.stats.unity.setValue(uv || 'unknown');
    this.stats.meta.setValue(`v${il.md.versionLabel} @ ${hexAddr(il.md.base)}`);
    this.stats.types.setValue(`${il.md.typeCount.toLocaleString()} / ${il.md.methodCount.toLocaleString()}`);
    this.stats.modules.setValue(il.reg.flat ? `flat table (${il.reg.flat.count})` : String(il.reg.modules.size));
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
      lines.push(`Unity: ${this._unityVersion()}`, `Metadata: v${il.md.versionLabel} types=${il.md.typeCount} methods=${il.md.methodCount} tdSize=${il.md.tdSize} mdSize=${il.md.mdSize}`,
        `Registrations: meta@${hexAddr(il.reg.meta.addr)} modules=${il.reg.modules.size}${il.reg.flat ? ` flat=${il.reg.flat.count}` : ''}`, `Layout: ${JSON.stringify(il.layout)} classTable=${il.classTable ? hexAddr(il.classTable) : 'none'}`,
        `ABI: ${il.flavor} i64=${il.i64Mode} byrefBit=${il.byrefBit} fnTables=${il.fnTables ? il.fnTables.size : 'none'} sigs=${il.sigs ? il.sigs.count : 'none'}`);
      if (this.unity) {
        const avail = Object.keys(this.unity.constructor.CANDIDATES).map((k) => `${k}:${this.unity.has(k) ? 'y' : 'n'}`).join(' ');
        lines.push(`Unity API: ${avail}`);
      }
    }
    lines.push('', ...this.logLines.slice(-60));
    lines.push('', '---', this.boot.report());
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
    t.createSection('Loading screen');
    const lmodes = ['Full screen', 'Corner card', 'Off'];
    const lkeys = ['full', 'compact', 'off'];
    t.createDropdown(lmodes, (v) => this.boot.saveSettings({ modal: lkeys[lmodes.indexOf(v)] || 'full' }), { label: 'Bootstrap loading screen', selected: Math.max(0, lkeys.indexOf(this.boot.settings.modal)), save: false })
      .setTooltip('Shown while the game loads, with download, compile and IL2CPP details. Shared with BananaLoader.');
    t.createToggle('Hide it automatically when everything is ready', (v) => this.boot.saveSettings({ autoHide: v }), this.boot.settings.autoHide !== false, { save: false });
  }
}

// Only show up on pages that actually run a Unity WebGL build.
boot.whenDetected().then(() => {
  const start = () => {
    if (window.__unityExplorer) return;
    try {
      window.__unityExplorer = new App(boot);
    } catch (e) {
      console.error('[UnityExplorer] UI failed', e);
      boot.client({ id: 'unity-explorer', name: 'Unity Explorer', version: VERSION }).fail(e);
    }
  };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
});
