// Fair Line updater. Runs on GitHub's servers every two hours (see the workflow file).
// It pulls odds, results, injuries, weather and starters, rates the teams, logs and grades picks,
// and writes the files the app reads into the data folder. No installs needed: plain Node 18+.
import fs from 'node:fs';
import path from 'node:path';

// =====================================================================================
// SETTINGS YOU CAN CHANGE
// =====================================================================================
const CONFIG = {
  // Sports to follow, most important first. Keys are The Odds API's sport keys; * matches anything.
  // Full list: https://the-odds-api.com/sports-odds-data/sports-apis.html
  sports: [
    'americanfootball_nfl', 'americanfootball_ncaaf', 'basketball_nba', 'icehockey_nhl', 'baseball_mlb',
    'basketball_ncaab', 'basketball_wnba', 'soccer_epl', 'soccer_usa_mls', 'soccer_uefa_champs_league',
    'soccer_spain_la_liga', 'soccer_germany_bundesliga', 'soccer_italy_serie_a', 'soccer_france_ligue_one',
    'mma_mixed_martial_arts', 'boxing_boxing', 'golf_*', 'tennis_*'
  ],
  // Books the app treats as "yours" when it logs picks for the track record.
  myBooks: ['draftkings', 'fanduel', 'betmgm', 'fanatics', 'williamhill_us'],
  // The Odds API. Free plan: 500 credits a month. Up to 10 books in one request cost the same as one region.
  oddsApi: {
    monthlyCredits: 500,
    books: ['draftkings', 'fanduel', 'betmgm', 'betrivers', 'hardrockbet', 'espnbet', 'ballybet', 'betparx', 'bovada', 'betonlineag'],
    // On a paid plan, put 'fanatics' and 'williamhill_us' (Caesars) in the list above in place of two others.
  },
  // ParlayAPI (optional second feed). Free plan: 1,000 credits a month.
  parlay: {
    monthlyCredits: 1000,
    books: ['fanatics', 'caesars', 'pinnacle', 'draftkings', 'fanduel', 'betmgm', 'betrivers', 'hardrock', 'bet365', 'novig'],
  },
  // The bar a bet must clear to be logged as a pick, and how much say the stats model gets.
  pick: { minEdge: 0.02, minConf: 50, modelTrust: 0.15 },
};
// =====================================================================================

