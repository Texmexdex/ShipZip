/* ShipZip — zip in, website out. */
(function () {
  'use strict';
  const C = window.ShipZipCore;
  const $ = sel => document.querySelector(sel);

  // ---------- settings ----------
  const KEY = 'shipzip.v1';
  function load() { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { return {}; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* storage unavailable */ } }
  let S = load();
  function devBase(name, fallback) { try { return localStorage.getItem('shipzip.dev.' + name) || fallback; } catch (e) { return fallback; } }
  const GH = devBase('github', 'https://api.github.com');
  const ION_DEFAULT = 'https://api.hosting.ionos.com/dns/v1';
  const ionBase = () => (S.ionosBase || devBase('ionos', ION_DEFAULT)).replace(/\/+$/, '');

  // ---------- log ----------
  function log(msg, kind) {
    const li = document.createElement('li');
    li.className = kind || '';
    const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    li.textContent = t + '  ' + msg;
    $('#log').prepend(li);
  }
  function toast(msg, kind) {
    const el = $('#toast');
    el.textContent = msg; el.className = 'show ' + (kind || '');
    clearTimeout(toast._t); toast._t = setTimeout(() => { el.className = ''; }, 4000);
  }

  // ---------- GitHub API ----------
  class ApiError extends Error {
    constructor(msg, status, extra) { super(msg); this.status = status; this.extra = extra || {}; }
  }
  async function gh(path, opts) {
    const o = opts || {};
    let res;
    try {
      res = await fetch(GH + path, {
        method: o.method || 'GET',
        headers: {
          'Accept': 'application/vnd.github+json',
          'Authorization': 'Bearer ' + S.ghToken,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(o.body ? { 'Content-Type': 'application/json' } : {})
        },
        body: o.body ? JSON.stringify(o.body) : undefined
      });
    } catch (e) {
      throw new ApiError('Could not reach GitHub. Check the internet connection.', 0);
    }
    if (res.status === 204) return null;
    let data = null;
    const text = await res.text();
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = { message: text }; }
    if (!res.ok) {
      const need = res.headers.get('X-Accepted-GitHub-Permissions');
      let msg = (data && data.message) || ('GitHub error ' + res.status);
      if (data && data.errors && data.errors.length) msg += ' — ' + data.errors.map(x => x.message || x.code).join('; ');
      if (res.status === 401) msg = 'GitHub rejected the token. It may be expired or mistyped.';
      if (res.status === 403 && need) msg += ' (the token is missing a permission: ' + need + ')';
      throw new ApiError(msg, res.status, { data, need });
    }
    return data;
  }

  async function ghUser() { return gh('/user'); }

  async function getRepo() {
    try { return await gh(`/repos/${S.ghUser}/${S.repo}`); }
    catch (e) { if (e.status === 404) return null; throw e; }
  }

  async function ensureRepo() {
    let repo = await getRepo();
    if (!repo) {
      log('Creating repository ' + S.repo + '…');
      repo = await gh('/user/repos', {
        method: 'POST',
        body: { name: S.repo, description: 'Website deployed with ShipZip', private: false, auto_init: true, has_issues: false, has_wiki: false }
      });
      log('Repository created.', 'ok');
    }
    if (repo.private) log('Note: this repository is private. Free GitHub accounts can only publish Pages from public repositories.', 'warn');
    return repo;
  }

  async function headOf(branch) {
    for (let i = 0; i < 6; i++) {
      try {
        const ref = await gh(`/repos/${S.ghUser}/${S.repo}/git/ref/heads/${encodeURIComponent(branch)}`);
        return ref.object.sha;
      } catch (e) {
        if (e.status === 409) { // empty repository: seed it so the Git Data API works
          log('Repository is empty, adding a first file…');
          await gh(`/repos/${S.ghUser}/${S.repo}/contents/README.md`, {
            method: 'PUT', body: { message: 'Initial commit', content: C.bytesToBase64(new TextEncoder().encode('# ' + S.repo + '\n')), branch }
          });
          continue;
        }
        if (e.status === 404 && i < 5) { await sleep(1500); continue; } // auto_init can lag a moment
        throw e;
      }
    }
    throw new ApiError('Could not find the branch "' + branch + '".', 404);
  }

  async function commitSite(files, branch, message, onProgress) {
    const base = `/repos/${S.ghUser}/${S.repo}/git`;
    const parent = await headOf(branch);
    const tree = new Array(files.length);
    let done = 0;
    let next = 0;
    async function worker() {
      while (next < files.length) {
        const i = next++;
        const f = files[i];
        let blob;
        for (let attempt = 0; ; attempt++) {
          try {
            blob = await gh(base + '/blobs', { method: 'POST', body: { content: C.bytesToBase64(f.data), encoding: 'base64' } });
            break;
          } catch (e) {
            if (attempt < 2 && (e.status === 0 || e.status >= 500 || e.status === 403 && /secondary rate/i.test(e.message))) { await sleep(2000 * (attempt + 1)); continue; }
            throw e;
          }
        }
        tree[i] = { path: f.path, mode: '100644', type: 'blob', sha: blob.sha };
        done++; onProgress(done, files.length);
      }
    }
    await Promise.all([worker(), worker(), worker(), worker()]);
    const t = await gh(base + '/trees', { method: 'POST', body: { tree } }); // no base_tree: the zip replaces the whole site
    const commit = await gh(base + '/commits', { method: 'POST', body: { message, tree: t.sha, parents: [parent] } });
    await gh(base + '/refs/heads/' + encodeURIComponent(branch), { method: 'PATCH', body: { sha: commit.sha, force: false } });
    return commit;
  }

  async function getPages() {
    try { return await gh(`/repos/${S.ghUser}/${S.repo}/pages`); }
    catch (e) { if (e.status === 404) return null; throw e; }
  }

  async function ensurePages(branch) {
    let p = await getPages();
    if (!p) {
      log('Turning on GitHub Pages…');
      try {
        p = await gh(`/repos/${S.ghUser}/${S.repo}/pages`, { method: 'POST', body: { build_type: 'legacy', source: { branch, path: '/' } } });
      } catch (e) {
        if (e.status !== 409) throw e;
        p = await getPages();
      }
      log('GitHub Pages is on.', 'ok');
    } else if (p.build_type === 'legacy' && p.source && (p.source.branch !== branch || p.source.path !== '/')) {
      await gh(`/repos/${S.ghUser}/${S.repo}/pages`, { method: 'PUT', body: { build_type: 'legacy', source: { branch, path: '/' } } });
      log('Pointed GitHub Pages at ' + branch + ' /.', 'ok');
    } else if (p.build_type === 'workflow') {
      log('This repository publishes Pages with its own GitHub Actions workflow. ShipZip leaves that alone; your workflow decides what gets published.', 'warn');
    }
    return p;
  }

  async function setPagesDomain(domain) {
    await gh(`/repos/${S.ghUser}/${S.repo}/pages`, { method: 'PUT', body: { cname: domain || null } });
  }

  // ---------- IONOS DNS API ----------
  async function ion(path, opts) {
    const o = opts || {};
    let res;
    try {
      res = await fetch(ionBase() + path, {
        method: o.method || 'GET',
        headers: { 'Accept': 'application/json', 'X-API-Key': S.ionosKey, ...(o.body ? { 'Content-Type': 'application/json' } : {}) },
        body: o.body ? JSON.stringify(o.body) : undefined
      });
    } catch (e) {
      throw new ApiError('The browser could not talk to the IONOS API directly (most likely IONOS does not allow calls from web pages). Use the manual records below, or set up the small proxy described in the README.', 0, { cors: true });
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = { message: text }; }
    if (!res.ok) {
      let msg = Array.isArray(data) && data[0] ? (data[0].message || data[0].code) : (data && data.message) || ('IONOS error ' + res.status);
      if (res.status === 401) msg = 'IONOS rejected the API key. It should look like prefix.secret.';
      throw new ApiError(msg, res.status, { data });
    }
    return data;
  }

  async function findZone(domain) {
    const zones = await ion('/zones');
    const z = (zones || []).filter(z => domain === z.name || domain.endsWith('.' + z.name))
      .sort((a, b) => b.name.length - a.name.length)[0];
    if (!z) throw new ApiError('This IONOS account has no DNS zone for ' + domain + '. Zones found: ' + ((zones || []).map(z => z.name).join(', ') || 'none'), 404);
    return z;
  }

  // ---------- DNS lookups (public resolvers, read-only) ----------
  async function resolve(name, type) {
    const tries = [
      () => fetch(`https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${type}`, { cache: 'no-store' }),
      () => fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, { headers: { accept: 'application/dns-json' }, cache: 'no-store' })
    ];
    for (const t of tries) {
      try {
        const r = await t();
        if (!r.ok) continue;
        const j = await r.json();
        const code = { A: 1, CNAME: 5, TXT: 16, AAAA: 28 }[type];
        return (j.Answer || []).filter(a => a.type === code).map(a => String(a.data).replace(/\.$/, '').replace(/^"|"$/g, '').toLowerCase());
      } catch (e) { /* try the next resolver */ }
    }
    return null;
  }

  // ---------- helpers ----------
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v);
    }
    for (const k of kids) if (k != null) e.append(k.nodeType ? k : document.createTextNode(String(k)));
    return e;
  }
  function siteUrl() {
    if (S.domain && S.domainLive) return 'https://' + S.domain + '/';
    if (S.repo && S.ghUser && S.repo.toLowerCase() === S.ghUser.toLowerCase() + '.github.io') return 'https://' + S.repo.toLowerCase() + '/';
    return 'https://' + (S.ghUser || 'you').toLowerCase() + '.github.io/' + (S.repo || '') + '/';
  }
  function busy(btn, on, label) {
    if (!btn) return;
    if (on) { btn.dataset.label = btn.textContent; btn.textContent = label || 'Working…'; btn.disabled = true; }
    else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; }
  }
  function copyBtn(text) {
    return el('button', { class: 'copy', type: 'button', onclick: async (ev) => {
      try { await navigator.clipboard.writeText(text); ev.target.textContent = 'Copied'; setTimeout(() => ev.target.textContent = 'Copy', 1500); }
      catch (e) { toast('Copy failed — long-press the value instead'); }
    } }, 'Copy');
  }

  let editingSetup = false;
  // ---------- rendering ----------
  function render() {
    const connected = !!(S.ghToken && S.ghUser);
    $('#gh-status').textContent = connected ? 'Connected as ' + S.ghUser : 'Not connected';
    $('#gh-status').className = 'pill ' + (connected ? 'ok' : '');
    $('#gh-token').value = S.ghToken || '';
    $('#repo').value = S.repo || '';
    $('#domain').value = S.domain || '';
    $('#ionos-key').value = S.ionosKey || '';
    $('#ionos-base').value = S.ionosBase || '';
    const siteReady = connected && S.repo;
    $('#step-site').classList.toggle('locked', !connected);
    $('#step-deploy').classList.toggle('locked', !siteReady);
    $('#step-domain').classList.toggle('hidden', !S.domain);
    $('#site-link').innerHTML = '';
    if (S.lastDeploy) {
      $('#site-link').append(el('a', { href: siteUrl(), target: '_blank', rel: 'noopener' }, siteUrl()),
        el('span', { class: 'muted' }, ' · last deploy ' + new Date(S.lastDeploy).toLocaleString()));
    }
    renderManualRecords();
    document.body.classList.toggle('setup-collapsed', !!(siteReady && S.setupSaved && !editingSetup));
    $('#sum-user').textContent = S.ghUser || '';
    $('#sum-repo').textContent = S.repo || '';
    $('#sum-domain').textContent = S.domain || 'none (github.io address)';
    $('#sum-ionos').textContent = S.ionosKey ? 'saved on this phone' : (S.domain ? 'not set — manual DNS' : '—');
    if (connected && !siteReady) $('#step-site').scrollIntoView({ block: 'start' });
  }

  function renderManualRecords() {
    const box = $('#manual-records');
    box.innerHTML = '';
    if (!S.domain || !S.ghUser) return;
    const rows = C.desiredRecords(S.domain, S.ghUser);
    const tbl = el('table', { class: 'records' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Type'), el('th', {}, 'Host name'), el('th', {}, 'Points to'), el('th', {}, ''))));
    const tb = el('tbody');
    for (const r of rows) {
      const host = r.name === S.domain ? '@' : 'www';
      tb.append(el('tr', {}, el('td', {}, r.type), el('td', {}, host), el('td', { class: 'mono' }, r.content), el('td', {}, copyBtn(r.content))));
    }
    tbl.append(tb);
    box.append(tbl);
  }

  // ---------- step 1: GitHub ----------
  async function connectGitHub(ev) {
    const btn = ev && ev.target;
    const token = $('#gh-token').value.trim();
    if (!token) { toast('Paste the GitHub token first'); return; }
    S.ghToken = token;
    busy(btn, true, 'Checking…');
    try {
      const u = await ghUser();
      S.ghUser = u.login; save();
      log('Connected to GitHub as ' + u.login + '.', 'ok');
      await fillRepoList();
    } catch (e) {
      S.ghUser = null; save();
      log(e.message, 'err'); toast(e.message, 'err');
    } finally { busy(btn, false); render(); }
  }

  async function fillRepoList() {
    try {
      const repos = await gh('/user/repos?per_page=100&sort=updated&affiliation=owner');
      const dl = $('#repo-list'); dl.innerHTML = '';
      for (const r of repos) dl.append(el('option', { value: r.name }));
    } catch (e) { /* the list is only a convenience */ }
  }

  // ---------- step 2: site ----------
  function saveSite() {
    const domRaw = $('#domain').value.trim();
    const repo = $('#repo').value.trim() || C.suggestRepoName(domRaw);
    const domain = C.normalizeDomain(domRaw);
    if (!C.validRepoName(repo)) { toast('Site name can use letters, numbers, dots, dashes and underscores'); return; }
    if (domain && !C.isValidDomain(domain)) { toast('That domain does not look right, e.g. example.com'); return; }
    if (S.domain !== domain) S.domainLive = false;
    S.repo = repo; S.domain = domain;
    S.ionosKey = $('#ionos-key').value.trim();
    S.ionosBase = $('#ionos-base').value.trim();
    S.setupSaved = true; editingSetup = false;
    save(); render();
    log('Saved: site "' + repo + '"' + (domain ? ', domain ' + domain : ', no custom domain') + '.', 'ok');
    toast('Saved');
  }

  // ---------- step 3: deploy ----------
  let pending = null; // { name, report, links }

  async function readZip(file) {
    if (!/\.zip$/i.test(file.name) && !/zip/.test(file.type)) {
      toast('That is not a .zip file'); return;
    }
    $('#report').innerHTML = '';
    $('#deploy-btn').disabled = true;
    try {
      const zip = await JSZip.loadAsync(file);
      const files = [];
      const entries = Object.values(zip.files).filter(f => !f.dir);
      for (const f of entries) files.push({ path: f.name, data: await f.async('uint8array') });
      const report = C.normalizeSite(files, { domain: S.domain });
      const links = S.domain ? [] : C.findRootAbsoluteLinks(report.files);
      pending = { name: file.name, report, links };
      showReport();
    } catch (e) {
      pending = null;
      log('Could not open the zip: ' + e.message, 'err'); toast('Could not open that zip', 'err');
    }
  }

  function showReport() {
    const box = $('#report'); box.innerHTML = '';
    if (!pending) return;
    const r = pending.report;
    const realFiles = r.files.filter(f => f.path !== '.nojekyll' && f.path !== 'CNAME');
    box.append(el('p', { class: 'summary' },
      el('strong', {}, pending.name), ' — ' + realFiles.length + ' files, ' + C.fmtBytes(r.totalBytes)));
    if (r.root) box.append(el('p', { class: 'note' }, 'Unwrapped the "' + r.root.replace(/\/$/, '') + '" folder so index.html sits at the top.'));
    if (r.dropped.length) box.append(el('p', { class: 'note' }, 'Skipped ' + r.dropped.length + ' junk file(s) (like __MACOSX or .DS_Store).'));
    for (const w of r.warnings) box.append(el('p', { class: 'warn' }, w));
    if (pending.links.length) {
      box.append(el('p', { class: 'warn' }, 'Some links start with "/" (for example ' + pending.links[0].link + ' in ' + pending.links[0].file + '). They will break at the temporary github.io address but work fine once a custom domain is connected.'));
    }
    for (const e of r.errors) box.append(el('p', { class: 'err' }, e));
    const details = el('details', {}, el('summary', {}, 'Show files'));
    const ul = el('ul', { class: 'files' });
    for (const f of realFiles.slice(0, 300)) ul.append(el('li', {}, f.path + '  ', el('span', { class: 'muted' }, C.fmtBytes(f.data.length))));
    if (realFiles.length > 300) ul.append(el('li', { class: 'muted' }, '…and ' + (realFiles.length - 300) + ' more'));
    details.append(ul); box.append(details);
    $('#deploy-btn').disabled = r.errors.length > 0;
  }

  async function deploy(ev) {
    if (!pending || pending.report.errors.length) return;
    const btn = ev.target;
    busy(btn, true, 'Deploying…');
    const bar = $('#progress'); bar.hidden = false; bar.value = 0;
    try {
      // Rebuild control files in case the domain changed after the zip was opened.
      const files = C.normalizeSite(pending.report.files.filter(f => f.path !== 'CNAME' && f.path !== '.nojekyll'), { domain: S.domain }).files;
      const repo = await ensureRepo();
      const branch = repo.default_branch || 'main';
      const n = (S.deployCount || 0) + 1;
      log('Uploading ' + files.length + ' files…');
      await commitSite(files, branch, 'Deploy #' + n + ' from ' + pending.name + ' (ShipZip)', (d, t) => { bar.max = t; bar.value = d; });
      log('Deploy #' + n + ' committed.', 'ok');
      await ensurePages(branch);
      if (S.domain) {
        const p = await getPages();
        if (!p || (p.cname || '') !== S.domain) {
          log('Telling GitHub Pages about ' + S.domain + '…');
          await setPagesDomain(S.domain);
          log('GitHub Pages will answer for ' + S.domain + '.', 'ok');
        }
      }
      S.deployCount = n; S.lastDeploy = Date.now(); save();
      toast('Deployed! GitHub usually takes about a minute to publish.', 'ok');
      log('GitHub is publishing now — usually under a minute. ' + siteUrl(), 'ok');
      pending = null; $('#report').innerHTML = ''; $('#zip').value = '';
      render();
      if (S.domain) { $('#step-domain').scrollIntoView({ behavior: 'smooth' }); checkStatus(); }
    } catch (e) {
      log('Deploy failed: ' + e.message, 'err'); toast('Deploy failed — see the log', 'err');
    } finally { busy(btn, false); bar.hidden = true; $('#deploy-btn').disabled = !pending; }
  }

  // ---------- step 4: domain ----------
  let dnsPlan = null;

  async function planDomain(ev) {
    if (!S.ionosKey) { toast('Add the IONOS API key in Setup, or use the manual records'); return; }
    const btn = ev.target;
    busy(btn, true, 'Reading IONOS…');
    const box = $('#dns-plan'); box.innerHTML = '';
    try {
      const pages = await getPages();
      if (!pages || pages.cname !== S.domain) {
        // GitHub's own advice: claim the domain on GitHub before pointing DNS at it.
        box.append(el('p', { class: 'warn' }, 'Deploy the site once first, so GitHub has claimed ' + S.domain + ' before DNS points at it.'));
        return;
      }
      const zone = await findZone(S.domain);
      const full = await ion('/zones/' + zone.id);
      dnsPlan = { zone, ...C.planDns(full.records || [], S.domain, S.ghUser) };
      if (!dnsPlan.remove.length && !dnsPlan.add.length) {
        box.append(el('p', { class: 'ok' }, 'IONOS already has exactly the right records. Nothing to change.'));
        return;
      }
      if (dnsPlan.remove.length) {
        box.append(el('h4', {}, 'Will delete (these would fight with GitHub):'));
        const ul = el('ul', { class: 'rec del' });
        for (const r of dnsPlan.remove) ul.append(el('li', {}, r.type + '  ' + r.name + '  →  ' + r.content));
        box.append(ul);
      }
      if (dnsPlan.add.length) {
        box.append(el('h4', {}, 'Will add:'));
        const ul = el('ul', { class: 'rec add' });
        for (const r of dnsPlan.add) ul.append(el('li', {}, r.type + '  ' + r.name + '  →  ' + r.content));
        box.append(ul);
      }
      box.append(el('p', { class: 'muted' }, 'Email (MX), TXT and other subdomains are not touched.'));
      box.append(el('button', { class: 'primary', type: 'button', onclick: applyDomain }, 'Apply these changes'));
    } catch (e) {
      log(e.message, 'err');
      box.append(el('p', { class: 'err' }, e.message));
      if (e.extra && e.extra.cors) $('#manual').open = true;
    } finally { busy(btn, false); }
  }

  async function applyDomain(ev) {
    if (!dnsPlan) return;
    const btn = ev.target;
    busy(btn, true, 'Updating DNS…');
    try {
      for (const r of dnsPlan.remove) {
        await ion('/zones/' + dnsPlan.zone.id + '/records/' + r.id, { method: 'DELETE' });
        log('Deleted ' + r.type + ' ' + r.name + ' → ' + r.content);
      }
      if (dnsPlan.add.length) {
        await ion('/zones/' + dnsPlan.zone.id + '/records', {
          method: 'POST', body: dnsPlan.add.map(r => ({ name: r.name, type: r.type, content: r.content, ttl: 3600, prio: 0, disabled: false }))
        });
        log('Added ' + dnsPlan.add.length + ' record(s) for GitHub Pages.', 'ok');
      }
      $('#dns-plan').innerHTML = '';
      $('#dns-plan').append(el('p', { class: 'ok' }, 'DNS updated. It can take a few minutes to an hour to spread. The checklist below updates on its own.'));
      dnsPlan = null;
      startPolling();
    } catch (e) {
      log('DNS update stopped: ' + e.message + ' — tap "Check IONOS" again to see where it got to.', 'err');
      toast('DNS update failed — see the log', 'err');
    } finally { busy(btn, false); }
  }

  async function addVerifyTxt(ev) {
    const value = $('#verify-value').value.trim();
    if (!value) { toast('Paste the TXT value from GitHub first'); return; }
    if (!S.ionosKey) { toast('Needs the IONOS API key — or add it by hand in IONOS'); return; }
    const btn = ev.target; busy(btn, true, 'Adding…');
    try {
      const zone = await findZone(S.domain);
      const name = '_github-pages-challenge-' + S.ghUser.toLowerCase() + '.' + S.domain;
      await ion('/zones/' + zone.id + '/records', { method: 'POST', body: [{ name, type: 'TXT', content: value, ttl: 3600, prio: 0, disabled: false }] });
      log('Added verification TXT record ' + name + '. Now tap Verify on GitHub (it may take a few minutes).', 'ok');
      toast('Added — now tap Verify on GitHub', 'ok');
    } catch (e) { log(e.message, 'err'); toast(e.message, 'err'); }
    finally { busy(btn, false); }
  }

  // ---------- status checklist ----------
  let pollTimer = null; let pollUntil = 0;
  function startPolling() {
    pollUntil = Date.now() + 15 * 60 * 1000;
    clearInterval(pollTimer);
    checkStatus();
    pollTimer = setInterval(() => { if (Date.now() > pollUntil) clearInterval(pollTimer); else if (!document.hidden) checkStatus(); }, 20000);
  }

  function setCheck(id, state, text) {
    const li = $('#' + id);
    li.className = state; // ok | wait | bad
    li.querySelector('.detail').textContent = text || '';
  }

  async function checkStatus() {
    if (!S.ghUser || !S.repo) return;
    try {
      const p = await getPages();
      if (!p) { setCheck('chk-pages', 'wait', 'Not turned on yet — deploy once.'); return; }
      let build = null;
      try { build = await gh(`/repos/${S.ghUser}/${S.repo}/pages/builds/latest`); } catch (e) { /* no build yet */ }
      const bs = build && build.status;
      setCheck('chk-pages', bs === 'built' ? 'ok' : bs === 'errored' ? 'bad' : 'wait',
        bs === 'built' ? 'Published.' : bs === 'errored' ? 'Build failed: ' + ((build.error && build.error.message) || 'see the repository on GitHub') : 'Publishing…');
      if (!S.domain) return;
      setCheck('chk-claim', p.cname === S.domain ? 'ok' : 'wait', p.cname === S.domain ? 'GitHub has ' + S.domain + ' on this site.' : 'Deploy once to claim it.');

      const a = await resolve(S.domain, 'A');
      if (a === null) setCheck('chk-apex', 'wait', 'Could not reach a DNS checker.');
      else {
        const good = a.filter(ip => C.GITHUB_PAGES_A.includes(ip));
        const bad = a.filter(ip => !C.GITHUB_PAGES_A.includes(ip));
        setCheck('chk-apex', good.length && !bad.length ? 'ok' : bad.length ? 'bad' : 'wait',
          good.length && !bad.length ? 'Points to GitHub.' : bad.length ? 'Still points somewhere else too: ' + bad.join(', ') + ' — remove those in IONOS.' : 'Not visible yet.');
      }
      const w = await resolve('www.' + S.domain, 'CNAME');
      const want = S.ghUser.toLowerCase() + '.github.io';
      if (w === null) setCheck('chk-www', 'wait', 'Could not reach a DNS checker.');
      else setCheck('chk-www', w.includes(want) ? 'ok' : w.length ? 'bad' : 'wait', w.includes(want) ? 'Points to ' + want + '.' : w.length ? 'Points to ' + w.join(', ') + ' instead of ' + want + '.' : 'Not visible yet.');

      const cert = p.https_certificate && p.https_certificate.state;
      if (p.https_enforced) setCheck('chk-https', 'ok', 'HTTPS is on.');
      else if (cert === 'approved') {
        try {
          await gh(`/repos/${S.ghUser}/${S.repo}/pages`, { method: 'PUT', body: { https_enforced: true } });
          setCheck('chk-https', 'ok', 'Certificate issued, HTTPS turned on.');
          log('HTTPS turned on for ' + S.domain + '.', 'ok');
        } catch (e) { setCheck('chk-https', 'wait', 'Certificate issued; turning on HTTPS failed: ' + e.message); }
      } else setCheck('chk-https', cert === 'errored' || cert === 'bad_authz' ? 'bad' : 'wait',
        cert ? 'Certificate: ' + cert.replace(/_/g, ' ') + '.' : 'Waits until DNS points to GitHub.');

      const allOk = ['chk-pages', 'chk-claim', 'chk-apex', 'chk-www', 'chk-https'].every(id => $('#' + id).className === 'ok');
      if (allOk && !S.domainLive) { S.domainLive = true; save(); render(); log(S.domain + ' is live!', 'ok'); toast(S.domain + ' is live!', 'ok'); clearInterval(pollTimer); }
    } catch (e) { log('Status check: ' + e.message, 'err'); }
  }

  // ---------- shared zips (Android share sheet) ----------
  async function takeSharedFile() {
    const params = new URLSearchParams(location.search);
    if (!params.has('shared')) return;
    history.replaceState(null, '', location.pathname);
    try {
      const cache = await caches.open('shipzip-share');
      const res = await cache.match('shared-file');
      if (!res) { if (params.get('shared') === 'none') toast('Nothing was shared — pick the zip below'); return; }
      const name = decodeURIComponent(res.headers.get('X-File-Name') || 'shared.zip');
      const blob = await res.blob();
      await cache.delete('shared-file');
      const file = new File([blob], name, { type: blob.type || 'application/zip' });
      log('Received ' + name + ' from the share sheet.');
      if (S.ghUser && S.repo) { await readZip(file); $('#step-deploy').scrollIntoView({ behavior: 'smooth' }); }
      else toast('Finish setup first, then share the zip again');
    } catch (e) { log('Could not read the shared file: ' + e.message, 'err'); }
  }

  // ---------- platform (iPhone vs Android) ----------
  const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const IS_ANDROID = /Android/i.test(navigator.userAgent);
  const STANDALONE = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;

  function setupPlatform() {
    const tip = $('#zip-tip');
    if (IS_IOS) {
      tip.innerHTML = 'On iPhone: in the app that made the zip, tap <strong>Share → Save to Files</strong>. Then tap the button above and pick it from Files (usually in <strong>Downloads</strong> or <strong>Recents</strong>).';
      let skipped = false;
      try { skipped = sessionStorage.getItem('shipzip.installSkip') === '1'; } catch (e) {}
      if (!STANDALONE && !skipped) $('#install').hidden = false;
      $('#install-skip').addEventListener('click', () => {
        try { sessionStorage.setItem('shipzip.installSkip', '1'); } catch (e) {}
        $('#install').hidden = true;
      });
    } else if (IS_ANDROID) {
      tip.innerHTML = 'Tip: install ShipZip from Chrome\'s menu (⋮ → Install app), then use <strong>Share → ShipZip</strong> on any zip.';
    } else {
      tip.textContent = 'You can also drag the zip onto this button.';
    }
  }

  // ---------- wiring ----------
  function forget() {
    if (!confirm('Remove the saved GitHub token, IONOS key and settings from this phone?')) return;
    try { localStorage.removeItem(KEY); } catch (e) {}
    S = {}; render(); log('Everything saved on this phone was removed.', 'ok');
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('#gh-connect').addEventListener('click', connectGitHub);
    $('#site-save').addEventListener('click', saveSite);
    $('#zip').addEventListener('change', e => { if (e.target.files[0]) readZip(e.target.files[0]); });
    $('#deploy-btn').addEventListener('click', deploy);
    $('#dns-check').addEventListener('click', planDomain);
    $('#status-check').addEventListener('click', () => startPolling());
    $('#verify-add').addEventListener('click', addVerifyTxt);
    $('#forget').addEventListener('click', forget);
    $('#setup-edit').addEventListener('click', () => { editingSetup = true; render(); $('#step-gh').scrollIntoView({ behavior: 'smooth' }); });
    $('#domain').addEventListener('input', e => {
      if (!$('#repo').value.trim()) $('#repo').placeholder = C.suggestRepoName(e.target.value);
    });
    const pick = $('.filepick');
    pick.addEventListener('dragover', e => e.preventDefault());
    pick.addEventListener('drop', e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) readZip(f); });
    setupPlatform();
    render();
    if (S.ghToken && S.ghUser) fillRepoList();
    if (S.domain && S.lastDeploy) checkStatus();
    takeSharedFile();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  });

  window.ShipZipApp = { state: () => S, readZip, checkStatus }; // for testing
})();
