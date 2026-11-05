/* ShipZip core logic — pure functions, no DOM, no network.
   Shared by the app (browser) and the tests (node). */
(function (root) {
  'use strict';

  const GITHUB_PAGES_A = ['185.199.108.153', '185.199.109.153', '185.199.110.153', '185.199.111.153'];
  const GITHUB_PAGES_AAAA = ['2606:50c0:8000::153', '2606:50c0:8001::153', '2606:50c0:8002::153', '2606:50c0:8003::153'];
  const MAX_FILE_BYTES = 100 * 1024 * 1024;   // GitHub rejects single files over 100 MB
  const WARN_TOTAL_BYTES = 900 * 1024 * 1024; // GitHub Pages sites are limited to about 1 GB

  const JUNK = [
    /(^|\/)__MACOSX(\/|$)/,
    /(^|\/)\.DS_Store$/,
    /(^|\/)Thumbs\.db$/i,
    /(^|\/)desktop\.ini$/i,
    /(^|\/)\.git(\/|$)/,
    /(^|\/)\._[^/]*$/          // macOS resource-fork files
  ];

  function isJunk(path) { return JUNK.some(re => re.test(path)); }

  function cleanPath(p) {
    return String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  }

  function dirOf(p) { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i + 1); }

  /**
   * files: [{ path, data: Uint8Array }]
   * options: { domain }  (domain optional)
   * returns { files, root, renamedIndex, dropped, outside, warnings, errors, totalBytes }
   */
  function normalizeSite(files, options) {
    const opts = options || {};
    const warnings = [];
    const errors = [];
    const dropped = [];

    let list = files
      .map(f => ({ path: cleanPath(f.path), data: f.data }))
      .filter(f => f.path && !f.path.endsWith('/'));

    list = list.filter(f => {
      if (isJunk(f.path)) { dropped.push(f.path); return false; }
      return true;
    });

    // Find the site root: the shallowest index.html
    const indexes = list
      .filter(f => /(^|\/)index\.html?$/i.test(f.path))
      .sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.length - b.path.length);

    let root = '';
    let renamedIndex = null;
    if (indexes.length) {
      root = dirOf(indexes[0].path);
    } else {
      // No index.html anywhere. If there is exactly one shallowest .html file, use it as the home page.
      const htmls = list.filter(f => /\.html?$/i.test(f.path))
        .sort((a, b) => a.path.split('/').length - b.path.split('/').length);
      if (htmls.length) {
        const depth = htmls[0].path.split('/').length;
        const shallow = htmls.filter(h => h.path.split('/').length === depth);
        if (shallow.length === 1) {
          root = dirOf(shallow[0].path);
          renamedIndex = shallow[0].path;
        } else {
          errors.push('No index.html found, and there are several HTML files at the top, so it is unclear which one is the home page: ' + shallow.map(h => h.path).join(', '));
        }
      } else {
        errors.push('No HTML files found in this zip. A website needs an index.html.');
      }
    }

    const outside = [];
    let out = [];
    for (const f of list) {
      if (root && !f.path.startsWith(root)) { outside.push(f.path); continue; }
      let p = f.path.slice(root.length);
      if (renamedIndex && f.path === renamedIndex) p = 'index.html';
      out.push({ path: p, data: f.data });
    }
    if (outside.length) {
      warnings.push(outside.length + ' file(s) sit outside the folder that holds index.html and were left out: ' + outside.slice(0, 5).join(', ') + (outside.length > 5 ? '…' : ''));
    }
    if (renamedIndex) {
      warnings.push('There was no index.html, so "' + renamedIndex + '" will be used as the home page (renamed to index.html).');
    }

    // Our own control files win over whatever the zip had.
    const enc = s => new TextEncoder().encode(s);
    const hadCname = out.some(f => f.path === 'CNAME');
    out = out.filter(f => f.path !== '.nojekyll' && f.path !== 'CNAME');
    out.push({ path: '.nojekyll', data: new Uint8Array(0) });
    const domain = normalizeDomain(opts.domain || '');
    if (domain) out.push({ path: 'CNAME', data: enc(domain + '\n') });
    else if (hadCname) warnings.push('The zip contained a CNAME file but no domain is set in ShipZip, so it was removed.');

    // Case-insensitive duplicate paths break on some systems
    const seen = new Map();
    for (const f of out) {
      const k = f.path.toLowerCase();
      if (seen.has(k) && seen.get(k) !== f.path) warnings.push('Two files differ only by capital letters: ' + seen.get(k) + ' and ' + f.path);
      seen.set(k, f.path);
    }

    let totalBytes = 0;
    for (const f of out) {
      totalBytes += f.data.length;
      if (f.data.length > MAX_FILE_BYTES) errors.push(f.path + ' is ' + fmtBytes(f.data.length) + '. GitHub refuses files over 100 MB.');
    }
    if (totalBytes > WARN_TOTAL_BYTES) warnings.push('This site is ' + fmtBytes(totalBytes) + '. GitHub Pages sites are limited to about 1 GB.');

    out.sort((a, b) => a.path.localeCompare(b.path));
    return { files: out, root, renamedIndex, dropped, outside, warnings, errors, totalBytes };
  }

  /** Find links that start with "/" (root-absolute). They work on a custom domain
      but break on the temporary username.github.io/repo/ address. */
  function findRootAbsoluteLinks(files) {
    const hits = [];
    const dec = new TextDecoder();
    const re = /(?:\b(?:src|href|action|poster)\s*=\s*["']|url\(\s*["']?)(\/(?!\/)[^"')\s>]*)/gi;
    for (const f of files) {
      if (!/\.(html?|css)$/i.test(f.path) || f.data.length > 2 * 1024 * 1024) continue;
      const text = dec.decode(f.data);
      let m; let n = 0;
      re.lastIndex = 0;
      while ((m = re.exec(text)) && n < 3) { hits.push({ file: f.path, link: m[1] }); n++; }
    }
    return hits;
  }

  function normalizeDomain(d) {
    let s = String(d || '').trim().toLowerCase();
    s = s.replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
    if (s.startsWith('www.')) s = s.slice(4);
    return s;
  }

  function isValidDomain(d) {
    return /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(d);
  }

  function validRepoName(name) {
    return /^[A-Za-z0-9._-]{1,100}$/.test(name) && name !== '.' && name !== '..';
  }

  function suggestRepoName(domain) {
    const d = normalizeDomain(domain);
    return d ? d.replace(/[^a-z0-9._-]/g, '-') : 'my-site';
  }

  /** The exact DNS records GitHub Pages needs for an apex domain + www. */
  function desiredRecords(domain, githubUser) {
    const d = normalizeDomain(domain);
    const recs = [];
    for (const ip of GITHUB_PAGES_A) recs.push({ name: d, type: 'A', content: ip });
    for (const ip of GITHUB_PAGES_AAAA) recs.push({ name: d, type: 'AAAA', content: ip });
    recs.push({ name: 'www.' + d, type: 'CNAME', content: String(githubUser).toLowerCase() + '.github.io' });
    return recs;
  }

  /** Given the records currently in the IONOS zone, decide what to delete and what to add.
      Anything on the apex or www that would fight with GitHub's records gets deleted.
      MX / TXT / other subdomains are never touched. */
  function planDns(existing, domain, githubUser) {
    const d = normalizeDomain(domain);
    const want = desiredRecords(d, githubUser);
    const norm = s => String(s || '').toLowerCase().replace(/\.$/, '');
    const conflictTypes = new Set(['A', 'AAAA', 'CNAME', 'ALIAS']);
    const keep = [];
    const remove = [];
    for (const r of existing || []) {
      const name = norm(r.name);
      if ((name === d || name === 'www.' + d) && conflictTypes.has(String(r.type).toUpperCase())) {
        const match = want.find(w => w.name === name && w.type === String(r.type).toUpperCase() && norm(w.content) === norm(r.content));
        if (match && !r.disabled) keep.push(r); else remove.push(r);
      }
    }
    const add = want.filter(w => !keep.some(k => norm(k.name) === w.name && String(k.type).toUpperCase() === w.type && norm(k.content) === norm(w.content)));
    return { remove, add, keep };
  }

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function bytesToBase64(bytes) {
    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'binary').toString('base64');
  }

  const api = {
    GITHUB_PAGES_A, GITHUB_PAGES_AAAA, normalizeSite, findRootAbsoluteLinks, normalizeDomain,
    isValidDomain, validRepoName, suggestRepoName, desiredRecords, planDns, fmtBytes, bytesToBase64, isJunk
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShipZipCore = api;
})(typeof self !== 'undefined' ? self : this);