// ---- pricing engine (same code the app uses) ----
const FL = (() => { const module = { exports: {} }; (function (module) {
/* Fair Line pricing engine. Pure functions, no network and no DOM.
   The same code runs in the app (to price what you see) and in the updater (to log and grade picks). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FairLine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- odds helpers ----------
  function amToDec(a) { return a > 0 ? 1 + a / 100 : 1 + 100 / -a; }
  function amToProb(a) { return 1 / amToDec(a); }
  function decToAm(d) { return d >= 2 ? Math.round((d - 1) * 100) : -Math.round(100 / (d - 1)); }
  function probToAm(p) {
    if (!(p > 0 && p < 1)) return null;
    return p >= 0.5 ? -Math.round((100 * p) / (1 - p)) : Math.round((100 * (1 - p)) / p);
  }
  function fmtAm(a) { return a == null ? '–' : a > 0 ? '+' + a : String(a); }
  function median(xs) {
    var s = xs.slice().sort(function (a, b) { return a - b; });
    var n = s.length;
    if (!n) return NaN;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }
  function stdev(xs) {
    if (xs.length < 2) return 0;
    var m = xs.reduce(function (a, b) { return a + b; }, 0) / xs.length;
    return Math.sqrt(xs.reduce(function (a, b) { return a + (b - m) * (b - m); }, 0) / xs.length);
  }
  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

  // Remove the bookmaker's margin. Power method: find k with sum(p^k) = 1.
  // It takes more margin off long shots than a plain rescale, which matches how books shade prices.
  function devig(probs) {
    var sum = probs.reduce(function (a, b) { return a + b; }, 0);
    if (sum <= 1.0000001) return probs.map(function (p) { return p / sum; });
    var lo = 1, hi = 30;
    for (var i = 0; i < 60; i++) {
      var k = (lo + hi) / 2, s = 0;
      for (var j = 0; j < probs.length; j++) s += Math.pow(probs[j], k);
      if (s > 1) lo = k; else hi = k;
    }
    var kk = (lo + hi) / 2;
    return probs.map(function (p) { return Math.pow(p, kk); });
  }

  // ---------- score distributions ----------
  function normCdf(x) {
    var t = 1 / (1 + 0.2316419 * Math.abs(x));
    var d = 0.3989422804014327 * Math.exp((-x * x) / 2);
    var p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return x >= 0 ? 1 - p : p;
  }
  // How much more (or less) often NFL games finish on each margin than a smooth curve predicts.
  // Approximate, from long-run NFL final-margin frequencies (3 is about 15% of games, 7 about 9%).
  var NFL_KEYS = { 0: 0.11, 1: 0.8, 2: 0.75, 3: 2.9, 4: 0.96, 5: 0.69, 6: 1.2, 7: 1.87, 8: 0.82, 9: 0.36, 10: 1.3,
    11: 0.61, 12: 0.46, 13: 0.76, 14: 1.45, 15: 0.46, 16: 0.8, 17: 1.29, 18: 0.9, 20: 1.0, 21: 1.2 };
  // College football lands on the same numbers, less sharply.
  var CFB_KEYS = {}; Object.keys(NFL_KEYS).forEach(function (k) { CFB_KEYS[k] = 1 + (NFL_KEYS[k] - 1) * 0.55; });

  function makeDist(mu, sigma, lo, hi, keys) {
    var n = hi - lo + 1, pmf = new Array(n), tot = 0;
    for (var i = 0; i < n; i++) {
      var k = lo + i;
      var m = normCdf((k + 0.5 - mu) / sigma) - normCdf((k - 0.5 - mu) / sigma);
      if (keys) { var w = keys[Math.abs(k)]; if (w != null) m *= w; }
      pmf[i] = m; tot += m;
    }
    for (var j = 0; j < n; j++) pmf[j] /= tot;
    return { lo: lo, pmf: pmf };
  }
  // Win / push / lose for "result + line > 0" (sign = +1) or "result + line < 0" (sign = -1).
  function wpl(dist, line, sign) {
    var win = 0, push = 0, lose = 0;
    for (var i = 0; i < dist.pmf.length; i++) {
      var v = (dist.lo + i + line) * sign;
      if (v > 1e-9) win += dist.pmf[i]; else if (v < -1e-9) lose += dist.pmf[i]; else push += dist.pmf[i];
    }
    return { win: win, push: push, lose: lose, q: win / (win + lose) };
  }
  function bisect(fn, target, lo, hi) {
    for (var i = 0; i < 50; i++) { var mid = (lo + hi) / 2; if (fn(mid) < target) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
  }

  // ---------- sport settings (how spread out final scores are) ----------
  function sportCfg(key) {
    key = key || '';
    if (key === 'americanfootball_nfl' || key === 'americanfootball_nfl_preseason') return { spreadSigma: 13.5, totalSigma: 13.0, keys: NFL_KEYS, range: 70, totalMax: 140 };
    if (key.indexOf('americanfootball_') === 0) return { spreadSigma: 16.5, totalSigma: 17.0, keys: CFB_KEYS, range: 95, totalMax: 180 };
    if (key === 'basketball_nba' || key === 'basketball_nba_preseason') return { spreadSigma: 12.0, totalSigma: 18.0, range: 75, totalMax: 340 };
    if (key.indexOf('basketball_') === 0) return { spreadSigma: 11.0, totalSigma: 15.5, range: 75, totalMax: 280 };
    if (key.indexOf('icehockey_') === 0) return { totalSigma: 2.35, totalMax: 22 };
    if (key.indexOf('baseball_') === 0) return { totalSigma: 4.4, totalMax: 45 };
    return {};
  }
  function spreadDist(cfg, mu) { return makeDist(mu, cfg.spreadSigma, -cfg.range, cfg.range, cfg.keys); }
  function totalDist(cfg, mu) { return makeDist(mu, cfg.totalSigma, 0, cfg.totalMax, null); }
  function isQuarter(pt) { return pt != null && Math.abs(pt * 2 - Math.round(pt * 2)) > 1e-9; }

  // ---------- reading the feed ----------
  function marketOf(book, key) {
    for (var i = 0; i < book.markets.length; i++) if (book.markets[i].key === key) return book.markets[i];
    return null;
  }
  function outcomeOf(mkt, name) {
    for (var i = 0; i < mkt.outcomes.length; i++) if (mkt.outcomes[i].name === name) return mkt.outcomes[i];
    return null;
  }
  function mode(xs) {
    var c = {}, best = null, bn = 0;
    xs.forEach(function (x) { c[x] = (c[x] || 0) + 1; if (c[x] > bn) { bn = c[x]; best = x; } });
    return best;
  }
  function sideOf(ev, name) { return name === ev.home_team ? 'home' : name === ev.away_team ? 'away' : /^(draw|tie)$/i.test(name) ? 'draw' : name; }

  var GROUP_MS = 45 * 60e3;       // prices captured within 45 minutes of each other count as one snapshot
  var MOVED = 0.025;              // a price this far from the snapshot's fair line is treated as moved

  // Books are refreshed at different times. Comparing a fresh price with hours-old ones looks like value
  // when it is really the market moving, so the fair line comes from one snapshot: the newest group of
  // three or more books captured together. Older and newer prices are judged against it and flagged.
  function groupRows(rows) {
    if (!rows.length) return [];
    rows.forEach(function (r) { r.t = Date.parse(r.b.last_update) || 0; });
    var sorted = rows.slice().sort(function (a, b) { return b.t - a.t; });
    var groups = [], cur = null;
    sorted.forEach(function (r) {
      if (!cur || cur.minT - r.t > GROUP_MS) { cur = { rows: [], minT: r.t, maxT: r.t }; groups.push(cur); }
      cur.rows.push(r); cur.minT = r.t;
    });
    var main = null;
    for (var i = 0; i < groups.length && !main; i++) if (groups[i].rows.length >= 3) main = groups[i];
    if (!main) { main = groups[0]; groups.forEach(function (g) { if (g.rows.length > main.rows.length) main = g; }); }
    groups.forEach(function (g) { g.rows.forEach(function (r) { r.grp = g === main ? 'main' : g.maxT > main.maxT ? 'newer' : 'older'; }); });
    return main.rows;
  }

  // ---------- one event, every market ----------
  function analyzeEvent(ev, opts) {
    opts = opts || {};
    var cfg = sportCfg(ev.sport_key);
    var w = opts.modelTrust || 0;
    var model = ev.model || null;
    var staleMs = (opts.staleHours == null ? 18 : opts.staleHours) * 3600e3;
    var out = { event: ev, cfg: cfg, model: model, markets: {}, stale: [] };
    var all = (ev.bookmakers || []).filter(function (b) { return b && b.markets && b.markets.length; });
    var newest = 0;
    all.forEach(function (b) { var t = Date.parse(b.last_update); if (t > newest) newest = t; });
    var books = [];
    all.forEach(function (b) { if (newest - Date.parse(b.last_update) > staleMs) out.stale.push(b.key); else books.push(b); });
    out.newest = newest;

    // --- moneyline (two or three outcomes) and outrights (many) ---
    function nWay(key) {
      var rows = [];
      books.forEach(function (b) { var m = marketOf(b, key); if (m && m.outcomes.length >= 2) rows.push({ b: b, m: m }); });
      if (!rows.length) return;
      var names = [], seen = {}, maxListed = 0;
      rows.forEach(function (r) {
        if (r.m.outcomes.length > maxListed) maxListed = r.m.outcomes.length;
        r.m.outcomes.forEach(function (o) { if (!seen[o.name]) { seen[o.name] = 1; names.push(o.name); } });
      });
      var isOut = key === 'outrights';
      rows.forEach(function (r) {
        // a book that lists only part of the field cannot be de-vigged fairly
        if (isOut ? r.m.outcomes.length < 0.6 * maxListed : r.m.outcomes.length !== names.length) { r.skip = true; return; }
        var fair = devig(r.m.outcomes.map(function (o) { return amToProb(o.price); }));
        r.fair = {}; r.m.outcomes.forEach(function (o, i) { r.fair[o.name] = fair[i]; });
      });
      var full = rows.filter(function (r) { return !r.skip; });
      var use = groupRows(full);
      if (!use.length) return;
      var fairBy = {}, med = {}, tot = 0;
      names.forEach(function (n) {
        fairBy[n] = use.filter(function (r) { return r.fair[n] != null; }).map(function (r) { return r.fair[n]; });
        med[n] = fairBy[n].length ? median(fairBy[n]) : null;
        if (med[n] != null) tot += med[n];
      });
      if (!isOut && ev.home_team) names.sort(function (a, b) { var o = { away: 0, draw: 1, home: 2 }; return (o[sideOf(ev, a)] || 0) - (o[sideOf(ev, b)] || 0); });
      function thr(p) { return Math.max(MOVED * 2 * Math.sqrt(p * (1 - p)), 0.004); }
      var marketMoved = false;
      if (!isOut) full.forEach(function (r) {
        if (r.grp !== 'newer') return;
        names.forEach(function (n) { if (med[n] != null && r.fair[n] != null && Math.abs(r.fair[n] - med[n] / tot) > thr(med[n] / tot)) marketMoved = true; });
      });
      var pModelHome = null;
      if (!isOut && model && !model.p && model.mu != null && cfg.spreadSigma && names.length === 2) pModelHome = wpl(spreadDist(cfg, model.mu), 0, 1).q;
      var outcomes = [];
      names.forEach(function (n) {
        if (med[n] == null) return;
        var side = isOut ? n : sideOf(ev, n);
        var pMkt = med[n] / tot, pModel = null;
        if (!isOut && model && model.p && model.p[side] != null) pModel = model.p[side];
        else if (pModelHome != null) pModel = side === 'home' ? pModelHome : 1 - pModelHome;
        var pApp = pModel == null ? pMkt : (1 - w) * pMkt + w * pModel;
        var offers = [];
        rows.forEach(function (r) {
          var o = outcomeOf(r.m, n); if (!o) return;
          var dec = amToDec(o.price), bf = r.fair ? r.fair[n] : null;
          var evMkt = pMkt * (dec - 1) - (1 - pMkt);
          var moved = r.grp === 'main' ? marketMoved : r.grp === 'newer' ? evMkt > 0 : r.grp === 'older' ? bf != null && Math.abs(bf - pMkt) > thr(pMkt) : false;
          offers.push({ book: r.b.key, title: r.b.title, updated: r.b.last_update, price: o.price, point: null, dec: dec,
            implied: 1 / dec, bookFair: bf, pMkt: pMkt, pModel: pModel, pApp: pApp, push: 0,
            ev: pApp * (dec - 1) - (1 - pApp), evMkt: evMkt, offLine: false, moved: moved, grp: r.grp || 'part' });
        });
        outcomes.push({ id: n, label: n, side: side, point: null, pMkt: pMkt, pModel: pModel, pApp: pApp,
          nBooks: fairBy[n].length, sd: stdev(fairBy[n]), offers: offers });
      });
      if (isOut) outcomes.sort(function (a, b) { return b.pMkt - a.pMkt; });
      out.markets[key] = { key: key, outcomes: outcomes, nBooks: rows.length, nWay: names.length, moved: marketMoved };
    }
    nWay('h2h'); nWay('outrights');

    // --- spread and total ---
    function twoSided(key) {
      var isSpread = key === 'spreads';
      var rows = [];
      books.forEach(function (b) {
        var m = marketOf(b, key); if (!m || m.outcomes.length !== 2) return;
        var A, B; // A = home side (spread) or Over (total)
        if (isSpread) { A = outcomeOf(m, ev.home_team); B = outcomeOf(m, ev.away_team); }
        else { A = outcomeOf(m, 'Over'); B = outcomeOf(m, 'Under'); }
        if (!A || !B || A.point == null) return;
        var fair = devig([amToProb(A.price), amToProb(B.price)]);
        rows.push({ b: b, A: A, B: B, line: A.point, fairA: fair[0] });
      });
      if (!rows.length) return null;
      var sigma = isSpread ? cfg.spreadSigma : cfg.totalSigma;
      var dist = isSpread ? function (mu) { return spreadDist(cfg, mu); } : function (mu) { return totalDist(cfg, mu); };
      function probsA(mu, line) { return wpl(dist(mu), isSpread ? line : -line, 1); }
      function probsB(mu, line) { return wpl(dist(mu), isSpread ? line : -line, -1); }
      var use = groupRows(rows);
      var conLine = mode(use.map(function (r) { return r.line; }));
      var muMkt = null, muModel = null, muApp = null, sd, pMktA_con;
      var wEff = isSpread ? w : w / 2;
      if (sigma) {
        rows.forEach(function (r) {
          r.mu = bisect(function (mu) { return probsA(mu, r.line).q; }, r.fairA, isSpread ? -60 : 0, isSpread ? 60 : cfg.totalMax);
          r.qCon = null;
        });
        muMkt = median(use.map(function (r) { return r.mu; }));
        if (model) muModel = isSpread ? (model.mu == null ? null : model.mu) : (model.totalMu == null ? null : model.totalMu);
        muApp = muModel == null ? muMkt : (1 - wEff) * muMkt + wEff * muModel;
        pMktA_con = probsA(muMkt, conLine).q;
        rows.forEach(function (r) { r.qCon = probsA(r.mu, conLine).q; });
        sd = stdev(use.map(function (r) { return r.qCon; }));
      } else {
        var same = use.filter(function (r) { return r.line === conLine; });
        pMktA_con = median(same.map(function (r) { return r.fairA; }));
        sd = stdev(same.map(function (r) { return r.fairA; }));
        rows.forEach(function (r) { r.qCon = r.line === conLine ? r.fairA : null; });
      }
      var marketMoved = rows.some(function (r) { return r.grp === 'newer' && r.qCon != null && Math.abs(r.qCon - pMktA_con) > MOVED; });
      function side(isA) {
        var offers = rows.map(function (r) {
          var o = isA ? r.A : r.B, dec = amToDec(o.price), off = r.line !== conLine;
          var res = { book: r.b.key, title: r.b.title, updated: r.b.last_update, price: o.price, point: o.point, dec: dec,
            implied: 1 / dec, bookFair: isA ? r.fairA : 1 - r.fairA, offLine: off, pModel: null, moved: false, grp: r.grp };
          if (isQuarter(o.point)) { res.pMkt = null; res.pApp = null; res.push = 0; res.ev = null; res.evMkt = null; return res; }
          if (sigma) {
            var f = isA ? probsA : probsB;
            var app = f(muApp, r.line), mk = f(muMkt, r.line);
            res.pMkt = mk.q; res.pApp = app.q; res.push = app.push;
            if (muModel != null) res.pModel = f(muModel, r.line).q;
            res.ev = app.win * (dec - 1) - app.lose;
            res.evMkt = mk.win * (dec - 1) - mk.lose;
          } else if (!off) {
            var p = isA ? pMktA_con : 1 - pMktA_con;
            res.pMkt = p; res.pApp = p; res.push = 0; res.ev = p * (dec - 1) - (1 - p); res.evMkt = res.ev;
          } else { res.pMkt = null; res.pApp = null; res.push = 0; res.ev = null; res.evMkt = null; return res; }
          res.moved = r.grp === 'main' ? marketMoved : r.grp === 'newer' ? res.evMkt > 0 : r.qCon != null && Math.abs(r.qCon - pMktA_con) > MOVED;
          return res;
        });
        var pMkt = isA ? pMktA_con : 1 - pMktA_con, pModel = null, pApp = pMkt;
        if (sigma) {
          var g = isA ? probsA : probsB;
          pApp = g(muApp, conLine).q;
          if (muModel != null) pModel = g(muModel, conLine).q;
        }
        var conPoint = isSpread ? (isA ? conLine : -conLine) : conLine;
        var name = isSpread ? (isA ? ev.home_team : ev.away_team) : (isA ? 'Over' : 'Under');
        return { id: name, label: name, side: isSpread ? (isA ? 'home' : 'away') : (isA ? 'over' : 'under'),
          point: conPoint, pMkt: pMkt, pModel: pModel, pApp: pApp, nBooks: use.length, sd: sd, offers: offers };
      }
      return { key: key, outcomes: isSpread ? [side(false), side(true)] : [side(true), side(false)], nBooks: rows.length, nWay: 2,
        consensusLine: conLine, muMkt: muMkt, muModel: muModel, muApp: muApp, lineModel: !!sigma, moved: marketMoved };
    }
    var sp = twoSided('spreads'); if (sp) out.markets.spreads = sp;
    var to = twoSided('totals'); if (to) out.markets.totals = to;
    return out;
  }

  // Expected value of a bet already taken, judged against today's market-only fair line.
  // Used for closing-line value: did the price we took beat where the market ended up?
  function evAtMarket(an, market, side, point, dec) {
    var m = an.markets[market]; if (!m) return null;
    var ev = an.event, cfg = an.cfg;
    if (market === 'h2h' || market === 'outrights') {
      var oc = m.outcomes.filter(function (o) { return o.side === side; })[0];
      return oc ? { p: oc.pMkt, ev: oc.pMkt * (dec - 1) - (1 - oc.pMkt) } : null;
    }
    if (m.muMkt == null) {
      var oc2 = m.outcomes.filter(function (o) { return o.side === side; })[0];
      if (!oc2 || oc2.point !== point) return null;
      return { p: oc2.pMkt, ev: oc2.pMkt * (dec - 1) - (1 - oc2.pMkt) };
    }
    var r;
    if (market === 'spreads') r = wpl(spreadDist(cfg, m.muMkt), side === 'home' ? point : -point, side === 'home' ? 1 : -1);
    else r = wpl(totalDist(cfg, m.muMkt), -point, side === 'over' ? 1 : -1);
    return { p: r.q, ev: r.win * (dec - 1) - r.lose };
  }

  // ---------- confidence (0-100) ----------
  function confidence(outcome, offer, ctx) {
    var parts = [], flags = [];
    var n = outcome.nBooks;
    var cov = 20 * clamp((n - 1) / 5, 0, 1);
    parts.push({ key: 'books', label: 'Books pricing it', pts: cov, max: 20, note: n + (n === 1 ? ' book' : ' books') });

    var p = clamp(offer.pMkt == null ? 0.5 : offer.pMkt, 0.001, 0.999);
    var rel = (outcome.sd || 0) * 0.5 / Math.max(0.05, Math.sqrt(p * (1 - p)));
    var agr = n < 2 ? 0 : 25 * clamp(1 - (rel - 0.005) / 0.03, 0, 1);
    parts.push({ key: 'agree', label: 'Books agree', pts: agr, max: 25, note: n < 2 ? 'only one book' : 'spread of ' + ((outcome.sd || 0) * 100).toFixed(1) + ' pts' });

    // The model earns points for agreeing with the market, not for disagreeing with it:
    // a simple model far from the market is more likely wrong than right.
    var mod, gap = null;
    if (offer.pModel == null) { mod = 8; parts.push({ key: 'model', label: 'Stats model agrees', pts: mod, max: 20, note: 'no model for this bet' }); }
    else {
      gap = offer.pModel - offer.pMkt;
      mod = 20 * clamp(1 - Math.abs(gap) / 0.08, 0, 1);
      parts.push({ key: 'model', label: 'Stats model agrees', pts: mod, max: 20,
        note: 'model ' + (offer.pModel * 100).toFixed(0) + '%, market ' + (offer.pMkt * 100).toFixed(0) + '%' });
    }

    var age = Math.max(0, (ctx.now - Date.parse(offer.updated)) / 60000);
    var fresh = 20 * clamp(1 - (age - 30) / 690, 0, 1);
    parts.push({ key: 'fresh', label: 'Fresh price', pts: fresh, max: 20, note: fmtAge(age) + ' old' });

    var rec = ctx.record && ctx.record[ctx.sportKey];
    var tr = 0, trNote = 'no graded picks yet';
    if (rec && rec.graded > 0) {
      tr = 15 * clamp(rec.graded / 200, 0, 1) * clamp(0.5 + rec.roi / 0.1, 0, 1);
      trNote = rec.graded + ' graded, ' + (rec.roi * 100).toFixed(1) + '% return';
    }
    parts.push({ key: 'record', label: 'Track record', pts: tr, max: 15, note: trNote });

    var score = cov + agr + mod + fresh + tr;
    if (offer.evMkt != null && offer.evMkt <= 0 && offer.ev > 0) {
      score -= 10;
      flags.push({ key: 'modelonly', text: 'The edge comes from the stats model, not from a better price. Without the model this bet is ' + (offer.evMkt * 100).toFixed(1) + '%.' });
    }
    if (gap != null && Math.abs(gap) >= 0.10) flags.push({ key: 'farapart', text: 'Model and market are far apart. The market usually knows something the model can’t see.' });
    if (offer.offLine) { score -= 8; flags.push({ key: 'offline', text: 'Different line than most books. The edge leans on the app’s score model.' }); }
    if (offer.moved) {
      score -= 30;
      flags.push({ key: 'moved', text: offer.grp === 'newer' ? 'Only this book has a fresh price; the rest are older. That usually means the market moved, not that this is value.'
        : 'A fresher price elsewhere has moved since this one was captured. It may be gone.' });
    }
    if (ctx.outright && n < 4) { score -= 15; flags.push({ key: 'thin', text: 'Fewer than four books price this, so the fair line is shaky.' }); }
    if (offer.ev > (ctx.outright ? 0.25 : 0.06)) { score -= 25; flags.push({ key: 'toogood', text: 'Looks too good. Usually a stale or mistaken price.' }); }
    return { score: Math.round(clamp(score, 0, 100)), parts: parts, flags: flags, ageMin: age };
  }
  function fmtAge(min) {
    if (min < 1) return 'under 1 min';
    if (min < 90) return Math.round(min) + ' min';
    if (min < 48 * 60) return (min / 60).toFixed(min < 600 ? 1 : 0) + ' h';
    return Math.round(min / 1440) + ' days';
  }
  function confLabel(s) { return s >= 70 ? 'High' : s >= 50 ? 'Medium' : 'Low'; }

  // Best offer for one outcome among the chosen books (by expected value, then by price).
  function bestOffer(outcome, bookSet, skipMoved) {
    var best = null;
    outcome.offers.forEach(function (o) {
      if (bookSet && !bookSet.has(o.book)) return;
      if (skipMoved && o.moved) return;
      if (!best) { best = o; return; }
      var a = o.ev == null ? -9 : o.ev, b = best.ev == null ? -9 : best.ev;
      if (a > b + 1e-12 || (Math.abs(a - b) <= 1e-12 && o.dec > best.dec)) best = o;
    });
    return best;
  }

  // ---------- recommendations ----------
  var MARKETS = ['h2h', 'spreads', 'totals', 'outrights'];
  function recommend(analyses, opts) {
    var recs = [];
    analyses.forEach(function (an) {
      var ev = an.event;
      if (Date.parse(ev.commence_time) <= opts.now) return;      // pregame only: once it starts, saved prices are closed
      MARKETS.forEach(function (mk) {
        var m = an.markets[mk]; if (!m) return;
        if (opts.markets && opts.markets.indexOf(mk) < 0) return;
        m.outcomes.forEach(function (oc) {
          var o = bestOffer(oc, opts.books, true);      // a price flagged as moved is never recommended
          if (!o || o.ev == null) return;
          var c = confidence(oc, o, { now: opts.now, record: opts.record, sportKey: ev.sport_key, outright: mk === 'outrights' });
          if (o.ev < opts.minEdge || c.score < opts.minConf) return;
          recs.push({ event: ev, market: mk, outcome: oc, offer: o, conf: c, cfg: an.cfg });
        });
      });
    });
    recs.sort(function (a, b) { return b.offer.ev * b.conf.score - a.offer.ev * a.conf.score; });
    return recs;
  }

  // ---------- arbitrage: two or three books disagree enough that backing every side locks a profit ----------
  function findArbs(analyses, opts) {
    var arbs = [], minRet = opts.minReturn == null ? 0.002 : opts.minReturn;
    function ok(o) { return (!opts.books || opts.books.has(o.book)) && !o.moved; }
    function push(ev, mk, legs) {
      var s = legs.reduce(function (a, l) { return a + 1 / l.dec; }, 0);
      if (s >= 1) return;
      var ret = 1 / s - 1; if (ret < minRet) return;
      var oldest = Math.min.apply(null, legs.map(function (l) { return Date.parse(l.updated); }));
      arbs.push({ event: ev, market: mk, ret: ret, ageMin: (opts.now - oldest) / 60000,
        legs: legs.map(function (l) { return { label: l.label, side: l.side, point: l.point, book: l.book, title: l.title, price: l.price, dec: l.dec, share: (1 / l.dec) / s }; }) });
    }
    analyses.forEach(function (an) {
      var ev = an.event;
      if (Date.parse(ev.commence_time) <= opts.now) return;
      var h = an.markets.h2h;
      if (h) {
        var legs = [], full = true;
        h.outcomes.forEach(function (oc) {
          var best = null;
          oc.offers.forEach(function (o) { if (ok(o) && (!best || o.dec > best.dec)) best = o; });
          if (!best) { full = false; return; }
          legs.push({ label: oc.label, side: oc.side, point: null, book: best.book, title: best.title, price: best.price, dec: best.dec, updated: best.updated });
        });
        if (full && legs.length === h.outcomes.length) push(ev, 'h2h', legs);
      }
      ['spreads', 'totals'].forEach(function (mk) {
        var m = an.markets[mk]; if (!m) return;
        var A = m.outcomes[0], B = m.outcomes[1], best = null;
        A.offers.forEach(function (a) {
          if (!ok(a) || isQuarter(a.point)) return;
          B.offers.forEach(function (b) {
            if (!ok(b) || isQuarter(b.point) || a.book === b.book) return;
            // safe when no final score loses both bets: +3.5 with -2.5, or Over 44.5 with Under 45.5
            var safe = mk === 'spreads' ? a.point + b.point >= -1e-9 : b.point - a.point >= -1e-9;
            if (!safe) return;
            var s = 1 / a.dec + 1 / b.dec;
            if (s < 1 && (!best || s < best.s)) best = { s: s, a: a, b: b };
          });
        });
        if (best) push(ev, mk, [
          { label: A.label, side: A.side, point: best.a.point, book: best.a.book, title: best.a.title, price: best.a.price, dec: best.a.dec, updated: best.a.updated },
          { label: B.label, side: B.side, point: best.b.point, book: best.b.book, title: best.b.title, price: best.b.price, dec: best.b.dec, updated: best.b.updated }]);
      });
    });
    arbs.sort(function (a, b) { return b.ret - a.ret; });
    return arbs;
  }

  return { amToDec: amToDec, amToProb: amToProb, decToAm: decToAm, probToAm: probToAm, fmtAm: fmtAm, median: median, stdev: stdev, clamp: clamp,
    devig: devig, normCdf: normCdf, makeDist: makeDist, wpl: wpl, NFL_KEYS: NFL_KEYS, sportCfg: sportCfg,
    analyzeEvent: analyzeEvent, evAtMarket: evAtMarket, confidence: confidence, confLabel: confLabel,
    bestOffer: bestOffer, recommend: recommend, findArbs: findArbs, fmtAge: fmtAge, spreadDist: spreadDist, totalDist: totalDist, isQuarter: isQuarter };
});

}).call(globalThis, module); return module.exports; })();
// ---- end of pricing engine ----

const ENV = process.env;
const NOW = ENV.FL_NOW ? Date.parse(ENV.FL_NOW) : Date.now();
const DATA_DIR = ENV.FL_DATA_DIR || 'data';
const B = {
  odds: ENV.FL_ODDS_BASE || 'https://api.the-odds-api.com',
  parlay: ENV.FL_PARLAY_BASE || 'https://parlay-api.com',
  espn: ENV.FL_ESPN_BASE || 'https://site.api.espn.com/apis/site/v2/sports',
  kalshi: ENV.FL_KALSHI_BASE || 'https://api.elections.kalshi.com/trade-api/v2',
  meteo: ENV.FL_METEO_BASE || 'https://api.open-meteo.com',
  geo: ENV.FL_GEO_BASE || 'https://geocoding-api.open-meteo.com',
  mlb: ENV.FL_MLB_BASE || 'https://statsapi.mlb.com',
  nhl: ENV.FL_NHL_BASE || 'https://api-web.nhle.com',
};
const ODDS_KEY = (ENV.ODDS_API_KEY || '').trim();
const PARLAY_KEY = (ENV.PARLAY_API_KEY || '').trim();
const HOUR = 3600e3, DAY = 86400e3;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const log = (...a) => console.log(...a);

// ---------- leagues the app can rate and grade (results come from ESPN's public scoreboard) ----------
// k, hfa, scale: rating speed, home edge and margin scaling. per: rating points per point, goal or run.
// prior: how many games of evidence a team needs before its rating is believed. cap: blowouts count only up to this margin.
// prevW: how much a game from last season counts next to one from this season. carry: share of a rating kept into a new season.
const SOCCER = { k: 18, hfa: 55, scale: 0.5, carry: 0.8, per: 155, prior: 10, cap: 4, prevW: 0.5 };
const LEAGUES = {
  americanfootball_nfl: { espn: 'football/nfl', title: 'NFL', kind: 'margin', elo: { k: 20, hfa: 42, scale: 1, per: 25, carry: 0.55, prior: 7, cap: 28, prevW: 0.5 }, pts: { lg: 22.5, alpha: 0.12, k: 4 }, rest: 'nfl', inj: 'nfl', weather: 'adjust' },
  americanfootball_ncaaf: { espn: 'football/college-football', q: 'groups=80', title: 'College football', kind: 'margin', elo: { k: 26, hfa: 60, scale: 1, per: 24, carry: 0.5, prior: 5, cap: 35, prevW: 0.4 }, pts: { lg: 27, alpha: 0.15, k: 4 }, weather: 'adjust', college: { start: [8, 20] } },
  basketball_nba: { espn: 'basketball/nba', title: 'NBA', kind: 'margin', elo: { k: 12, hfa: 65, scale: 2.5, per: 28, carry: 0.65, prior: 7, cap: 30, prevW: 0.13 }, pts: { lg: 114, alpha: 0.07, k: 8 }, rest: 'b2b', inj: 'starters' },
  basketball_wnba: { espn: 'basketball/wnba', title: 'WNBA', kind: 'margin', elo: { k: 14, hfa: 60, scale: 2.5, per: 28, carry: 0.6, prior: 7, cap: 30, prevW: 0.26 }, pts: { lg: 82, alpha: 0.08, k: 8 }, rest: 'b2b', inj: 'list' },
  basketball_ncaab: { espn: 'basketball/mens-college-basketball', q: 'groups=50', title: 'College basketball', kind: 'margin', elo: { k: 18, hfa: 90, scale: 2.5, per: 26, carry: 0.5, prior: 5, cap: 30, prevW: 0.17 }, pts: { lg: 72, alpha: 0.1, k: 6 }, college: { start: [11, 1] } },
  icehockey_nhl: { espn: 'hockey/nhl', title: 'NHL', kind: 'prob', elo: { k: 6, hfa: 22, scale: 0.6, carry: 0.5, per: 118, prior: 40, cap: 5, prevW: 0.3 }, pts: { lg: 3.05, alpha: 0.05, k: 15 }, rest: 'b2b', inj: 'list', goalie: true },
  baseball_mlb: { espn: 'baseball/mlb', title: 'MLB', kind: 'prob', elo: { k: 5, hfa: 20, scale: 1.5, carry: 0.5, per: 68, prior: 70, cap: 8, prevW: 0.35 }, pts: { lg: 4.4, alpha: 0.03, k: 30 }, inj: 'list', pitcher: true, weather: 'show' },
  soccer_epl: { espn: 'soccer/eng.1', title: 'Premier League', kind: 'soccer', elo: SOCCER },
  soccer_usa_mls: { espn: 'soccer/usa.1', title: 'MLS', kind: 'soccer', elo: SOCCER },
  soccer_uefa_champs_league: { espn: 'soccer/uefa.champions', title: 'Champions League', kind: 'soccer', elo: SOCCER },
  soccer_spain_la_liga: { espn: 'soccer/esp.1', title: 'La Liga', kind: 'soccer', elo: SOCCER },
  soccer_germany_bundesliga: { espn: 'soccer/ger.1', title: 'Bundesliga', kind: 'soccer', elo: SOCCER },
  soccer_italy_serie_a: { espn: 'soccer/ita.1', title: 'Serie A', kind: 'soccer', elo: SOCCER },
  soccer_france_ligue_one: { espn: 'soccer/fra.1', title: 'Ligue 1', kind: 'soccer', elo: SOCCER },
  mma_mixed_martial_arts: { espn: 'mma/ufc', title: 'MMA', kind: 'fights' },
};
const KALSHI_SERIES = {
  americanfootball_nfl: 'KXNFLGAME', americanfootball_ncaaf: 'KXNCAAFGAME', basketball_nba: 'KXNBAGAME', basketball_wnba: 'KXWNBAGAME',
  basketball_ncaab: 'KXNCAAMBGAME', icehockey_nhl: 'KXNHLGAME', baseball_mlb: 'KXMLBGAME', soccer_epl: 'KXEPLGAME', soccer_usa_mls: 'KXMLSGAME',
  soccer_uefa_champs_league: 'KXUCLGAME', soccer_spain_la_liga: 'KXLALIGAGAME', soccer_germany_bundesliga: 'KXBUNDESLIGAGAME',
  soccer_italy_serie_a: 'KXSERIEAGAME', soccer_france_ligue_one: 'KXLIGUE1GAME', mma_mixed_martial_arts: 'KXUFCFIGHT',
};
const BOOK_TITLES = { draftkings: 'DraftKings', fanduel: 'FanDuel', betmgm: 'BetMGM', williamhill_us: 'Caesars', fanatics: 'Fanatics', betrivers: 'BetRivers',
  hardrockbet: 'Hard Rock Bet', espnbet: 'theScore Bet', bet365: 'bet365', pinnacle: 'Pinnacle', kalshi: 'Kalshi', polymarket: 'Polymarket', novig: 'Novig',
  prophetx: 'ProphetX', bovada: 'Bovada', betonlineag: 'BetOnline', ballybet: 'Bally Bet', betparx: 'betPARX', fliff: 'Fliff', lowvig: 'LowVig', mybookieag: 'MyBookie', betus: 'BetUS' };
const PARLAY_BOOK_KEYS = { caesars: 'williamhill_us', hardrock: 'hardrockbet', betonline: 'betonlineag', parx: 'betparx' };

// ---------- run status, shown on the app's Data page ----------
const status = { run_at: iso(NOW), sources: {}, calls: {} };
function src(name, patch) { status.sources[name] = Object.assign(status.sources[name] || { ok: null }, patch, { at: iso(NOW) }); }

// ---------- small helpers ----------
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
function readJSON(file, fallback) { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); } catch { return fallback; } }
function writeJSON(file, obj) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(obj)); }
const etFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
function etDay(ms) { return etFmt.format(new Date(ms)).replace(/-/g, ''); }           // ESPN and MLB group games by US Eastern date
function etDays(from, to) { const out = []; for (let k = from; k <= to; k++) { const d = etDay(NOW + k * DAY); if (out.indexOf(d) < 0) out.push(d); } return out; }
function parseAm(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) && v !== 0 ? Math.round(v) : null;
  const s = String(v).trim().toUpperCase();
  if (s === 'EVEN' || s === 'EV') return 100;
  return /^[+-]?\d+$/.test(s) && Number(s) !== 0 ? Number(s) : null;
}
function okAm(a) { return a != null && Number.isFinite(a) && (a >= 100 || a <= -100) && Math.abs(a) <= 100000; }

let httpBudget = 1400;                       // hard cap on requests in one run
async function getJSON(url, opt = {}) {
  const host = url.replace(/^https?:\/\//, '').split('/')[0];
  status.calls[host] = (status.calls[host] || 0) + 1;
  if (--httpBudget < 0) return { ok: false, status: 0, error: 'request cap for this run reached' };
  const tries = opt.tries || 2;
  let last = { ok: false, status: 0, error: 'no attempt' };
  for (let i = 0; i < tries; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opt.timeout || 25000);
    try {
      const res = await fetch(url, { headers: Object.assign({ 'user-agent': 'fair-line-app (personal project)', accept: 'application/json' }, opt.headers || {}), signal: ctl.signal });
      const text = await res.text();
      clearTimeout(timer);
      let data = null; try { data = JSON.parse(text); } catch { /* not JSON */ }
      last = { ok: res.ok && data != null, status: res.status, data, headers: res.headers, error: res.ok ? (data == null ? 'reply was not JSON: ' + text.slice(0, 80) : null) : 'HTTP ' + res.status + ' ' + text.slice(0, 120).replace(/\s+/g, ' ') };
      if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) return last;
    } catch (e) {
      clearTimeout(timer);
      last = { ok: false, status: 0, error: e.name === 'AbortError' ? 'timed out' : String(e.message || e).slice(0, 120) };
    }
    await new Promise((r) => setTimeout(r, 600 * (i + 1)));
  }
  return last;
}
function shape(x) { return Array.isArray(x) ? 'array(' + x.length + ')' : x && typeof x === 'object' ? 'object{' + Object.keys(x).slice(0, 8).join(',') + '}' : typeof x; }

