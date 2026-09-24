// Lia Field — tag-link.js
//
// The hyperlink on a tag: recognising it, indexing it, and — when it points
// somewhere we are willing to read — fetching what it claims about the item.
//
// Two kinds of tag turn up on a rack. The ones this app wrote carry a
// certificate URL (`…/fp/?t=<public_ref>`) plus a text record with the serial,
// and resolve locally. The ones the customer already had carry a serial printed
// on the outside and, in the NDEF, a link to somebody else's system. That
// second kind is what this file is for: nothing on it matches our catalogue, so
// the link IS the identifier until a tech gives us a better one.
//
// Part of the field app. Classic script — see the note in storage.js.
//
// ── What is deliberately NOT done here ──────────────────────────────────────
// Nothing fetched through this module is ever an inspection. A blank NTAG213
// costs pennies and any phone can rewrite one, so a URL read off a tag is an
// unauthenticated claim by whoever last held the item. Treating a fetched row
// as inspection history would let anyone fabricate "last inspected, PASS" on a
// harness — the single record that says the gear is safe to wear. So a fetch
// produces an EXTERNAL record: stamped with the URL it came from, shown to the
// tech as claimed-and-unverified, and never printed on a certificate. The
// inspection the tech then performs is a normal, first-party record.

(function (root) {
  'use strict';

  // ── Which hosts we are willing to fetch from ───────────────────────────────
  // Default-deny. A URL off a tag is attacker-controlled input, and a client
  // that fetches whatever it is handed is a request forwarder — it will happily
  // reach an intranet host the phone can see and the attacker cannot.
  //
  // Denial is not a dead end: it is reported as its own outcome naming the host,
  // so the tech still gets the link recorded and the operator can add the host.
  var DEFAULT_HOSTS = [
    'lia.mobileappdevelopmentgroup.com',
    'docs.google.com',
    'sheets.googleapis.com',
  ];
  var HOSTS_KEY = 'lia.tagLinkHosts';

  function extraHosts() {
    try {
      var raw = root.localStorage && root.localStorage.getItem(HOSTS_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
  }

  function hosts() {
    return DEFAULT_HOSTS.concat(extraHosts());
  }

  // Adds a host the operator has decided to trust. Exact match or a leading-dot
  // suffix ('.vendor.com' trusts any subdomain) — never a bare substring, which
  // would make 'vendor.com' match 'vendor.com.evil.net'.
  function allowHost(host) {
    var h = String(host || '').trim().toLowerCase();
    if (!h) return hosts();
    var extra = extraHosts();
    if (extra.indexOf(h) < 0 && DEFAULT_HOSTS.indexOf(h) < 0) {
      extra.push(h);
      try { root.localStorage.setItem(HOSTS_KEY, JSON.stringify(extra)); } catch (_) {}
    }
    return hosts();
  }

  function forgetHost(host) {
    var h = String(host || '').trim().toLowerCase();
    var extra = extraHosts().filter(function (x) { return x !== h; });
    try { root.localStorage.setItem(HOSTS_KEY, JSON.stringify(extra)); } catch (_) {}
    return hosts();
  }

  function hostAllowed(host) {
    var h = String(host || '').toLowerCase();
    return hosts().some(function (allowed) {
      if (allowed.charAt(0) === '.') return h === allowed.slice(1) || h.slice(-allowed.length) === allowed;
      return h === allowed;
    });
  }

  // ── Parsing the URL itself ────────────────────────────────────────────────

  // URL is not available in every context this runs in (and a tag can carry
  // something that is not a URL at all), so never let it throw.
  function parseUrl(url) {
    var s = String(url == null ? '' : url).trim();
    if (!s) return null;
    try { return new root.URL(s); } catch (_) { return null; }
  }

  function isUrl(value) {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(String(value || '').trim());
  }

  // The certificate code this app writes. A tag carrying one resolves through
  // the catalogue and never reaches the fetch path at all.
  function refFrom(url) {
    var m = String(url || '').match(/[?&]t=([A-Z0-9]+)/i);
    return m ? m[1].toUpperCase() : null;
  }

  // Our own certificate site. Kept separate from the fetch allowlist above:
  // that one says where a sheet may be fetched FROM, this one says which links
  // are ours to read identifiers out of.
  var CERT_HOST = 'lia.mobileappdevelopmentgroup.com';

  function isOurs(url) {
    var u = parseUrl(url);
    if (!u) return false;
    var h = String(u.hostname || '').toLowerCase().replace(/^www\./, '');
    return h === CERT_HOST;
  }

  // The serial our own tags now carry alongside the certificate code
  // (…/fp/?t=<ref>&s=<serial>). Both are in there on purpose: the serial is
  // what a human reads off the equipment, the ref is what survives the office
  // correcting a mistyped serial. See supabase/17_tag_write.sql.
  //
  // Restricted to OUR host, unlike refFrom. `s` is an ordinary parameter name
  // that turns up on plenty of third-party links, and reading one off somebody
  // else's system and looking it up as a serial is exactly how a tap returns
  // the wrong item's record — the failure this file exists to prevent.
  function serialFrom(url) {
    if (!isOurs(url)) return null;
    var m = String(url || '').match(/[?&]s=([^&#]+)/i);
    if (!m) return null;
    try { return decodeURIComponent(m[1].replace(/\+/g, ' ')).trim() || null; }
    catch (_) { return m[1].trim() || null; }
  }

  function isCertificate(url) {
    return !!refFrom(url) || !!serialFrom(url);
  }

  // ── The index key ─────────────────────────────────────────────────────────
  // Two tags pointing at the same record must collide, and the same tag read
  // twice must produce the same key — so: scheme and host lowercased, the
  // default port and a trailing slash dropped, tracking parameters removed, and
  // the remaining query sorted. Case in the PATH is preserved: plenty of systems
  // key off a case-sensitive id, and folding it would merge two real items.
  var TRACKING = /^(utm_|fbclid$|gclid$|mc_[ce]id$|_ga$|ref$|source$)/i;

  function urlKey(url) {
    var u = parseUrl(url);
    if (!u) {
      // Not parseable as a URL. Still worth a stable key so a malformed link is
      // at least consistent with itself.
      var raw = String(url == null ? '' : url).trim();
      return raw ? raw.toLowerCase() : '';
    }
    var scheme = u.protocol.toLowerCase().replace(/:$/, '');
    var host = u.hostname.toLowerCase().replace(/^www\./, '');
    var port = u.port && !((scheme === 'https' && u.port === '443') || (scheme === 'http' && u.port === '80'))
      ? ':' + u.port : '';
    var path = u.pathname.replace(/\/+$/, '');

    var params = [];
    try {
      u.searchParams.forEach(function (v, k) {
        if (!TRACKING.test(k)) params.push([k, v]);
      });
    } catch (_) {}
    params.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
    var query = params.length
      ? '?' + params.map(function (p) { return p[0] + '=' + p[1]; }).join('&')
      : '';

    // The fragment is deliberately kept for Google Sheets, where #gid=N is the
    // only thing distinguishing one tab from another, and dropped otherwise.
    var frag = /^#gid=\d+$/.test(u.hash) ? u.hash : '';
    return scheme + '://' + host + port + path + query + frag;
  }

  // ── Google Sheets ─────────────────────────────────────────────────────────
  // A human-shareable Sheets link is an HTML app, not data. Rewrite it to the
  // CSV endpoint, which is the only one that answers a cross-origin read.
  function toCsvUrl(url) {
    var u = parseUrl(url);
    if (!u) return null;
    if (u.hostname.toLowerCase() !== 'docs.google.com') return null;

    // Already asking for CSV.
    if (/output=csv|tqx=out:csv/i.test(u.search)) return u.href;

    var gid = (u.hash.match(/gid=(\d+)/) || u.search.match(/[?&]gid=(\d+)/) || [])[1] || '0';

    // A signed-in browser copies links with an account segment in them —
    // /spreadsheets/u/0/d/<id>/htmlview — and that is exactly the form that
    // gets pasted, so the segment is stripped rather than treated as a
    // different kind of link.
    var path = u.pathname.replace(/^\/spreadsheets\/u\/\d+\//, '/spreadsheets/');

    // Published-to-web: /spreadsheets/d/e/<pubid>/pubhtml
    var pub = path.match(/^\/spreadsheets\/d\/e\/([^/]+)/);
    if (pub) {
      return 'https://docs.google.com/spreadsheets/d/e/' + pub[1] +
             '/pub?output=csv&single=true&gid=' + gid;
    }

    // Ordinary share link: /spreadsheets/d/<id>/edit#gid=N, /htmlview, /view…
    // gviz answers cross-origin (it reflects the Origin header), which is what
    // makes this readable from the PWA and not only from the native build.
    var doc = path.match(/^\/spreadsheets\/d\/([^/]+)/);
    if (doc) {
      return 'https://docs.google.com/spreadsheets/d/' + doc[1] +
             '/gviz/tq?tqx=out:csv&gid=' + gid;
    }
    return null;
  }

  // ── Fetching ──────────────────────────────────────────────────────────────
  // Cross-origin reality, which the caller does not get to ignore:
  //
  //   native   CapacitorHttp goes out through the OS, so no CORS applies and
  //            any allowed host answers.
  //   web      an ordinary fetch is subject to CORS. Google's CSV endpoints
  //            send Access-Control-Allow-Origin: *, so those work; a vendor
  //            page almost certainly does not, and fails opaquely.
  //
  // So on web, "could not fetch" is the ORDINARY outcome for a third-party
  // link, not an exceptional one — which is why the caller's decide-what-to-do
  // path is the main path and not an error handler.
  function httpPlugin() {
    var cap = root.Capacitor;
    var p = cap && cap.Plugins && cap.Plugins.CapacitorHttp;
    return p && typeof p.get === 'function' ? p : null;
  }

  function isNative() {
    var cap = root.Capacitor;
    return !!(cap && cap.isNativePlatform && cap.isNativePlatform());
  }

  function fail(code, message, extra) {
    var out = { ok: false, code: code, error: message };
    if (extra) Object.keys(extra).forEach(function (k) { out[k] = extra[k]; });
    return out;
  }

  // Resolves — never rejects. Every outcome is a decision the tech has to be
  // shown, so none of them is an exception.
  function fetchLink(url, opts) {
    opts = opts || {};
    var u = parseUrl(url);
    if (!u) return Promise.resolve(fail('BAD_URL', 'That tag’s link is not a usable web address.'));

    // Never fetched over http. http is not merely insecure here — it is
    // trivially spoofable on the site wifi a tech is standing on, and the
    // answer becomes a safety record.
    //
    // But real tags say http: the supplier's tags are written as
    // http://docs.google.com/spreadsheets/..., and refusing them turned away
    // exactly the tag this feature exists for. So an http link to a trusted
    // host is upgraded and fetched over https; the request never goes out in
    // the clear. The tag's own URL is still what gets recorded.
    var scheme = u.protocol.toLowerCase();
    if (scheme === 'http:' && hostAllowed(u.hostname)) {
      u = parseUrl('https:' + u.href.slice(u.protocol.length));
      scheme = 'https:';
    }
    if (scheme !== 'https:') {
      return Promise.resolve(fail('NOT_HTTPS',
        'That tag’s link is not https, so it will not be opened automatically.',
        { host: u.hostname }));
    }
    if (!hostAllowed(u.hostname)) {
      return Promise.resolve(fail('HOST_NOT_ALLOWED',
        u.hostname + ' is not a trusted source, so nothing was fetched from it.',
        { host: u.hostname }));
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return Promise.resolve(fail('OFFLINE', 'No connection, so the tag’s link could not be read.',
        { host: u.hostname }));
    }

    var target = toCsvUrl(u.href) || u.href;
    var timeoutMs = opts.timeoutMs || 12000;

    return request(target, timeoutMs).then(function (res) {
      if (!res.ok) return res;
      var parsed = interpret(res.body, res.contentType);
      return {
        ok: true,
        url: url,
        fetchedUrl: target,
        host: u.hostname,
        contentType: res.contentType,
        records: parsed.records,
        headers: parsed.headers,
        mode: parsed.mode,
        unmapped: parsed.unmapped,
        rowCount: parsed.rowCount,
      };
    });
  }

  function request(target, timeoutMs) {
    var http = httpPlugin();
    if (http) {
      return Promise.resolve(http.get({
        url: target,
        readTimeout: timeoutMs,
        connectTimeout: timeoutMs,
        responseType: 'text',
      })).then(function (r) {
        var status = r && r.status;
        if (status && (status < 200 || status >= 300)) {
          return fail('HTTP_' + status, 'The tag’s link answered with ' + status + '.');
        }
        var body = r && r.data;
        return {
          ok: true,
          body: typeof body === 'string' ? body : JSON.stringify(body || ''),
          contentType: (r && r.headers && (r.headers['Content-Type'] || r.headers['content-type'])) || '',
        };
      }).catch(function (e) {
        return fail('FETCH_FAILED', (e && e.message) || 'The tag’s link could not be reached.');
      });
    }

    if (typeof root.fetch !== 'function') {
      return Promise.resolve(fail('NO_TRANSPORT', 'This device cannot fetch the tag’s link.'));
    }

    // AbortController is what stops a hung request from leaving the tech on a
    // spinner in a basement with one bar.
    var ctrl = null;
    try { ctrl = new root.AbortController(); } catch (_) {}
    var timer = setTimeout(function () { try { ctrl && ctrl.abort(); } catch (_) {} }, timeoutMs);

    return root.fetch(target, {
      method: 'GET',
      // No cookies to a host named by an untrusted tag, and 'cors' rather than
      // 'no-cors': an opaque response is unreadable anyway, so asking for one
      // would turn a CORS failure into a silent empty success.
      credentials: 'omit',
      mode: 'cors',
      redirect: 'follow',
      signal: ctrl ? ctrl.signal : undefined,
    }).then(function (r) {
      clearTimeout(timer);
      if (!r.ok) return fail('HTTP_' + r.status, 'The tag’s link answered with ' + r.status + '.');
      return r.text().then(function (body) {
        return { ok: true, body: body, contentType: r.headers.get('content-type') || '' };
      });
    }).catch(function (e) {
      clearTimeout(timer);
      var aborted = e && (e.name === 'AbortError');
      // A cross-origin refusal reaches JS as an indistinguishable TypeError, so
      // say what is actually likely rather than inventing a specific cause.
      return fail(aborted ? 'TIMEOUT' : 'FETCH_FAILED',
        aborted ? 'The tag’s link took too long to answer.'
                : 'The tag’s link could not be read from this device. It may not allow it.');
    });
  }

  // ── Delimited text ────────────────────────────────────────────────────────
  // A real parser, not a split(','): a notes column with a comma in it would
  // otherwise shift every field after it, and the field that shifts is the one
  // that says pass or fail.
  function parseDelimited(text, delim) {
    var rows = [];
    var row = [];
    var field = '';
    var quoted = false;
    var s = String(text || '');
    // Excel and Sheets both emit a UTF-8 BOM; left in place it becomes part of
    // the first header name and nothing maps.
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);

    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (quoted) {
        if (c === '"') {
          if (s[i + 1] === '"') { field += '"'; i++; }
          else quoted = false;
        } else field += c;
        continue;
      }
      if (c === '"') { quoted = true; continue; }
      if (c === delim) { row.push(field); field = ''; continue; }
      if (c === '\r') continue;
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
      field += c;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }

    return rows.filter(function (r) {
      return r.some(function (c) { return String(c).trim() !== ''; });
    });
  }

  function sniff(text) {
    var head = String(text || '').split('\n').slice(0, 5).join('\n');
    var commas = (head.match(/,/g) || []).length;
    var tabs = (head.match(/\t/g) || []).length;
    var semis = (head.match(/;/g) || []).length;
    if (tabs > commas && tabs > semis) return '\t';
    if (semis > commas) return ';';
    return ',';
  }

  // Strips the markup out of an HTML table so a published sheet — or a plain
  // vendor page — still yields rows rather than nothing.
  function htmlTable(text) {
    var s = String(text || '');
    var table = s.match(/<table[\s\S]*?<\/table>/i);
    if (!table) return null;
    var rows = [];
    var trRe = /<tr[\s\S]*?<\/tr>/gi;
    var tr;
    while ((tr = trRe.exec(table[0]))) {
      var cells = [];
      var cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
      var cell;
      while ((cell = cellRe.exec(tr[0]))) {
        cells.push(cell[1]
          .replace(/<[^>]*>/g, '')
          .replace(/&nbsp;/gi, ' ')
          .replace(/&amp;/gi, '&')
          .replace(/&lt;/gi, '<')
          .replace(/&gt;/gi, '>')
          .replace(/&quot;/gi, '"')
          .replace(/&#39;/gi, "'")
          .trim());
      }
      if (cells.length) rows.push(cells);
    }
    return rows.length ? rows : null;
  }

  // ── Mapping somebody else's columns onto ours ─────────────────────────────
  // The layout of these sheets is not known in advance and differs per vendor,
  // so headers are matched by meaning rather than position. Anything that does
  // not match is kept verbatim in `extra` and shown to the tech: a column we
  // failed to understand is still information he can read, and dropping it
  // silently would be worse than not fetching at all.
  // ORDER IS SIGNIFICANT — first match wins, and several of these overlap on
  // purpose. "Date of Manufacture:" contains 'manufact' and would otherwise be
  // read as the manufacturer's name; "Date Inspected:" contains 'date' and must
  // not be read as the manufacture date. The specific patterns come first.
  var FIELD_PATTERNS = [
    // The id printed on the tag itself — 'FP158354' on the real sheets. This is
    // NOT the hardware uid the phone reads (that is hex, and unrelated); it is a
    // human-readable code a tech can read off the tag and type. So it is a
    // genuine way to find the item, and is kept apart from both.
    ['tag_id',          /nfc.*tag|tag.*(id|number|#)|tag$/i],
    ['mfg_date',        /date.*(of\s*)?manufact|manufact.*date|^dom$|mfg\.?\s*date|^made$/i],
    ['inspection_date', /date\s*inspect|inspect.*date|^date$|last.*(inspect|service)|(prev|service).*date/i],
    ['next_due_date',   /next.*(due|inspect)|due\s*date|^due$|expir|recert/i],
    ['item_type',       /checklist\s*for|equip.*type|^type$|categor|^product/i],
    ['description',     /descript/i],
    ['serial',          /serial|^s\/?n$|^sn$|asset.*(id|no|num)|item.*(id|no|num)|unique.*id|^id$/i],
    ['model',           /model|part.*(no|num|#)|catalog/i],
    ['lot_number',      /lot|batch/i],
    ['manufacturer',    /manufactur|^make$|brand|^mfr\.?$/i],
    ['inspector',       /inspector|technician|^tech$|inspected\s*by|^by$/i],
    // 'Your inspection is' → Current / Overdue. A currency statement, not a
    // pass/fail verdict, and conflating the two would let an expired item read
    // as a failed one or vice versa.
    ['status_text',     /your\s*inspection\s*is|^status$|current.*state/i],
    // Note what is NOT here: a bare 'Pass' or 'Fail'. Those are ANSWERS, and on
    // a form they sit in their own cell under the component they belong to.
    // Treating one as a label made the checklist's own 'Pass' rows read as the
    // item's overall verdict, and the item's real verdict was then whatever
    // component name happened to follow.
    ['result',          /overall\s*assess|assessment|result|pass.?\/?.?fail|condition|verdict|outcome|disposition/i],
    ['notes',           /note|comment|remark|observ|defect|finding/i],
  ];

  function mapHeader(name) {
    var h = String(name || '').trim();
    if (!h) return null;
    for (var i = 0; i < FIELD_PATTERNS.length; i++) {
      if (FIELD_PATTERNS[i][1].test(h)) return FIELD_PATTERNS[i][0];
    }
    return null;
  }

  // A spreadsheet formula that did not resolve. Left alone, '#NUM!' becomes a
  // model number and '#N/A' becomes an inspector.
  var SHEET_ERROR = /^#(NUM|REF|N\/A|VALUE|DIV\/0|NAME|NULL|ERROR)[!?]?$/i;

  // How a verdict is spelled in a cell of its own. Needed by isLabel below, so
  // it is declared before it rather than beside the check extraction that also
  // uses it.
  var VERDICT_CELL = /^(pass|fail|yes|no|n\/?a|not\s*equipped|n\/?e|ok|good|bad)$/i;

  // Does this cell read as a prompt rather than as data? Either it is punctuated
  // like one, or it matches a field name we know. Used to stop a value scan from
  // running past the end of a field and picking up the NEXT label as an answer.
  function isLabel(v) {
    var s = String(v || '').trim();
    if (!s) return false;
    // A verdict is an answer wherever it appears, never a heading.
    if (VERDICT_CELL.test(s)) return false;
    if (/[:?]$/.test(s)) return true;
    return !!mapHeader(s);
  }

  // Pass/fail as somebody else spells it. Anything unrecognised stays null
  // rather than being guessed — an unreadable verdict on fall protection must
  // read as unknown, never as a pass.
  var PASSES = /^(p|pass(ed)?|ok|okay|good|serviceable|safe|accept(ed|able)?|y|yes|true|1|in service|satisfactory)$/i;
  var FAILS = /^(f|fail(ed)?|no|bad|unserviceable|unsafe|reject(ed)?|remove[d]?( from service)?|condemn(ed)?|n|false|0|out of service|defect(ive)?|damaged)$/i;

  function toVerdict(value) {
    var v = String(value == null ? '' : value).trim();
    if (!v) return null;
    if (PASSES.test(v)) return true;
    if (FAILS.test(v)) return false;
    return null;
  }

  var MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  // ISO out, or null. Ambiguity is resolved US-first (MM/DD/YYYY) because that
  // is where these crews are; a day over 12 in the first position falls back to
  // day-first rather than producing a nonsense month.
  function toDate(value) {
    var v = String(value == null ? '' : value).trim();
    if (!v) return null;

    var iso = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (iso) return iso[1] + '-' + pad(+iso[2]) + '-' + pad(+iso[3]);

    var slash = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
    if (slash) {
      var a = +slash[1], b = +slash[2], y = +slash[3];
      if (y < 100) y += y < 70 ? 2000 : 1900;
      var mo = a, da = b;
      if (a > 12 && b <= 12) { mo = b; da = a; }
      if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
      return y + '-' + pad(mo) + '-' + pad(da);
    }

    var named = v.match(/^(\d{1,2})[\s-]*([A-Za-z]{3,})[\s-]*(\d{2,4})$/) ||
                v.match(/^([A-Za-z]{3,})[\s-]*(\d{1,2})[,\s-]*(\d{2,4})$/);
    if (named) {
      var monthFirst = /^[A-Za-z]/.test(named[1]);
      var mName = (monthFirst ? named[1] : named[2]).slice(0, 3).toLowerCase();
      var dNum = +(monthFirst ? named[2] : named[1]);
      var yNum = +named[3];
      var idx = MONTHS.indexOf(mName);
      if (idx < 0) return null;
      if (yNum < 100) yNum += yNum < 70 ? 2000 : 1900;
      return yNum + '-' + pad(idx + 1) + '-' + pad(dNum);
    }
    return null;
  }

  function clean(v) {
    var s = String(v == null ? '' : v).trim();
    return SHEET_ERROR.test(s) ? '' : s;
  }

  // ── The form layout ───────────────────────────────────────────────────────
  // The real sheets are not tables. They are a printed inspection form laid out
  // on a grid: labels scattered across eight columns, and the value for a label
  // sitting sometimes to its right, sometimes directly underneath, and
  // sometimes on the next line entirely in an unrelated column:
  //
  //     NFC Tag ID │      │ Inspection Checklist For: │  │ Inspection Date │ 8/22/2026
  //     FP158354   │      │ CRANE LIFTING SLING       │  │ …
  //     …
  //     Are all labels and markings present…? │ │ │ │
  //                                     │ │ │ │ Yes
  //
  // So a value is looked for in three places, in this order, and the search
  // stops the moment it reaches another label — which is what keeps
  // "Lot Number:" from taking "Serial Number:" as its value when the lot is
  // simply blank.
  function cellAt(rows, r, c) {
    var row = rows[r];
    return row ? clean(row[c]) : '';
  }

  // Each step yields a value, or nothing so the next step gets a turn. Running
  // into another label ends that step but does NOT end the search: "NFC Tag ID"
  // has a label immediately to its right and its value directly underneath, and
  // stopping at the first label found would lose it.
  function valueFor(rows, r, c, width) {
    var i, j, v;

    // 1. To the right, on the same row. The common case for a labelled field.
    for (i = c + 1; i < width; i++) {
      v = cellAt(rows, r, i);
      if (!v) continue;
      if (isLabel(v)) break;
      return v;
    }

    // 2. Directly underneath, same column — how a form puts a value beneath its
    //    heading. Bounded, so a label with nothing under it does not reach down
    //    the whole sheet and adopt an unrelated cell.
    for (j = r + 1; j < Math.min(rows.length, r + 3); j++) {
      v = cellAt(rows, j, c);
      if (!v) continue;
      if (isLabel(v)) break;
      return v;
    }

    // 3. Reading order. This is how the checklist questions are answered — the
    //    prompt spans the row and the answer lands further down in whichever
    //    column the form happened to use.
    for (j = r; j < Math.min(rows.length, r + 3); j++) {
      for (i = (j === r ? c + 1 : 0); i < width; i++) {
        v = cellAt(rows, j, i);
        if (!v) continue;
        // Here a label DOES end the search: reading order is the last resort,
        // and running past a label means leaving this field's part of the form.
        return isLabel(v) ? '' : v;
      }
    }
    return '';
  }

  // The individual pass/fail checks on the form. Two shapes appear on the same
  // sheet: a question ending in '?' answered elsewhere in reading order, and a
  // component name with its verdict on the line below it.
  //
  // These are shown to the tech and stored with the external record, but they
  // never become check results on an inspection — the item's own equipment type
  // decides which questions are asked and what passing means, and somebody
  // else's list of components is not that.
  function extractChecks(rows, width) {
    var out = [];
    for (var r = 0; r < rows.length; r++) {
      for (var c = 0; c < width; c++) {
        var v = cellAt(rows, r, c);
        if (!v || VERDICT_CELL.test(v)) continue;

        if (/\?$/.test(v)) {
          // The overall assessment is the item's verdict, not one of the checks.
          if (mapHeader(v) === 'result') continue;
          var ans = valueFor(rows, r, c, width);
          if (ans) out.push({ prompt: v, answer: ans, result: toVerdict(ans) });
          continue;
        }

        // A component name with its verdict on the next line. Only in the first
        // column: elsewhere this pattern is ordinary form layout and would
        // manufacture checks out of nothing.
        if (c === 0 && !isLabel(v)) {
          var below = cellAt(rows, r + 1, 0);
          if (below && VERDICT_CELL.test(below)) {
            out.push({ prompt: v, answer: below, result: toVerdict(below) });
          }
        }
      }
    }
    return out;
  }

  // Reads the whole grid as one item's form.
  function interpretGrid(rows) {
    var width = rows.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
    var mapped = {};
    var extra = {};
    var seen = {};

    for (var r = 0; r < rows.length; r++) {
      for (var c = 0; c < width; c++) {
        var label = cellAt(rows, r, c);
        if (!label || !isLabel(label)) continue;
        var field = mapHeader(label);
        var value = valueFor(rows, r, c, width);
        if (!value) continue;
        if (field) {
          // First one wins: a form states a field once, and a later coincidental
          // match should not overwrite the real answer.
          if (!mapped[field]) mapped[field] = value;
        } else if (!seen[label] && !/\?$/.test(label)) {
          // A label we do not recognise still carried an answer. Keep it — the
          // tech can read it, and dropping it would lose the one piece of
          // information the fetch was for.
          //
          // Questions are excluded: they are the checklist, collected separately
          // by extractChecks, and listing them here too showed the tech the same
          // answer twice under two different headings.
          seen[label] = true;
          extra[label.replace(/[:?]$/, '')] = value;
        }
      }
    }

    var rec = toRecord(mapped, extra);
    rec.checks = extractChecks(rows, width);
    // A form with nothing but its checks filled in is still worth showing.
    if (rec.checks.length) rec.has_content = true;
    return {
      mode: 'grid',
      records: rec.has_content ? [rec] : [],
      headers: Object.keys(mapped),
      unmapped: Object.keys(extra),
      rowCount: rows.length,
    };
  }

  // Builds one external record out of a mapped row. Everything is optional:
  // a sheet that yields only a date is still worth showing.
  function toRecord(mapped, extra) {
    var rec = {
      serial: mapped.serial || '',
      // Kept separate from the serial. On the real sheets the Serial Number
      // field is often blank and the tag id is the only identifier there is —
      // but they are different things, and merging them would put a tag's code
      // into the serial field of an item that has its own.
      tag_id: mapped.tag_id || '',
      inspection_date: toDate(mapped.inspection_date),
      next_due_date: toDate(mapped.next_due_date),
      // These forms state currency as a duration — "It will expire in / 357
      // days" — not as a date. That does not parse and must not silently vanish;
      // it is the most legible thing on the sheet for a tech deciding whether
      // the item is due.
      next_due_raw: mapped.next_due_date || '',
      overall_pass: toVerdict(mapped.result),
      result_text: mapped.result || '',
      status_text: mapped.status_text || '',
      manufacturer: mapped.manufacturer || '',
      model: mapped.model || '',
      item_type: mapped.item_type || '',
      description: mapped.description || '',
      lot_number: mapped.lot_number || '',
      mfg_date: toDate(mapped.mfg_date),
      mfg_date_raw: mapped.mfg_date || '',
      inspector: mapped.inspector || '',
      notes: mapped.notes || '',
      checks: [],
      extra: extra || {},
    };
    // A date that did not parse is still evidence; keep the raw string so the
    // tech sees what the sheet actually said rather than a blank.
    rec.inspection_date_raw = mapped.inspection_date || '';
    rec.has_content = !!(rec.inspection_date || rec.inspection_date_raw || rec.serial ||
                         rec.tag_id || rec.result_text || rec.model || rec.manufacturer ||
                         rec.item_type || Object.keys(rec.extra).length);
    return rec;
  }

  // What this record can be looked up by, best first. The serial is the item's
  // own; the tag id is printed on the tag and is what a tech would read off it
  // when there is no serial. Both are human-readable codes, unlike a hardware
  // uid, so both are legitimate ways into the catalogue.
  function identifiers(rec) {
    return [rec && rec.serial, rec && rec.tag_id]
      .map(function (v) { return String(v || '').trim(); })
      .filter(function (v, i, a) { return v && a.indexOf(v) === i; });
  }

  // Two sheet shapes turn up, and both have to work:
  //
  //   table   a header row and one row per inspection — the common case.
  //   kv      two columns, label on the left and value on the right, one item
  //           per sheet. Reading this as a table produces one useless record
  //           whose header row is data, so it is detected rather than assumed.
  function interpret(text, contentType) {
    var rows = null;
    if (/html/i.test(contentType || '') || /^\s*</.test(String(text || ''))) {
      rows = htmlTable(text);
    }
    if (!rows) rows = parseDelimited(text, sniff(text));

    if (!rows || !rows.length) {
      return { mode: 'empty', records: [], headers: [], unmapped: [], rowCount: 0 };
    }

    var header = rows[0].map(clean);
    var mappedHeader = header.map(mapHeader);
    var recognised = mappedHeader.filter(Boolean).length;

    // Which of the two shapes is this? A header-row table has its labels in row
    // 0 and nothing but data below. A form has labels scattered all through it —
    // so counting the label-looking cells BELOW the first row separates them,
    // and does it without needing to know any particular vendor's layout.
    var labelsBelow = 0;
    for (var r = 1; r < rows.length; r++) {
      for (var c = 0; c < rows[r].length; c++) {
        if (isLabel(clean(rows[r][c]))) labelsBelow++;
      }
    }
    if (labelsBelow >= 3 || (recognised < 2 && labelsBelow >= 1)) {
      return interpretGrid(rows);
    }

    var unmapped = header.filter(function (h, i) { return h && !mappedHeader[i]; });
    var records = [];
    for (var i = 1; i < rows.length; i++) {
      var mapped = {};
      var extra = {};
      for (var c = 0; c < header.length; c++) {
        var value = clean(rows[i][c]);
        if (!value) continue;
        var field = mappedHeader[c];
        if (field) { if (!mapped[field]) mapped[field] = value; }
        else if (header[c]) extra[header[c]] = value;
      }
      var rec = toRecord(mapped, extra);
      if (rec.has_content) records.push(rec);
    }

    // Most recent first — the tech cares about the last inspection, and a sheet
    // that appends to the bottom would otherwise lead with the oldest row.
    records.sort(function (a, b) {
      var x = a.inspection_date || '', y = b.inspection_date || '';
      if (x === y) return 0;
      if (!x) return 1;
      if (!y) return -1;
      return x < y ? 1 : -1;
    });

    return {
      mode: recognised ? 'table' : 'unmapped',
      records: records,
      headers: header,
      unmapped: unmapped,
      rowCount: rows.length - 1,
    };
  }

  // One line for the tech, phrased as a claim rather than a fact — because that
  // is all it is until somebody inspects the item.
  function summarize(result) {
    if (!result) return '';
    if (!result.ok) return result.error || 'The tag’s link could not be read.';
    var rec = result.records && result.records[0];
    if (!rec) return 'The tag’s link opened but held nothing we could read as an inspection.';
    var bits = [];
    if (rec.inspection_date) bits.push('last inspected ' + rec.inspection_date);
    else if (rec.inspection_date_raw) bits.push('last inspected ' + rec.inspection_date_raw);
    if (rec.overall_pass === true) bits.push('passed');
    else if (rec.overall_pass === false) bits.push('FAILED');
    else if (rec.result_text) bits.push(rec.result_text);
    if (rec.serial) bits.push('serial ' + rec.serial);
    return bits.length
      ? 'The tag’s link claims: ' + bits.join(', ') + '. Unverified.'
      : 'The tag’s link opened but held nothing we could read as an inspection.';
  }

  var api = {
    // URL handling
    isUrl: isUrl,
    urlKey: urlKey,
    refFrom: refFrom,
    serialFrom: serialFrom,
    isOurs: isOurs,
    isCertificate: isCertificate,
    toCsvUrl: toCsvUrl,
    // Trust
    hosts: hosts,
    hostAllowed: hostAllowed,
    allowHost: allowHost,
    forgetHost: forgetHost,
    // Fetch + parse
    fetch: fetchLink,
    interpret: interpret,
    parseDelimited: parseDelimited,
    toDate: toDate,
    toVerdict: toVerdict,
    identifiers: identifiers,
    summarize: summarize,
    isNative: isNative,
  };

  root.LiaTagLink = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