// ---------- matching team names across sources ----------
const STOP = new Set(['fc', 'cf', 'afc', 'sc', 'ac', 'as', 'cd', 'ud', 'rc', 'rcd', 'sv', 'vfb', 'vfl', 'tsg', 'fsv', 'ss', 'ssc', 'us', 'club', 'de', 'the', 'and', 'of']);
const ALIAS = [[/\bla\b/g, 'los angeles'], [/\bny\b/g, 'new york'], [/\bsaint\b/g, 'st'], [/\binternazionale\b/g, 'inter milan'], [/\bathletic club\b/g, 'athletic bilbao'],
  [/\blafc\b/g, 'los angeles'], [/\bman\b/g, 'manchester'], [/\butd\b/g, 'united'], [/\bwolves\b/g, 'wolverhampton wanderers'], [/\bspurs\b/g, 'tottenham hotspur'], [/\bpsg\b/g, 'paris st germain']];
const normCache = new Map();
function norm(name) {
  if (normCache.has(name)) return normCache.get(name);
  let s = String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/['’.]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  for (const [re, to] of ALIAS) s = s.replace(re, to);
  const toks = s.split(' ').filter((t) => t && !STOP.has(t) && !/^\d+$/.test(t));
  const out = { s: toks.join(' '), t: new Set(toks) };
  normCache.set(name, out);
  return out;
}
function nameScore(a, b) {
  const A = norm(a), C = norm(b);
  if (!A.s || !C.s) return 0;
  if (A.s === C.s) return 1;
  let inter = 0; for (const t of A.t) if (C.t.has(t)) inter++;
  if (inter && inter === Math.min(A.t.size, C.t.size)) return 0.9;
  return (2 * inter) / (A.t.size + C.t.size);
}
function pairScore(h1, a1, h2, a2) {
  const straight = Math.min(nameScore(h1, h2), nameScore(a1, a2));
  const swapped = Math.min(nameScore(h1, a2), nameScore(a1, h2));
  return swapped > straight ? { score: swapped, swapped: true } : { score: straight, swapped: false };
}
const MULTI = ['red sox', 'white sox', 'blue jays', 'maple leafs', 'red wings', 'blue jackets', 'golden knights', 'trail blazers'];
function shortName(full) {
  const low = String(full).toLowerCase();
  for (const m of MULTI) if (low.endsWith(m)) return full.slice(full.length - m.length);
  return full;
}

// =====================================================================================
// STATE
// =====================================================================================
const state = readJSON('state.json', null) || { version: 2, created_at: iso(NOW) };
for (const k of ['feeds', 'events', 'ratings', 'sched', 'venues', 'depth', 'goalies', 'wx']) state[k] = state[k] || {};
{
  // prices and line history are kept once, in the file the app reads
  const prev = readJSON('latest.json', null);
  for (const pe of (prev && prev.events) || []) {
    const ev = state.events[pe.id]; if (!ev) continue;
    ev.books = {};
    for (const b of pe.bookmakers || []) ev.books[b.key] = { title: b.title, last_update: b.last_update, src: b.src, markets: b.markets };
    ev.hist = pe.hist || {}; if (pe.open) ev.open = pe.open;
  }
  for (const ev of Object.values(state.events)) { ev.books = ev.books || {}; ev.hist = ev.hist || {}; }
}
const picksFile = readJSON('picks.json', null) || { picks: [] };
const firstRun = !state.last_run;
const gapDays = state.last_run ? Math.min(6, Math.max(0, (NOW - Date.parse(state.last_run)) / DAY)) : 0;

function wants(key) { return CONFIG.sports.some((p) => p === key || (p.endsWith('*') && key.startsWith(p.slice(0, -1)))); }
function rank(key) { const i = CONFIG.sports.findIndex((p) => p === key || (p.endsWith('*') && key.startsWith(p.slice(0, -1)))); return i < 0 ? 99 : i; }

// =====================================================================================
// ESPN: schedule, results, DraftKings lines
// =====================================================================================
function num(s) { if (s == null) return null; const v = typeof s === 'object' ? s.value : Number(s); return Number.isFinite(v) ? v : null; }
function espnOdds(o) {
  if (!o || !o.provider) return null;
  const prov = String(o.provider.name || '').toLowerCase();
  const key = prov.includes('draftkings') ? 'draftkings' : prov.includes('espn') || prov.includes('score') ? 'espnbet' : prov.includes('caesars') ? 'williamhill_us' : null;
  if (!key) return null;
  function side(which) {
    const r = {};
    const ml = o.moneyline || {};
    r.h = parseAm(ml.home && ml.home[which] && ml.home[which].odds);
    r.a = parseAm(ml.away && ml.away[which] && ml.away[which].odds);
    r.d = parseAm(ml.draw && ml.draw[which] && ml.draw[which].odds);
    if (which === 'close' && r.d == null && o.drawOdds) r.d = parseAm(o.drawOdds.moneyLine);
    const ps = o.pointSpread || {};
    const hl = ps.home && ps.home[which], al = ps.away && ps.away[which];
    if (hl && al) { r.sl = Number(hl.line); r.sh = parseAm(hl.odds); r.sa = parseAm(al.odds); }
    const t = o.total || {};
    const ov = t.over && t.over[which], un = t.under && t.under[which];
    if (ov && un) { r.tl = Number(String(ov.line).replace(/[^0-9.]/g, '')); r.to = parseAm(ov.odds); r.tu = parseAm(un.odds); }
    return r;
  }
  return { key, close: side('close'), open: side('open') };
}
function parseEspnEvent(e, fights) {
  const out = [];
  const comps = e.competitions || [];
  for (const c of comps) {
    const cs = c.competitors || [];
    let h = cs.find((x) => x.homeAway === 'home'), a = cs.find((x) => x.homeAway === 'away');
    if (fights) { h = cs[0]; a = cs[1]; }
    if (!h || !a) continue;
    const st = (fights ? c.status : (e.status || c.status)) || c.status || {};
    const ty = st.type || {};
    const tm = (x) => fights
      ? { id: String(x.id), name: (x.athlete && (x.athlete.displayName || x.athlete.fullName)) || '', short: (x.athlete && x.athlete.shortName) || '', abbr: '', score: null, winner: x.winner === true }
      : { id: String(x.team && x.team.id || x.id), name: (x.team && x.team.displayName) || '', short: (x.team && (x.team.shortDisplayName || x.team.name)) || '', abbr: (x.team && x.team.abbreviation) || '', score: num(x.score), winner: x.winner === true };
    const v = c.venue || {}, ad = v.address || {};
    const ev = {
      id: String(fights ? c.id : e.id), date: c.date || e.date, yr: e.season && e.season.year, stype: e.season && e.season.type,
      state: ty.state || 'pre', done: ty.completed === true, sname: ty.name || '',
      neutral: c.neutralSite === true, indoor: v.indoor === true ? true : v.indoor === false ? false : null,
      venue: v.fullName ? { id: String(v.id || hash(v.fullName)), name: v.fullName, city: ad.city || '', st: ad.state || '', country: ad.country || '' } : null,
      home: tm(h), away: tm(a), odds: !fights && ty.state === 'pre' && c.odds && c.odds[0] ? espnOdds(c.odds[0]) : null,
    };
    if (ev.home.name && ev.away.name && ev.date) out.push(ev);
    if (!fights) break;
  }
  return out;
}
async function espnDayFetch(key, lg, day) {
  const url = `${B.espn}/${lg.espn}/scoreboard?dates=${day}&limit=500${lg.q ? '&' + lg.q : ''}`;
  const r = await getJSON(url);
  if (!r.ok) return { ok: false, error: r.error };
  const d = r.data || {};
  const yr = d.leagues && d.leagues[0] && d.leagues[0].season && d.leagues[0].season.year;
  const evs = [];
  for (const e of d.events || []) for (const x of parseEspnEvent(e, lg.kind === 'fights')) evs.push(x);
  return { ok: true, events: evs, seasonYear: yr };
}

// ---------- ratings ----------
function ratingsFor(key) {
  const lg = LEAGUES[key];
  return state.ratings[key] = state.ratings[key] || { teams: {}, lg: lg.pts ? lg.pts.lg : 1.4, done: {}, boot: {} };
}
function teamOf(R, lg, t, yr) {
  let x = R.teams[t.id];
  if (!x) x = R.teams[t.id] = { n: t.name, e: 1500, g: 0, pf: R.lg, pa: R.lg, yr: yr || null, last: null };
  if (t.name) x.n = t.name;
  if (yr && x.yr && yr > x.yr) x.e = 1500 + (x.e - 1500) * lg.elo.carry;      // new season: pull part-way back to average
  if (yr && (!x.yr || yr > x.yr)) x.yr = yr;
  return x;
}
// One finished game moves both teams' ratings (Elo with margin of victory) and their scoring rates.
function applyResult(key, g) {
  const lg = LEAGUES[key], R = ratingsFor(key), E = lg.elo;
  if (!E || g.home.score == null || g.away.score == null || R.done[g.id]) return false;
  const h = teamOf(R, lg, g.home, g.yr), a = teamOf(R, lg, g.away, g.yr);
  const diff = h.e - a.e + (g.neutral ? 0 : E.hfa);
  const exp = 1 / (1 + Math.pow(10, -diff / 400));
  const m = g.home.score - g.away.score;
  const res = m > 0 ? 1 : m < 0 ? 0 : 0.5;
  const wdiff = m > 0 ? diff : -diff;
  const G = m === 0 ? 0.7 : Math.log(Math.abs(m) / E.scale + 1) * (2.2 / Math.max(0.8, wdiff * 0.001 + 2.2));
  const delta = E.k * G * (res - exp);
  h.e += delta; a.e -= delta;
  if (lg.pts) {
    const al = lg.pts.alpha;
    h.pf += al * (g.home.score - h.pf); h.pa += al * (g.away.score - h.pa);
    a.pf += al * (g.away.score - a.pf); a.pa += al * (g.home.score - a.pa);
    R.lg += (al / 8) * ((g.home.score + g.away.score) / 2 - R.lg);
  }
  h.g++; a.g++;
  const d = Date.parse(g.date);
  if (!h.last || d > Date.parse(h.last)) h.last = g.date;
  if (!a.last || d > Date.parse(a.last)) a.last = g.date;
  R.done[g.id] = Math.floor(d / DAY);
  R.games = (R.games || 0) + 1;
  return true;
}
function usable(g) { return g.done && g.home.score != null && g.away.score != null && g.stype !== 1 && !/POSTPONED|CANCEL|FORFEIT|ABANDON/i.test(g.sname); }

// Starting ratings: fit every team at once from two seasons of margins, so a team's rating accounts for
// who it played. Recent games count more, blowouts are capped, and teams with few games stay near average.
const HALF_LIFE = Number(ENV.FL_TUNE_HALF) || 400, PRIOR_SCALE = Number(ENV.FL_TUNE_PRIOR) || 1, PREV_SCALE = Number(ENV.FL_TUNE_PREV) || 1;      // test hooks; leave unset
function fitRatings(key, games) {
  const lg = LEAGUES[key], E = lg.elo, R = ratingsFor(key);
  games.sort((x, z) => Date.parse(x.date) - Date.parse(z.date));
  for (const g of games) applyResult(key, g);                 // sets games played, scoring rates, last game
  const hfa = E.hfa / E.per, r = {}, rows = [];
  const curYr = games.reduce((m, g) => Math.max(m, g.yr || 0), 0);
  for (const g of games) {
    const w = (g.yr && g.yr < curYr ? E.prevW * PREV_SCALE : 1) * Math.pow(0.5, (NOW - Date.parse(g.date)) / (HALF_LIFE * DAY));
    const m = Math.max(-E.cap, Math.min(E.cap, g.home.score - g.away.score)) - (g.neutral ? 0 : hfa);
    rows.push([g.home.id, g.away.id, m, w]); r[g.home.id] = 0; r[g.away.id] = 0;
  }
  for (let it = 0; it < 80; it++) {
    const num = {}, den = {};
    for (const [h, a, m, w] of rows) {
      num[h] = (num[h] || 0) + w * (m + r[a]); den[h] = (den[h] || 0) + w;
      num[a] = (num[a] || 0) + w * (-m + r[h]); den[a] = (den[a] || 0) + w;
    }
    for (const id of Object.keys(r)) r[id] = num[id] / (den[id] + E.prior * PRIOR_SCALE);
  }
  const ids = Object.keys(r), mean = ids.reduce((s, id) => s + r[id], 0) / Math.max(1, ids.length);
  for (const id of ids) if (R.teams[id]) R.teams[id].e = 1500 + (r[id] - mean) * E.per;
}

// First-time history for a league.
async function bootstrap(key, seasonYear, budget) {
  const lg = LEAGUES[key], R = ratingsFor(key);
  if (!lg.elo || R.boot.done) return 0;
  let used = 0;
  if (lg.college || R.boot.mode === 'walk') {
    // too many teams to fetch one by one (or that route failed): walk the season a day at a time, over several runs if needed
    let start = NOW - 150 * DAY;
    if (lg.college) {
      const y = new Date(NOW).getUTCFullYear(), [mo, da] = lg.college.start;
      start = Date.UTC(y, mo - 1, da, 12);
      if (start > NOW) start = Date.UTC(y - 1, mo - 1, da, 12);
      if (NOW - start > 250 * DAY) { R.boot = { done: true, at: iso(NOW), note: 'out of season' }; return 0; }
    }
    let cur = R.boot.cursor ? Date.parse(R.boot.cursor) : start;
    const end = NOW - 3 * DAY, gs = R.boot.gs = R.boot.gs || [];
    while (cur <= end && used < budget) {
      const r = await espnDayFetch(key, lg, etDay(cur)); used++;
      if (!r.ok) { R.boot.error = r.error; return used; }
      for (const g of r.events.filter(usable)) gs.push([g.id, g.date, g.home.id, g.home.name, g.home.score, g.away.id, g.away.name, g.away.score, g.neutral ? 1 : 0, g.yr || 0]);
      cur += DAY; R.boot.cursor = iso(cur);
    }
    if (cur > end) {
      fitRatings(key, gs.map((x) => ({ id: x[0], date: x[1], home: { id: x[2], name: x[3], score: x[4] }, away: { id: x[5], name: x[6], score: x[7] }, neutral: !!x[8], yr: x[9] || null })));
      R.boot = { done: true, at: iso(NOW), games: gs.length };
    }
    return used;
  }
  const giveUp = (why) => { R.boot.error = why; R.boot.tries = (R.boot.tries || 0) + 1; if (R.boot.tries >= 2) R.boot = { mode: 'walk', error: why }; };
  if (!seasonYear) return 0;
  const tl = await getJSON(`${B.espn}/${lg.espn}/teams?limit=1000`); used++;
  const teams = tl.ok && tl.data.sports && tl.data.sports[0] && tl.data.sports[0].leagues && tl.data.sports[0].leagues[0] && tl.data.sports[0].leagues[0].teams;
  if (!teams || !teams.length) { giveUp('team list: ' + (tl.error || shape(tl.data))); return used; }
  if (teams.length * 2 + 1 > budget) return used;         // not enough room this run; try next run
  const ids = new Set(teams.map((t) => String(t.team.id)));
  const games = new Map();
  let fails = 0;
  for (const season of [seasonYear - 1, seasonYear]) {
    for (const t of teams) {
      const r = await getJSON(`${B.espn}/${lg.espn}/teams/${t.team.id}/schedule?season=${season}${lg.kind === 'soccer' ? '' : '&seasontype=2'}`); used++;
      if (!r.ok) { fails++; continue; }
      for (const e of r.data.events || []) {
        if (!e.season) e.season = { year: season };
        if (e.seasonType && e.season.type == null) e.season.type = e.seasonType.type;
        for (const g of parseEspnEvent(e, false)) {
          if (!ids.has(g.home.id) || !ids.has(g.away.id)) continue;      // skip cup ties against outside teams
          if (!g.yr) g.yr = season;
          if (usable(g) && Date.parse(g.date) < NOW) games.set(g.id, g);
        }
      }
    }
  }
  if (fails > teams.length || games.size < teams.length * 2) { giveUp('team schedules: ' + fails + ' failed, ' + games.size + ' games read'); return used; }
  fitRatings(key, [...games.values()]);
  R.boot = { done: true, at: iso(NOW), games: games.size };
  return used;
}

// The schedule kept between runs is tiny: ids, time, teams, venue if outdoors, final score.
const fetched = {};          // sportKey -> Map(id -> full event from this run, with DraftKings line)
function keepSched(S, g, fights) {
  S.tm[g.home.id] = { n: g.home.name, sh: g.home.short, ab: g.home.abbr };
  S.tm[g.away.id] = { n: g.away.name, sh: g.away.short, ab: g.away.abbr };
  const c = { d: g.date, h: g.home.id, a: g.away.id, st: g.state };
  if (g.neutral) c.n = 1;
  if (g.indoor != null) c.i = g.indoor ? 1 : 0;
  if (g.indoor === false && g.venue) c.v = g.venue;
  if (g.done && g.home.score != null && g.away.score != null) c.f = [g.home.score, g.away.score];
  if (g.done && fights) c.w = g.home.winner ? 'h' : g.away.winner ? 'a' : 'd';
  if (/POSTPONED|CANCEL/i.test(g.sname)) c.x = 1;
  S.ev[g.id] = c;
}
async function runEspn(activeKeys) {
  let bootBudget = 330, okLeagues = 0, failLeagues = 0, newResults = 0, lastErr = null;
  const keys = Object.keys(LEAGUES).filter((k) => wants(k)).sort((a, b) => rank(a) - rank(b));
  for (const key of keys) {
    const lg = LEAGUES[key], fights = lg.kind === 'fights';
    const S = state.sched[key] = state.sched[key] || {};
    S.ev = S.ev || {}; S.tm = S.tm || {};
    if (S.idle_until && Date.parse(S.idle_until) > NOW && !(activeKeys && activeKeys.has(key))) continue;
    const back = Math.max(2, Math.ceil(gapDays) + 1);
    const needExt = !S.ext_at || NOW - Date.parse(S.ext_at) > 6 * HOUR;
    const days = etDays(-back, needExt ? (lg.college && key.startsWith('basketball') ? 3 : 8) : 1);
    const F = fetched[key] = new Map();
    let failed = false, seasonYear = S.season || null;
    for (const d of days) {
      const r = await espnDayFetch(key, lg, d);
      if (!r.ok) { failed = true; lastErr = r.error; break; }
      if (r.seasonYear) seasonYear = r.seasonYear;
      for (const g of r.events) { F.set(g.id, g); keepSched(S, g, fights); if (!r.seasonYear && g.yr && (!seasonYear || g.yr > seasonYear)) seasonYear = g.yr; }
    }
    if (failed) { failLeagues++; continue; }
    okLeagues++;
    S.season = seasonYear;
    const any = Object.values(S.ev).some((c) => Date.parse(c.d) > NOW - 4 * DAY);
    if (needExt) { S.ext_at = iso(NOW); S.idle_until = any ? null : iso(NOW + 3 * DAY); }
    for (const id of Object.keys(S.ev)) if (Date.parse(S.ev[id].d) < NOW - (back + 1.5) * DAY) delete S.ev[id];
    if (!lg.elo) continue;
    const R = ratingsFor(key);
    if (!R.boot.done && any && bootBudget > 0) bootBudget -= await bootstrap(key, seasonYear, bootBudget);
    if (R.boot.done) {
      [...F.values()].filter(usable).sort((x, z) => Date.parse(x.date) - Date.parse(z.date)).forEach((g) => { if (applyResult(key, g)) newResults++; });
      const cut = Math.floor(NOW / DAY) - 12;
      for (const id of Object.keys(R.done)) if (R.done[id] < cut) delete R.done[id];
      for (const t of Object.values(R.teams)) { t.e = +t.e.toFixed(1); t.pf = +t.pf.toFixed(3); t.pa = +t.pa.toFixed(3); }
      R.lg = +R.lg.toFixed(4);
    }
  }
  const rated = keys.filter((k) => LEAGUES[k].elo && state.ratings[k] && state.ratings[k].boot.done && !state.ratings[k].boot.note).length;
  const building = keys.filter((k) => LEAGUES[k].elo && state.sched[k] && state.sched[k].ext_at && !state.sched[k].idle_until && !(state.ratings[k] && state.ratings[k].boot.done)).map((k) => LEAGUES[k].title);
  src('ESPN scores and schedule', { ok: okLeagues > 0 && failLeagues === 0 ? true : okLeagues > 0 ? 'partial' : false, items: okLeagues + ' leagues', note: newResults + ' new results', error: failLeagues ? failLeagues + ' leagues failed: ' + lastErr : null });
  src('Team ratings', { ok: rated > 0 ? (building.length ? 'partial' : true) : building.length ? 'partial' : null, items: rated + ' leagues rated', note: building.length ? 'still building: ' + building.join(', ') : 'fitted from two seasons of results, then updated game by game', error: null });
}

// =====================================================================================
// EVENT STORE: one record per game, with every book from every source
// =====================================================================================
const idIndex = new Map();
for (const ev of Object.values(state.events)) for (const k of Object.values(ev.ids || {})) idIndex.set(k, ev.id);
function resolveEvent(sportKey, title, home, away, commence, srcName, srcId, extra) {
  const t = Date.parse(commence);
  if (srcId && idIndex.has(srcName + ':' + srcId)) {
    const ev = state.events[idIndex.get(srcName + ':' + srcId)];
    if (ev) { if (srcName === 'oddsapi' || !ev.locked) ev.commence_time = commence; return { ev, swapped: !!(ev.swaps && ev.swaps[srcName]) }; }
  }
  let best = null;
  if (home && away) {
    for (const ev of Object.values(state.events)) {
      if (ev.sport_key !== sportKey || ev.outright) continue;
      if (Math.abs(Date.parse(ev.commence_time) - t) > 8 * HOUR) continue;
      const p = pairScore(ev.home_team, ev.away_team, home, away);
      if (p.score >= 0.7 && (!best || p.score > best.p.score)) best = { ev, p };
    }
  } else {
    for (const ev of Object.values(state.events)) if (ev.sport_key === sportKey && ev.outright && nameScore(ev.title || '', title || '') >= 0.7) best = { ev, p: { swapped: false } };
  }
  let ev, swapped = false;
  if (best) { ev = best.ev; swapped = best.p.swapped; }
  else {
    const id = srcName === 'oddsapi' && srcId ? srcId : 'fl' + hash([sportKey, home, away, commence.slice(0, 10), title].join('|'));
    ev = state.events[id] = Object.assign({ id, sport_key: sportKey, sport_title: title, commence_time: commence, home_team: home || null, away_team: away || null, first_seen: iso(NOW), books: {}, ids: {}, hist: {} }, extra || {});
  }
  ev.ids = ev.ids || {};
  if (srcId) { ev.ids[srcName] = srcName + ':' + srcId; idIndex.set(srcName + ':' + srcId, ev.id); }
  if (swapped) { ev.swaps = ev.swaps || {}; ev.swaps[srcName] = 1; }
  if (srcName === 'oddsapi') { ev.commence_time = commence; if (title) ev.sport_title = title; }
  return { ev, swapped };
}
// Map a source's outcome names onto the event's own team names.
function renameOutcomes(ev, markets, srcHome, srcAway) {
  if (ev.outright || (srcHome === ev.home_team && srcAway === ev.away_team)) return markets;
  const direct = nameScore(srcHome, ev.home_team) >= nameScore(srcHome, ev.away_team);
  const map = {}; map[srcHome] = direct ? ev.home_team : ev.away_team; map[srcAway] = direct ? ev.away_team : ev.home_team;
  return markets.map((m) => ({ key: m.key, last_update: m.last_update, outcomes: m.outcomes.map((o) => Object.assign({}, o, { name: map[o.name] || (/^(draw|tie)$/i.test(o.name) ? 'Draw' : o.name) })) }));
}
function cleanMarkets(markets) {
  const out = [];
  for (const m of markets || []) {
    if (['h2h', 'spreads', 'totals', 'outrights'].indexOf(m.key) < 0) continue;
    const oc = (m.outcomes || []).map((o) => ({ name: /^(draw|tie)$/i.test(o.name) ? 'Draw' : o.name, price: parseAm(o.price), point: o.point == null ? undefined : Number(o.point) }))
      .filter((o) => o.name && okAm(o.price) && (m.key === 'h2h' || m.key === 'outrights' || Number.isFinite(o.point)));
    if (oc.length >= 2) out.push({ key: m.key, outcomes: oc });
  }
  return out;
}
function putBook(ev, key, title, lastUpdate, source, markets) {
  if (!markets.length) return;
  const cur = ev.books[key];
  if (cur && Date.parse(cur.last_update) > Date.parse(lastUpdate)) return;      // keep the fresher price
  if (cur && source === 'espn' && cur.src !== 'espn' && NOW - Date.parse(cur.last_update) < 45 * 60e3) return;   // a direct feed price from this run beats ESPN's copy
  ev.books[key] = { title: title || BOOK_TITLES[key] || key, last_update: lastUpdate, src: source, markets };
}

// ESPN's DraftKings line: a free price that refreshes every run. Also links games to results.
function schedGame(key, id) {
  const F = fetched[key], S = state.sched[key];
  if (F && F.has(id)) return F.get(id);
  const c = S.ev[id], tm = (tid) => Object.assign({ id: tid, name: '', short: '', abbr: '', score: null, winner: false }, S.tm[tid] ? { name: S.tm[tid].n, short: S.tm[tid].sh, abbr: S.tm[tid].ab } : {});
  const g = { id, date: c.d, state: c.st, done: !!c.f || !!c.w, sname: c.x ? 'STATUS_POSTPONED' : '', neutral: !!c.n, indoor: c.i == null ? null : !!c.i, venue: c.v || null, home: tm(c.h), away: tm(c.a), odds: null };
  if (c.f) { g.home.score = c.f[0]; g.away.score = c.f[1]; }
  if (c.w) { g.home.winner = c.w === 'h'; g.away.winner = c.w === 'a'; }
  return g;
}
function espnIntoStore() {
  let n = 0;
  for (const key of Object.keys(state.sched)) {
    const lg = LEAGUES[key]; if (!lg || !state.sched[key].ev) continue;
    for (const id of Object.keys(state.sched[key].ev)) {
      const g = schedGame(key, id);
      const t = Date.parse(g.date);
      if (!g.home.name || !g.away.name) continue;
      const known = idIndex.has('espn:' + g.id);
      if (t < NOW - 8 * HOUR && !known) continue;          // older games matter only for grading picks already linked
      const hasOdds = !!g.odds && g.state === 'pre' && t > NOW && t < NOW + 3 * DAY;
      if (!hasOdds && !known) {
        // only link games a feed already knows; do not create empty events
        let hit = null;
        for (const ev of Object.values(state.events)) {
          if (ev.sport_key !== key || ev.outright || Math.abs(Date.parse(ev.commence_time) - t) > 8 * HOUR) continue;
          if (pairScore(ev.home_team, ev.away_team, g.home.name, g.away.name).score >= 0.7) { hit = ev; break; }
        }
        if (!hit) continue;
      }
      const { ev, swapped } = resolveEvent(key, lg.title, g.home.name, g.away.name, g.date, 'espn', g.id);
      const H = swapped ? g.away : g.home, A = swapped ? g.home : g.away;
      ev.espn = { id: g.id, home: { id: H.id, short: H.short, abbr: H.abbr }, away: { id: A.id, short: A.short, abbr: A.abbr }, neutral: g.neutral, indoor: g.indoor, venue: g.venue, state: g.state };
      if (swapped) ev.espn.swapped = true;
      if (g.done && g.home.score != null) ev.final = { home: H.score, away: A.score };
      if (lg.kind === 'fights' && g.done) ev.final = { winner: H.winner ? 'home' : A.winner ? 'away' : 'draw' };
      if (/POSTPONED|CANCEL/i.test(g.sname)) ev.void = true;
      if (!hasOdds) continue;
      const c = g.odds.close, mk = [];
      const hN = swapped ? ev.away_team : ev.home_team, aN = swapped ? ev.home_team : ev.away_team;     // ESPN's home and away, in the event's names
      if (okAm(c.h) && okAm(c.a)) {
        const oc = [{ name: aN, price: c.a }, { name: hN, price: c.h }];
        if (lg.kind === 'soccer') { if (okAm(c.d)) { oc.push({ name: 'Draw', price: c.d }); mk.push({ key: 'h2h', outcomes: oc }); } }
        else mk.push({ key: 'h2h', outcomes: oc });
      }
      if (Number.isFinite(c.sl) && okAm(c.sh) && okAm(c.sa) && lg.kind !== 'soccer') mk.push({ key: 'spreads', outcomes: [{ name: aN, price: c.sa, point: -c.sl || 0 }, { name: hN, price: c.sh, point: c.sl || 0 }] });
      if (Number.isFinite(c.tl) && c.tl > 0 && okAm(c.to) && okAm(c.tu)) mk.push({ key: 'totals', outcomes: [{ name: 'Over', price: c.to, point: c.tl }, { name: 'Under', price: c.tu, point: c.tl }] });
      if (mk.length) { putBook(ev, g.odds.key, null, iso(NOW), 'espn', mk); n++; }
      const o = g.odds.open;
      if (!ev.open && !swapped && (Number.isFinite(o.sl) || okAm(o.h))) ev.open = { src: BOOK_TITLES[g.odds.key], spread: Number.isFinite(o.sl) ? o.sl : null, total: Number.isFinite(o.tl) && o.tl > 0 ? o.tl : null, ml_home: okAm(o.h) ? o.h : null, ml_away: okAm(o.a) ? o.a : null };
    }
  }
  return n;
}

// =====================================================================================
// ODDS FEEDS, with a credit budget that lasts the month
// =====================================================================================
function nextGameHours(key) {
  let best = null;
  for (const ev of Object.values(state.events)) if (ev.sport_key === key && !ev.outright) { const h = (Date.parse(ev.commence_time) - NOW) / HOUR; if (h > 0 && (best == null || h < best)) best = h; }
  const S = state.sched[key];
  if (S && S.ev) for (const c of Object.values(S.ev)) { const h = (Date.parse(c.d) - NOW) / HOUR; if (h > 0 && (best == null || h < best)) best = h; }
  return best;
}
function marketsFor(key, outright) {
  if (outright) return 'outrights';
  if (key.startsWith('soccer_')) return 'h2h,totals';
  if (/^(americanfootball|basketball|icehockey|baseball)_/.test(key)) return 'h2h,spreads,totals';
  return 'h2h';
}
function plan(feed, monthly, cands) {
  const F = state.feeds[feed] = state.feeds[feed] || { sports: {} };
  const remaining = F.remaining == null ? monthly : F.remaining;
  const d = new Date(NOW);
  const monthEnd = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  const daysLeft = Math.max(1, (monthEnd - NOW) / DAY);
  const reserve = Math.min(20, monthly * 0.04);
  const perDay = Math.max(0, (remaining - reserve) / daysLeft);
  if (F.bank == null || (F.month != null && F.month !== d.getUTCMonth())) F.bank = Math.min(60, remaining * 0.15);   // first run: fill the board
  else F.bank = Math.min(perDay * 1.5 + 6, F.bank + perDay * Math.max(0, NOW - Date.parse(F.bank_at)) / DAY);
  F.bank_at = iso(NOW); F.month = d.getUTCMonth(); F.per_day = +perDay.toFixed(1);
  const scored = [];
  for (const c of cands) {
    const last = F.sports[c.key] && F.sports[c.key].at;
    const age = last ? (NOW - Date.parse(last)) / HOUR : 999;
    const nx = c.outright ? null : nextGameHours(c.key);
    let score, gap;
    if (c.outright) { score = age / 30; gap = 20; }
    else if (nx == null) { score = last ? age / 24 : 40; gap = 20; }
    else if (nx > 96) { score = 0.05 * age; gap = 24; }
    else if (nx > 30) { score = 0.5 * age; gap = 12; }
    else if (nx > 8) { score = 1.5 * age; gap = 5; }
    else { score = 3 * age; gap = 2.5; }
    if (last && F.sports[c.key].empty && age < 20) continue;      // nothing listed last time; do not keep asking
    if (age < gap) continue;
    scored.push(Object.assign({ score: score / (1 + rank(c.key) * 0.08) }, c));
  }
  scored.sort((a, b) => b.score - a.score);
  const chosen = [];
  let bank = F.bank;
  for (const c of scored) { if (c.cost <= bank && c.cost <= remaining - reserve - (F.bank - bank)) { chosen.push(c); bank -= c.cost; } }
  return { F, chosen };
}
function noteUsage(F, headers, cost) {
  const remH = headers && (headers.get('x-requests-remaining') != null ? headers.get('x-requests-remaining') : headers.get('x-credits-remaining'));
  const rem = Number(remH), used = Number(headers && headers.get('x-requests-used')), last = Number(headers && headers.get('x-requests-last'));
  if (remH != null && Number.isFinite(rem)) F.remaining = rem;
  else if (F.remaining != null) F.remaining -= cost;
  if (headers && headers.get('x-requests-used') != null && Number.isFinite(used)) F.used = used;
  F.bank = Math.max(0, (F.bank || 0) - (Number.isFinite(last) && headers.get('x-requests-last') != null ? last : cost));
}
function ingest(feed, sportKey, title, list, keyMap) {
  let n = 0;
  for (const e of list) {
    if (!e || !e.commence_time || !Array.isArray(e.bookmakers)) continue;
    const outright = !e.home_team || !e.away_team;
    const t = Date.parse(e.commence_time);
    if (t <= NOW || (!outright && t > NOW + 8.5 * DAY)) continue;      // pregame only; started games keep their last pregame prices
    const { ev } = resolveEvent(sportKey, e.sport_title || title, e.home_team, e.away_team, new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z'), feed, String(e.id || ''), outright ? { outright: true, title: e.sport_title || title } : null);
    for (const b of e.bookmakers) {
      const key = (keyMap && keyMap[b.key]) || b.key;
      let mk = cleanMarkets(b.markets);
      if (!outright) mk = renameOutcomes(ev, mk, e.home_team, e.away_team);
      const lu = b.last_update && Number.isFinite(Date.parse(b.last_update)) ? iso(Math.min(NOW, Date.parse(b.last_update))) : iso(NOW);
      putBook(ev, key, BOOK_TITLES[key] || b.title, lu, feed, mk);
    }
    n++;
  }
  return n;
}

async function runOddsApi() {
  const name = 'The Odds API';
  if (!ODDS_KEY) { src(name, { ok: false, error: 'No key set. Add the ODDS_API_KEY secret in the repository settings.' }); return new Set(); }
  const F0 = state.feeds.oddsapi = state.feeds.oddsapi || { sports: {} };
  const sp = await getJSON(`${B.odds}/v4/sports/?apiKey=${ODDS_KEY}`);
  if (!sp.ok || !Array.isArray(sp.data)) { src(name, { ok: false, error: sp.status === 401 ? 'The key was rejected. Check the ODDS_API_KEY secret.' : 'sports list: ' + (sp.error || shape(sp.data)) }); return new Set(); }
  const active = sp.data.filter((s) => s.active && wants(s.key));
  F0.titles = F0.titles || {};
  for (const s of active) F0.titles[s.key] = { title: s.title, group: s.group };
  const activeKeys = new Set(active.map((s) => s.key));
  const cands = active.filter((s) => !s.has_outrights || s.key.startsWith('golf_')).map((s) => {
    const mk = marketsFor(s.key, s.has_outrights);
    return { key: s.key, title: s.title, outright: !!s.has_outrights, markets: mk, cost: mk.split(',').length };
  });
  const { F, chosen } = plan('oddsapi', CONFIG.oddsApi.monthlyCredits, cands);
  let events = 0, fails = 0, lastErr = null, spent = 0;
  for (const c of chosen) {
    const base = `${B.odds}/v4/sports/${c.key}/odds/?apiKey=${ODDS_KEY}&markets=${c.markets}&oddsFormat=american&dateFormat=iso`;
    let r = await getJSON(`${base}&bookmakers=${CONFIG.oddsApi.books.slice(0, 10).join(',')}`, { tries: 1 });
    if (!r.ok && r.status >= 400 && r.status < 500 && r.status !== 401 && r.status !== 429) r = await getJSON(`${base}&regions=us`, { tries: 1 });   // some plans reject a book list
    if (!r.ok || !Array.isArray(r.data)) {
      fails++; lastErr = r.status === 429 ? 'out of credits or too many requests' : (r.error || shape(r.data));
      if (r.status === 401 || r.status === 429) break;
      continue;
    }
    noteUsage(F, r.headers, r.data.length ? c.cost : 0); spent += r.data.length ? c.cost : 0;
    const n = ingest('oddsapi', c.key, c.title, r.data, null);
    F.sports[c.key] = { at: iso(NOW), n, empty: r.data.length === 0 };
    events += n;
  }
  src(name, { ok: fails === 0 ? true : chosen.length > fails ? 'partial' : false, items: chosen.length - fails + ' sports refreshed, ' + events + ' events',
    note: (F.remaining == null ? '?' : F.remaining) + ' credits left this month, about ' + F.per_day + ' a day to spend' + (chosen.length ? '' : '. Nothing was due this run'), error: lastErr });
  return activeKeys;
}

async function runParlay(activeKeys) {
  const name = 'ParlayAPI';
  if (!PARLAY_KEY) { src(name, { ok: null, note: 'Optional second feed. Add the PARLAY_API_KEY secret to turn it on.' }); return; }
  const H = { headers: { 'X-API-Key': PARLAY_KEY } };
  const sp = await getJSON(`${B.parlay}/v1/sports`, H);
  const list = sp.ok ? (Array.isArray(sp.data) ? sp.data : sp.data.sports || sp.data.data) : null;
  if (!Array.isArray(list)) { src(name, { ok: false, error: sp.status === 401 || sp.status === 403 ? 'The key was rejected. Check the PARLAY_API_KEY secret.' : 'sports list: ' + (sp.error || shape(sp.data)) }); return; }
  const golf = list.filter((s) => s && s.key && /golf|pga/i.test(s.key + ' ' + (s.title || '')));
  const cands = [];
  for (const s of list) {
    if (!s || !s.key || s.active === false) continue;
    const isGolf = golf.indexOf(s) >= 0;
    if (!isGolf && !wants(s.key)) continue;
    if (isGolf && !wants('golf_x')) continue;
    const outright = isGolf || s.has_outrights === true;
    const mk = marketsFor(s.key, outright);
    cands.push({ key: s.key, title: s.title || s.key, outright, markets: mk, cost: mk.split(',').length });
  }
  const { F, chosen } = plan('parlay', CONFIG.parlay.monthlyCredits, cands);
  let events = 0, fails = 0, lastErr = null, diag = null;
  for (const c of chosen) {
    const r = await getJSON(`${B.parlay}/v1/sports/${c.key}/odds?markets=${c.markets}&oddsFormat=american&bookmakers=${CONFIG.parlay.books.slice(0, 10).join(',')}`, Object.assign({ tries: 1 }, H));
    const data = r.ok ? (Array.isArray(r.data) ? r.data : r.data.data || r.data.events) : null;
    if (!Array.isArray(data)) {
      fails++; lastErr = r.error || 'unexpected reply: ' + shape(r.data);
      if (r.status === 401 || r.status === 403 || r.status === 429) break;
      continue;
    }
    noteUsage(F, r.headers, data.length ? c.cost : 0);
    const n = ingest('parlay', c.key, c.title, data, PARLAY_BOOK_KEYS);
    if (data.length && !n && !diag) diag = 'events not understood: ' + shape(data[0]);
    F.sports[c.key] = { at: iso(NOW), n, empty: data.length === 0 };
    events += n;
  }
  src(name, { ok: fails === 0 && !diag ? true : chosen.length > fails ? 'partial' : false, items: chosen.length - fails + ' sports refreshed, ' + events + ' events',
    note: (F.remaining == null ? '?' : F.remaining) + ' credits left this month' + (golf.length ? ', golf keys: ' + golf.map((g) => g.key).slice(0, 4).join(', ') : ', no golf listed'), error: lastErr || diag });
}

// =====================================================================================
// KALSHI: a public prediction market, used as one more price
// =====================================================================================
function kalshiPrice(m) {
  const ask = Number(m.yes_ask_dollars != null ? m.yes_ask_dollars : m.yes_ask / 100), bid = Number(m.yes_bid_dollars != null ? m.yes_bid_dollars : m.yes_bid / 100);
  if (!(ask > 0.01 && ask < 0.99) || !(bid >= 0) || ask - bid > 0.1 || ask <= bid) return null;
  const cost = ask + 0.07 * ask * (1 - ask);                // price plus Kalshi's trading fee
  if (cost >= 0.995) return null;
  return FL.decToAm(1 / cost);
}
async function runKalshi() {
  const name = 'Kalshi';
  const bySport = {};
  for (const ev of Object.values(state.events)) if (!ev.outright && KALSHI_SERIES[ev.sport_key] && Date.parse(ev.commence_time) > NOW && Date.parse(ev.commence_time) < NOW + 8 * DAY) (bySport[ev.sport_key] = bySport[ev.sport_key] || []).push(ev);
  const keys = Object.keys(bySport);
  if (!keys.length) { src(name, { ok: null, note: 'No upcoming games to look up yet.' }); return; }
  let matched = 0, seen = 0, fails = 0, lastErr = null;
  for (const key of keys) {
    let cursor = '', pages = 0;
    do {
      const r = await getJSON(`${B.kalshi}/events?series_ticker=${KALSHI_SERIES[key]}&status=open&with_nested_markets=true&limit=200${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`, { tries: 1 });
      if (!r.ok || !Array.isArray(r.data.events)) { fails++; lastErr = r.error || shape(r.data); break; }
      for (const ke of r.data.events) {
        const mks = (ke.markets || []).filter((m) => m.status === 'active' && m.market_type !== 'scalar');
        if (mks.length < 2 || mks.length > 3) continue;
        seen++;
        const title = String(ke.title || '');
        const md = /-(\d{2})([A-Z]{3})(\d{2})/.exec(String(ke.event_ticker || ''));
        const kd = md ? Date.parse(`${md[2]} ${md[3]}, 20${md[1]} 12:00 UTC`) : NaN;
        let best = null;
        for (const ev of bySport[key]) {
          if (Number.isFinite(kd) && Math.abs(Date.parse(ev.commence_time) - kd) > 1.6 * DAY) continue;
          const tn = norm(title).t;
          const hit = (nm) => { const t = [...norm(nm).t]; return t.filter((x) => tn.has(x)).length / t.length; };
          const sc = Math.min(hit(ev.home_team), hit(ev.away_team));
          if (sc >= 0.3 && (!best || sc > best.sc)) best = { ev, sc };
        }
        if (!best) continue;
        const ev = best.ev, oc = [];
        const used = new Set();
        for (const m of mks) {
          const label = String(m.yes_sub_title || m.title || '');
          let who = null;
          if (/^(tie|draw)/i.test(label)) who = 'Draw';
          else {
            const sh = nameScore(label, ev.home_team), sa = nameScore(label, ev.away_team);
            const part = (nm) => { const t = norm(label).t, u = norm(nm).t; let k = 0; for (const x of t) if (u.has(x)) k++; return t.size ? k / t.size : 0; };
            const ph = Math.max(sh, part(ev.home_team)), pa = Math.max(sa, part(ev.away_team));
            if (ph > pa && ph >= 0.5) who = ev.home_team; else if (pa > ph && pa >= 0.5) who = ev.away_team;
          }
          const price = kalshiPrice(m);
          if (!who || used.has(who) || price == null) continue;
          used.add(who); oc.push({ name: who, price });
        }
        const need = LEAGUES[key] && LEAGUES[key].kind === 'soccer' ? 3 : 2;
        if (oc.length !== need || !used.has(ev.home_team) || !used.has(ev.away_team)) continue;
        putBook(ev, 'kalshi', 'Kalshi', iso(NOW), 'kalshi', [{ key: 'h2h', outcomes: oc }]);
        matched++;
      }
      cursor = r.data.cursor || ''; pages++;
    } while (cursor && pages < 3);
  }
  src(name, { ok: fails === 0 ? true : fails < keys.length ? 'partial' : false, items: matched + ' games priced', note: seen + ' markets seen in ' + keys.length + ' sports. Prices include Kalshi’s fee.', error: lastErr });
}

// =====================================================================================
// GAME FACTORS: injuries, starters, rest, weather
// =====================================================================================
const injuries = {};          // sportKey -> teamId -> [{n, pos, s, date}]
function injStatus(i) {
  const ty = String((i.type && i.type.name) || i.status || '').toUpperCase();
  if (/(^|_)OUT$|(^|_)IR$|RESERVE|DOUBTFUL|SUSPEN/.test(ty)) return 'out';
  if (/QUESTION/.test(ty)) return 'q';
  return null;
}
// A starter's season line, pulled toward league average until he has innings behind him.
function pitchLine(sp) {
  if (!sp) return null;
  const ipS = String(sp.inningsPitched || '0').split('.'), ip = Number(ipS[0]) + Number(ipS[1] || 0) / 3;
  const runs = Number(sp.runs);
  if (!(ip > 0) || !Number.isFinite(runs)) return null;
  const LG = 4.4, reg = ((runs + (LG / 9) * 50) / (ip + 50)) * 9;
  return { ip: Math.round(ip), ra9: +(runs * 9 / ip).toFixed(2), adj: +((LG - reg) * (5.3 / 9)).toFixed(2) };
}
async function runInjuries() {
  let ok = 0, fail = 0, total = 0, lastErr = null;
  for (const key of Object.keys(LEAGUES)) {
    const lg = LEAGUES[key];
    if (!lg.inj || !wants(key) || !Object.values(state.events).some((e) => e.sport_key === key && e.espn && Date.parse(e.commence_time) > NOW)) continue;
    const r = await getJSON(`${B.espn}/${lg.espn}/injuries`);
    if (!r.ok || !Array.isArray(r.data.injuries)) { fail++; lastErr = r.error || shape(r.data); continue; }
    ok++;
    const map = injuries[key] = {};
    for (const t of r.data.injuries) {
      const arr = [];
      for (const i of t.injuries || []) {
        const s = injStatus(i);
        if (!s || !i.athlete) continue;
        arr.push({ n: i.athlete.displayName, pos: (i.athlete.position && i.athlete.position.abbreviation) || '', s, date: i.date || null, why: (i.details && i.details.type) || '' });
      }
      map[String(t.id)] = arr; total += arr.length;
    }
  }
  if (ok + fail) src('ESPN injuries', { ok: fail === 0 ? true : ok ? 'partial' : false, items: total + ' players out or questionable', note: ok + ' leagues', error: lastErr });
}
async function startersFor(key, teamId) {
  const lg = LEAGUES[key], ck = key + '|' + teamId, c = state.depth[ck];
  if (c && NOW - Date.parse(c.at) < 20 * HOUR) return c.st;
  const r = await getJSON(`${B.espn}/${lg.espn}/teams/${teamId}/depthcharts`, { tries: 1 });
  if (!r.ok || !Array.isArray(r.data.depthchart)) { state.depth[ck] = { at: iso(NOW), st: c ? c.st : null, err: r.error || shape(r.data) }; return c ? c.st : null; }
  const st = {};
  for (const f of r.data.depthchart) for (const [pos, v] of Object.entries(f.positions || {})) {
    const p = pos.toLowerCase();
    if (['pk', 'p', 'h', 'ls', 'kr', 'pr', 'k'].indexOf(p) >= 0) continue;
    const first = v.athletes && v.athletes[0] && v.athletes[0].displayName;
    if (first && !st[p]) st[p] = first;
  }
  state.depth[ck] = { at: iso(NOW), st };
  return st;
}
async function runWeather() {
  let ok = 0, fail = 0, lastErr = null;
  const todo = Object.values(state.events).filter((e) => {
    const lg = LEAGUES[e.sport_key];
    if (!lg || !e.espn || !e.espn.venue || e.espn.indoor !== false) return false;
    const h = (Date.parse(e.commence_time) - NOW) / HOUR;
    if (h < 0 || h > (lg.weather ? 7 * 24 : 3 * 24)) return false;
    if (!lg.weather && lg.kind !== 'soccer') return false;
    const w = state.wx[e.id];
    return !w || NOW - Date.parse(w.at) > (h < 24 ? 2 : 6) * HOUR;
  }).sort((a, b) => Date.parse(a.commence_time) - Date.parse(b.commence_time)).slice(0, 90);
  for (const e of todo) {
    const v = e.espn.venue, vk = v.id;
    if (state.venues[vk] === undefined) {
      const us = /^usa?$/i.test(v.country) || (!v.country && /^[A-Z]{2}$/.test(v.st));
      const g = await getJSON(`${B.geo}/v1/search?name=${encodeURIComponent(v.city)}&count=10&language=en&format=json${us ? '&countryCode=US' : ''}`, { tries: 1 });
      const rs = g.ok && Array.isArray(g.data.results) ? g.data.results : null;
      if (!rs) { if (g.ok) state.venues[vk] = null; else { fail++; lastErr = g.error; } continue; }
      const stName = US_STATES[v.st];
      const pick = rs.filter((x) => !stName || x.admin1 === stName).sort((a, b) => (b.population || 0) - (a.population || 0))[0] || (stName ? null : rs[0]);
      state.venues[vk] = pick ? { lat: +pick.latitude.toFixed(3), lon: +pick.longitude.toFixed(3) } : null;
    }
    const loc = state.venues[vk];
    if (!loc) continue;
    const t = Date.parse(e.commence_time), d0 = new Date(t).toISOString().slice(0, 10), d1 = new Date(t + 4 * HOUR).toISOString().slice(0, 10);
    const r = await getJSON(`${B.meteo}/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&hourly=temperature_2m,precipitation_probability,precipitation,wind_speed_10m,wind_gusts_10m&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=UTC&start_date=${d0}&end_date=${d1}`, { tries: 1 });
    const hr = r.ok && r.data.hourly;
    if (!hr || !Array.isArray(hr.time)) { fail++; lastErr = r.error || shape(r.data); continue; }
    const idx = [];
    hr.time.forEach((s, i) => { const ht = Date.parse(s + ':00Z'); if (ht >= t - HOUR && ht <= t + 3 * HOUR) idx.push(i); });
    if (!idx.length) continue;
    const pickv = (k) => idx.map((i) => hr[k] && hr[k][i]).filter((x) => x != null);
    const mx = (a) => (a.length ? Math.max(...a) : null), av = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    if (!pickv('temperature_2m').length || !pickv('wind_speed_10m').length) continue;
    state.wx[e.id] = { at: iso(NOW), temp: Math.round(av(pickv('temperature_2m'))), wind: Math.round(mx(pickv('wind_speed_10m'))), gust: Math.round(mx(pickv('wind_gusts_10m'))), rain: mx(pickv('precipitation_probability')), inches: +(pickv('precipitation').reduce((x, y) => x + y, 0)).toFixed(2) };
    ok++;
  }
  for (const id of Object.keys(state.wx)) if (!state.events[id] || Date.parse(state.events[id].commence_time) < NOW - DAY) delete state.wx[id];
  if (todo.length) src('Weather (Open-Meteo)', { ok: fail === 0 ? true : ok ? 'partial' : false, items: ok + ' forecasts refreshed', note: Object.keys(state.wx).length + ' outdoor games covered', error: lastErr });
  else if (!status.sources['Weather (Open-Meteo)']) src('Weather (Open-Meteo)', { ok: Object.keys(state.wx).length ? true : null, items: Object.keys(state.wx).length + ' outdoor games covered', note: 'Nothing was due this run.' });
}
const US_STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' };

const pitchers = {};          // eventId -> {home:{n, ra9, ip, adj}, away:{...}}
async function runPitchers() {
  const evs = Object.values(state.events).filter((e) => e.sport_key === 'baseball_mlb' && Date.parse(e.commence_time) > NOW && Date.parse(e.commence_time) < NOW + 4 * DAY);
  if (!evs.length) return;
  const name = 'MLB probable pitchers';
  const days = etDays(0, 4), d = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`;
  const r = await getJSON(`${B.mlb}/api/v1/schedule?sportId=1&startDate=${d(days[0])}&endDate=${d(days[days.length - 1])}&hydrate=probablePitcher`);
  if (!r.ok || !Array.isArray(r.data.dates)) { src(name, { ok: false, error: r.error || shape(r.data) }); return; }
  const games = [], ids = new Set();
  for (const day of r.data.dates) for (const g of day.games || []) {
    const hp = g.teams && g.teams.home && g.teams.home.probablePitcher, ap = g.teams && g.teams.away && g.teams.away.probablePitcher;
    if (!g.teams || !g.teams.home.team) continue;
    games.push({ t: Date.parse(g.gameDate), home: g.teams.home.team.name, away: g.teams.away.team.name, hp, ap });
    if (hp) ids.add(hp.id); if (ap) ids.add(ap.id);
  }
  const stats = {};
  if (ids.size) {
    const yr = new Date(NOW).getUTCFullYear();
    const p = await getJSON(`${B.mlb}/api/v1/people?personIds=${[...ids].join(',')}&hydrate=stats(group=[pitching],type=[season],season=${yr})`);
    if (p.ok && Array.isArray(p.data.people)) for (const person of p.data.people) {
      const sp = person.stats && person.stats[0] && person.stats[0].splits && person.stats[0].splits[0] && person.stats[0].splits[0].stat;
      const line = pitchLine(sp);
      if (line) stats[person.id] = line;
    }
  }
  let n = 0;
  for (const e of evs) {
    const t = Date.parse(e.commence_time);
    const g = games.find((x) => Math.abs(x.t - t) < 3 * HOUR && pairScore(e.home_team, e.away_team, x.home, x.away).score >= 0.7);
    if (!g) continue;
    const mk = (p) => (p ? Object.assign({ n: p.fullName }, stats[p.id] || {}) : null);
    pitchers[e.id] = { home: mk(g.hp), away: mk(g.ap) };
    if (g.hp || g.ap) n++;
  }
  src(name, { ok: true, items: n + ' games with a named starter', note: Object.keys(stats).length + ' pitchers with season stats' });
}
const NHL_CODES = { TB: 'TBL', NJ: 'NJD', LA: 'LAK', SJ: 'SJS', UTAH: 'UTA' };
async function goaliesFor(abbr) {
  const code = NHL_CODES[abbr] || abbr, c = state.goalies[code];
  if (c && NOW - Date.parse(c.at) < 20 * HOUR) return c.list;
  const r = await getJSON(`${B.nhl}/v1/club-stats/${code}/now`, { tries: 1 });
  if (!r.ok || !Array.isArray(r.data.goalies)) { state.goalies[code] = { at: iso(NOW), list: c ? c.list : null, err: r.error || shape(r.data) }; return c ? c.list : null; }
  const list = r.data.goalies.map((g) => ({ n: ((g.firstName && g.firstName.default) || '') + ' ' + ((g.lastName && g.lastName.default) || ''), gs: g.gamesStarted || 0, sa: g.shotsAgainst || 0, sv: g.saves || 0 }))
    .sort((a, b) => b.gs - a.gs || b.sa - a.sa);
  state.goalies[code] = { at: iso(NOW), list };
  return list;
}

// Days since each team's previous game, counting games still to be played before this one.
function restDays(key, teamId, t) {
  const R = state.ratings[key], S = state.sched[key];
  let prev = null;
  const tm = R && R.teams[teamId];
  if (tm && tm.last && Date.parse(tm.last) < t - HOUR) prev = Date.parse(tm.last);
  if (S && S.ev) for (const c of Object.values(S.ev)) {
    if (c.h !== teamId && c.a !== teamId) continue;
    const gt = Date.parse(c.d);
    if (gt < t - 3 * HOUR && (prev == null || gt > prev)) prev = gt;
  }
  return prev == null ? null : (t - prev) / DAY;
}

// =====================================================================================
// THE STATS MODEL: ratings plus the factors above
// =====================================================================================
async function buildModel(ev) {
  const key = ev.sport_key, lg = LEAGUES[key];
  ev.model = null; ev.context = null;
  if (!lg || !ev.espn || ev.outright) return;
  const t = Date.parse(ev.commence_time);
  const ctx = {}, parts = [];
  const hid = ev.espn.home.id, aid = ev.espn.away.id;

  // rest
  if (lg.rest) {
    const rh = restDays(key, hid, t), ra = restDays(key, aid, t);
    if (rh != null || ra != null) ctx.rest = { home: rh == null ? null : +rh.toFixed(1), away: ra == null ? null : +ra.toFixed(1) };
  }
  // injuries and starters
  const inj = injuries[key];
  let starters = { home: null, away: null };
  if (inj) {
    const useDepth = (lg.inj === 'nfl' || lg.inj === 'starters') && t - NOW < 5 * DAY && t > NOW;
    if (useDepth) { starters.home = await startersFor(key, hid); starters.away = await startersFor(key, aid); }
    ctx.inj = {};
    for (const side of ['home', 'away']) {
      const list = (inj[side === 'home' ? hid : aid] || []).map((x) => {
        const st = starters[side];
        let pos = null;
        if (st) for (const [p, n] of Object.entries(st)) if (n === x.n) { pos = p; break; }
        return Object.assign({}, x, { st: pos });
      });
      list.sort((a, b) => (b.st ? 1 : 0) - (a.st ? 1 : 0) || (a.s === 'out' ? 0 : 1) - (b.s === 'out' ? 0 : 1));
      ctx.inj[side] = { n_out: list.filter((x) => x.s === 'out').length, n_q: list.filter((x) => x.s === 'q').length,
        top: list.slice(0, 5).map((x) => ({ n: x.n, pos: (x.st || x.pos || '').toUpperCase(), s: x.s, st: !!x.st })) , all: list };
    }
  }
  // weather
  const wx = state.wx[ev.id];
  if (ev.espn.indoor === true) ctx.wx = { indoor: true };
  else if (wx) ctx.wx = { temp: wx.temp, wind: wx.wind, gust: wx.gust, rain: wx.rain, inches: wx.inches };
  // starters by sport
  if (pitchers[ev.id]) ctx.sp = pitchers[ev.id];
  if (lg.goalie && ev.espn.home.abbr && t - NOW < 3 * DAY && t > NOW) {
    ctx.goalie = {};
    for (const side of ['home', 'away']) {
      const list = await goaliesFor(ev.espn[side].abbr);
      if (!list || !list.length) continue;
      const rest = ctx.rest && ctx.rest[side];
      const b2b = rest != null && rest < 1.3 && list.length > 1;
      const g = b2b ? list[1] : list[0];
      const LG = 0.903, reg = (g.sv + LG * 600) / (g.sa + 600);
      ctx.goalie[side] = { n: g.n.trim(), svp: g.sa ? +(g.sv / g.sa).toFixed(3) : null, gs: g.gs, guess: b2b ? 'backup, second night in a row' : 'usual starter', adj: +((reg - LG) * 29).toFixed(3) };
    }
  }

  // ---- ratings ----
  const R = state.ratings[key], E = lg.elo;
  const h = R && R.teams[hid], a = R && R.teams[aid];
  const haveCtx = Object.keys(ctx).length > 0;
  if (!E || !R || !R.boot.done || !h || !a || h.g < 5 || a.g < 5) { ev.context = haveCtx ? stripCtx(ctx) : null; ev.model_note = !E ? null : !R || !R.boot.done ? 'ratings still being built' : 'not enough games yet for one of these teams'; return; }
  ev.model_note = null;
  const unit = lg.kind === 'margin' ? (x) => (x / E.per >= 0 ? '+' : '−') + Math.abs(x / E.per).toFixed(1) + ' pts' : (x) => (x >= 0 ? '+' : '−') + Math.abs(x * 0.144).toFixed(1) + '% win chance';
  let diff = h.e - a.e;
  parts.push({ label: 'Team ratings (' + ev.espn.home.short + ' ' + Math.round(h.e) + ', ' + ev.espn.away.short + ' ' + Math.round(a.e) + ')', text: unit(diff) });
  const hf = ev.espn.neutral || ev.neutral_site ? 0 : E.hfa;
  if (hf) parts.push({ label: 'Home field', text: unit(hf) }); else parts.push({ label: 'Neutral site', text: 'no home edge' });
  diff += hf;
  let totalAdj = 0;
  const add = (side, elo, label) => { if (!elo) return; diff += side === 'home' ? elo : -elo; parts.push({ label, text: unit(side === 'home' ? elo : -elo) }); };
  if (ctx.rest) for (const side of ['home', 'away']) {
    const r = ctx.rest[side], nm = ev.espn[side].short; if (r == null) continue;
    if (lg.rest === 'b2b' && r < 1.3) add(side, key === 'icehockey_nhl' ? -25 : -45, nm + ' on a second night in a row');
    if (lg.rest === 'nfl' && r < 5.5) add(side, -10, nm + ' on a short week');
    if (lg.rest === 'nfl' && r > 12.5 && r < 20) add(side, 15, nm + ' off a bye');
  }
  if (ctx.inj && (lg.inj === 'nfl' || lg.inj === 'starters')) for (const side of ['home', 'away']) {
    const list = ctx.inj[side].all.filter((x) => x.st);
    let elo = 0; const names = [];
    for (const x of list) {
      const w = x.s === 'out' ? 1 : 0.3;
      const old = x.date && NOW - Date.parse(x.date) > 21 * DAY ? 0.45 : 1;      // ratings have partly absorbed a long absence
      const base = lg.inj === 'nfl' ? (x.st === 'qb' ? 110 : 6) : 35;
      elo += base * w * old;
      if (x.st === 'qb' || lg.inj === 'starters') names.push(x.n + (x.s === 'q' ? ' (questionable)' : ''));
    }
    const cap = lg.inj === 'nfl' ? 150 : 110;
    elo = Math.min(cap, elo);
    if (elo >= 3) add(side, -elo, ev.espn[side].short + ' starters out' + (names.length ? ': ' + names.slice(0, 3).join(', ') : ' (' + list.length + ')'));
  }
  if (ctx.sp) for (const side of ['home', 'away']) {
    const p = ctx.sp[side];
    if (p && p.adj != null) { add(side, Math.round(p.adj * E.per), 'Starter ' + p.n + ' (' + p.ra9 + ' runs per 9)'); totalAdj -= p.adj; }
  }
  if (ctx.goalie) for (const side of ['home', 'away']) {
    const g = ctx.goalie[side];
    if (g && Math.abs(g.adj) >= 0.01) { add(side, Math.round(g.adj * E.per), 'Goalie ' + g.n + ' (' + g.guess + ')'); totalAdj -= g.adj; }
  }
  const model = { parts };
  if (lg.kind === 'margin') model.mu = +(diff / E.per).toFixed(2);
  else if (lg.kind === 'prob') { const p = 1 / (1 + Math.pow(10, -diff / 400)); model.p = { home: +p.toFixed(4), away: +(1 - p).toFixed(4) }; }
  else if (lg.kind === 'soccer') {
    const e = 1 / (1 + Math.pow(10, -diff / 400));
    let d = 0.27 * 4 * e * (1 - e), ph = Math.max(0.03, e - d / 2), pa = Math.max(0.03, 1 - e - d / 2);
    const s = ph + pa + d; model.p = { home: +(ph / s).toFixed(4), draw: +(d / s).toFixed(4), away: +(pa / s).toFixed(4) };
  }
  if (lg.pts) {
    const sh = (x) => x.g / (x.g + lg.pts.k);
    let tot = 2 * R.lg + sh(h) * (h.pf - R.lg) + sh(a) * (a.pa - R.lg) + sh(a) * (a.pf - R.lg) + sh(h) * (h.pa - R.lg);
    const tparts = [{ label: 'Scoring rates of both teams', text: tot.toFixed(1) }];
    if (lg.weather === 'adjust' && ctx.wx && !ctx.wx.indoor) {
      let w = 0;
      if (ctx.wx.wind > 12) w -= Math.min(5, 0.3 * (ctx.wx.wind - 12));
      if (ctx.wx.rain >= 60 && ctx.wx.inches >= 0.05) w -= 1.5;
      if (ctx.wx.temp < 20) w -= 1;
      if (w) { tot += w; tparts.push({ label: 'Weather', text: w.toFixed(1) + ' pts' }); }
    }
    if (totalAdj) { tot += totalAdj; tparts.push({ label: 'Starters', text: (totalAdj >= 0 ? '+' : '') + totalAdj.toFixed(1) }); }
    model.totalMu = +tot.toFixed(2); model.tparts = tparts;
  }
  ev.model = model;
  ev.context = stripCtx(ctx);
}
function stripCtx(ctx) {
  const c = JSON.parse(JSON.stringify(ctx));
  if (c.inj) for (const s of ['home', 'away']) if (c.inj[s]) delete c.inj[s].all;
  return c;
}

// =====================================================================================
// LINE HISTORY, PICKS, GRADING
// =====================================================================================
function publicEvent(ev) {
  const bookmakers = Object.keys(ev.books).map((k) => ({ key: k, title: ev.books[k].title, last_update: ev.books[k].last_update, src: ev.books[k].src, markets: ev.books[k].markets }));
  const out = { id: ev.id, sport_key: ev.sport_key, sport_title: LEAGUES[ev.sport_key] ? LEAGUES[ev.sport_key].title : ev.sport_title, commence_time: ev.commence_time, home_team: ev.home_team, away_team: ev.away_team, bookmakers };
  if (ev.outright) { out.outright = true; out.title = ev.title || ev.sport_title; }
  else { out.home_short = (ev.espn && ev.espn.home.short) || shortName(ev.home_team); out.away_short = (ev.espn && ev.espn.away.short) || shortName(ev.away_team); }
  if (ev.espn && ev.espn.neutral) out.neutral_site = true;
  if (ev.model) out.model = ev.model;
  if (ev.model_note) out.model_note = ev.model_note;
  if (ev.context) out.context = ev.context;
  if (ev.hist && Object.keys(ev.hist).length) out.hist = ev.hist;
  if (ev.open) out.open = ev.open;
  if (ev.final) out.final = ev.final;
  out.gradeable = !!(ev.espn && LEAGUES[ev.sport_key]);
  return out;
}
function track(ev, an) {
  const H = ev.hist = ev.hist || {};
  const add = (k, row, tol) => {
    const arr = H[k] = H[k] || [], last = arr[arr.length - 1];
    if (last && Math.abs(last[1] - row[1]) < tol && (row[2] == null || last[2] === row[2]) && NOW - last[0] * 60000 < 12 * HOUR) return;
    arr.push(row); if (arr.length > 30) arr.splice(1, 1);
  };
  const tm = Math.round(NOW / 60000);
  const m = an.markets;
  if (m.h2h) { const o = m.h2h.outcomes.find((x) => x.side === 'home'); if (o) add('h2h', [tm, +o.pMkt.toFixed(4)], 0.003); }
  if (m.spreads) add('spreads', [tm, m.spreads.muMkt != null ? +m.spreads.muMkt.toFixed(2) : +m.spreads.outcomes[1].pMkt.toFixed(4), m.spreads.consensusLine], m.spreads.muMkt != null ? 0.1 : 0.003);
  if (m.totals) add('totals', [tm, m.totals.muMkt != null ? +m.totals.muMkt.toFixed(2) : +m.totals.outcomes[0].pMkt.toFixed(4), m.totals.consensusLine], m.totals.muMkt != null ? 0.1 : 0.003);
}
function summarize(picks) {
  const mk = () => ({ graded: 0, w: 0, l: 0, p: 0, units: 0, roi: 0, clv_n: 0, clv: 0 });
  const all = mk(), bySport = {}, byConf = { High: mk(), Medium: mk(), Low: mk() }, titles = {};
  let pending = 0;
  for (const p of picks) {
    if (p.status === 'pending') { pending++; continue; }
    if (p.status === 'void') continue;
    titles[p.sport_key] = p.sport_title;
    for (const b of [all, bySport[p.sport_key] = bySport[p.sport_key] || mk(), byConf[FL.confLabel(p.conf)]]) {
      b.graded++; b[p.status === 'won' ? 'w' : p.status === 'lost' ? 'l' : 'p']++; b.units += p.units;
      if (p.clv != null) { b.clv_n++; b.clv += p.clv; }
    }
  }
  const fin = (b) => { b.units = +b.units.toFixed(2); b.roi = b.graded ? +(b.units / b.graded).toFixed(4) : 0; b.clv = b.clv_n ? +(b.clv / b.clv_n).toFixed(4) : null; return b; };
  fin(all); Object.values(bySport).forEach(fin); Object.values(byConf).forEach(fin);
  return { all, bySport, byConf, titles, pending };
}
function settle(p, ev) {
  if (ev.void) return { status: 'void', units: 0 };
  const f = ev.final; if (!f) return null;
  const dec = FL.amToDec(p.price);
  const res = (v) => (v > 1e-9 ? { status: 'won', units: +(dec - 1).toFixed(3) } : v < -1e-9 ? { status: 'lost', units: -1 } : { status: 'push', units: 0 });
  if (f.winner) {                                           // fights
    if (p.market !== 'h2h') return null;
    if (f.winner === 'draw') return p.side === 'draw' ? res(1) : { status: 'push', units: 0 };
    return res(f.winner === p.side ? 1 : -1);
  }
  const m = f.home - f.away;
  if (p.market === 'h2h') {
    if (p.side === 'draw') return res(m === 0 ? 1 : -1);
    if (m === 0) return p.three_way ? res(-1) : { status: 'push', units: 0 };
    return res((m > 0) === (p.side === 'home') ? 1 : -1);
  }
  if (p.market === 'spreads') return res(p.side === 'home' ? m + p.point : -m + p.point);
  if (p.market === 'totals') return res(p.side === 'over' ? f.home + f.away - p.point : p.point - (f.home + f.away));
  return null;
}

// =====================================================================================
// RUN
// =====================================================================================
async function main() {
  log('Fair Line update', iso(NOW), firstRun ? '(first run)' : '');
  const activeKeys = await runOddsApi();
  await runEspn(activeKeys);
  await runParlay(activeKeys);
  const espnLines = espnIntoStore();
  if (!ODDS_KEY && !PARLAY_KEY) src('The Odds API', { ok: false, error: 'No odds key set yet, so the board only has ESPN’s DraftKings line (' + espnLines + ' games). Add the ODDS_API_KEY secret to compare books.' });
  await runKalshi();
  await runInjuries();
  await runWeather();
  await runPitchers();

  // drop games that are long over
  for (const ev of Object.values(state.events)) {
    const t = Date.parse(ev.commence_time);
    const pending = picksFile.picks.some((p) => p.event_id === ev.id && p.status === 'pending');
    if ((!ev.outright && t < NOW - (pending ? 6 : 1.5) * DAY) || (ev.outright && t < NOW - 12 * DAY) || (!Object.keys(ev.books).length && !pending && t > NOW && NOW - Date.parse(ev.first_seen) > DAY)) {
      for (const k of Object.values(ev.ids || {})) idIndex.delete(k);
      delete state.events[ev.id];
    }
  }

  // model, history, picks
  const record = summarize(picksFile.picks);
  const upcoming = [], out = [];
  let withModel = 0;
  const evs = Object.values(state.events).sort((a, b) => Date.parse(a.commence_time) - Date.parse(b.commence_time));
  for (const ev of evs) {
    const t = Date.parse(ev.commence_time);
    if (!Object.keys(ev.books).length) continue;                // nothing to show; kept only so a pending pick can be graded
    if (t > NOW) { await buildModel(ev); if (ev.model) withModel++; }
    const pub = publicEvent(ev);
    if (t > NOW || ev.outright) {
      const an0 = FL.analyzeEvent(pub, { modelTrust: 0 });
      if (t > NOW && !ev.outright) track(ev, an0);
      pub.hist = ev.hist && Object.keys(ev.hist).length ? ev.hist : undefined;
      if (t > NOW) upcoming.push({ ev, pub, an0 });
    }
    const espnOnly = Object.values(ev.books).every((b) => b.src === 'espn');
    if (ev.outright ? t > NOW - 2 * DAY : t > NOW - 8 * HOUR && t < NOW + (espnOnly ? 3 : 8.5) * DAY) out.push(pub);
  }

  // closing-line check for pending picks: compare the price taken with the latest fair line
  const byId = new Map(upcoming.map((u) => [u.ev.id, u]));
  for (const p of picksFile.picks) {
    if (p.status !== 'pending') continue;
    const u = byId.get(p.event_id);
    if (u) { const c = FL.evAtMarket(u.an0, p.market, p.side, p.point, FL.amToDec(p.price)); if (c) { p.clv = +c.ev.toFixed(4); p.close_p = +c.p.toFixed(4); p.close_at = iso(NOW); } continue; }
    const ev = state.events[p.event_id];
    if (!ev) { if (Date.parse(p.commence_time) < NOW - 6 * DAY) { p.status = 'void'; p.units = 0; p.note = 'no result found'; } continue; }
    const s = settle(p, ev);
    if (s) { Object.assign(p, s, { graded_at: iso(NOW) }); if (ev.final && ev.final.home != null) p.score = ev.final.away + '–' + ev.final.home; }
  }

  // log new picks
  const myBooks = new Set(CONFIG.myBooks);
  const taken = new Set(picksFile.picks.map((p) => p.event_id + '|' + p.market));
  const sportRec = {}; for (const k of Object.keys(record.bySport)) sportRec[k] = { graded: record.bySport[k].graded, roi: record.bySport[k].roi };
  const ans = upcoming.filter((u) => u.pub.gradeable && !u.ev.outright).map((u) => FL.analyzeEvent(u.pub, { modelTrust: CONFIG.pick.modelTrust }));
  const recs = FL.recommend(ans, { now: NOW, books: myBooks, minEdge: CONFIG.pick.minEdge, minConf: CONFIG.pick.minConf, record: sportRec, markets: ['h2h', 'spreads', 'totals'] });
  let logged = 0;
  for (const r of recs) {
    const k = r.event.id + '|' + r.market;
    if (taken.has(k)) continue;
    taken.add(k);
    const label = r.market === 'totals' ? (r.outcome.side === 'over' ? 'Over ' : 'Under ') + r.offer.point
      : (r.outcome.side === 'draw' ? 'Draw' : r.outcome.side === 'home' ? r.event.home_short : r.event.away_short) + (r.market === 'spreads' ? ' ' + (r.offer.point > 0 ? '+' : '') + r.offer.point : '');
    picksFile.picks.push({ id: hash(k + NOW), logged_at: iso(NOW), event_id: r.event.id, sport_key: r.event.sport_key, sport_title: r.event.sport_title,
      away: r.event.away_short, home: r.event.home_short, commence_time: r.event.commence_time, market: r.market, side: r.outcome.side, label, point: r.offer.point,
      three_way: r.market === 'h2h' && ans.find((a) => a.event.id === r.event.id).markets.h2h.nWay === 3 ? true : undefined,
      price: r.offer.price, book: r.offer.book, book_title: r.offer.title, ev: +r.offer.ev.toFixed(4), conf: r.conf.score, p_app: +r.offer.pApp.toFixed(4), p_mkt: +r.offer.pMkt.toFixed(4),
      p_model: r.offer.pModel == null ? null : +r.offer.pModel.toFixed(4), flags: r.conf.flags.map((f) => f.key), status: 'pending' });
    logged++;
  }
  if (picksFile.picks.length > 3000) picksFile.picks.splice(0, picksFile.picks.length - 3000);
  const summary = summarize(picksFile.picks);
  src('Picks and grading', { ok: true, items: summary.all.graded + ' graded, ' + summary.pending + ' pending', note: logged + ' new this run' });
  const unlinked = upcoming.filter((u) => !u.ev.outright && LEAGUES[u.ev.sport_key] && !u.ev.espn).length;
  src('Stats model', { ok: withModel > 0 ? true : null, items: withModel + ' of ' + upcoming.filter((u) => !u.ev.outright).length + ' upcoming games have a model', note: 'ratings, rest, injuries, starters and weather where available' + (unlinked ? '. ' + unlinked + ' games could not be matched to ESPN\u2019s schedule' : '') });

  // sport list for the app, in your order
  const sports = {};
  for (const e of out) { const s = sports[e.sport_key] = sports[e.sport_key] || { key: e.sport_key, title: e.sport_title, n: 0, model: !!(LEAGUES[e.sport_key] && LEAGUES[e.sport_key].elo), rank: rank(e.sport_key) }; s.n++; }
  const feeds = {};
  for (const f of ['oddsapi', 'parlay']) if (state.feeds[f]) feeds[f] = { remaining: state.feeds[f].remaining == null ? null : state.feeds[f].remaining, per_day: state.feeds[f].per_day, sports: state.feeds[f].sports };

  state.last_run = iso(NOW);
  for (const ev of Object.values(state.events)) { delete ev.model; delete ev.context; delete ev.model_note; delete ev.books; delete ev.hist; delete ev.open; }   // rebuilt, or kept in latest.json
  status.runs = (state.runs = (state.runs || 0) + 1);
  writeJSON('latest.json', { version: 2, generated_at: iso(NOW), status, feeds, my_books: CONFIG.myBooks, pick: CONFIG.pick, sports: Object.values(sports).sort((a, b) => a.rank - b.rank), record: sportRec, events: out });
  writeJSON('picks.json', { updated_at: iso(NOW), summary, picks: picksFile.picks });
  writeJSON('state.json', state);
  log('events on the board:', out.length, '| with a model:', withModel, '| new picks:', logged, '| requests:', JSON.stringify(status.calls));
  for (const [k, v] of Object.entries(status.sources)) log((v.ok === true ? 'ok     ' : v.ok === 'partial' ? 'partial' : v.ok === false ? 'FAILED ' : 'idle   ') + ' ' + k + ': ' + [v.items, v.note, v.error].filter(Boolean).join(' | '));
}
if (ENV.FL_SELFTEST) globalThis.__fairline = { parseEspnEvent, espnOdds, kalshiPrice, parseAm, nameScore, pairScore, injStatus, pitchLine };
else main().catch((e) => {
  // never leave the app without a status file
  console.error(e);
  try { const prev = readJSON('latest.json', null) || { version: 2, events: [], sports: [] }; prev.status = Object.assign(status, { crash: String(e && e.stack || e).slice(0, 600) }); prev.crashed_at = iso(NOW); writeJSON('latest.json', prev); } catch { /* nothing more to do */ }
  process.exitCode = 0;
});
