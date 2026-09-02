(function () {
    'use strict';

    // ---------------------------------------------------------------------------
    // Lampa plugin v2 - TorrServer size/bitrate display + search relevance
    //
    // 1) SIZE / BITRATE
    //    TorrServer MatriX.142.4 emits sizes as "3.5 GCiB" (its Go formatter uses
    //    "%.1f %cCiB" - an extra C). Lampa's Utils.sizeToBytes only understands
    //    (Mb|МБ|GB|ГБ|TB|ТБ), so it returns 0.
    //
    //    v1 patched Utils.sizeToBytes and that was NOT enough. The real reason is
    //    in Lampa's torrents renderer:
    //
    //        Arrays.extend(element, { size: ..., bitrate: ... });
    //
    //    Arrays.extend(a, b, replase) assigns only when `a[i] == undefined` unless
    //    `replase` is passed - and the TorrServer parser's mapResult already set
    //    `size: e.Size` (the raw "3.5 GCiB" string) and `bitrate: '-'`. So the
    //    freshly computed values are discarded every time, whatever sizeToBytes
    //    returns. That is why sizes stayed raw and bitrate stayed a dash even for
    //    films with a known runtime.
    //
    //    Fix: correct the values in Template.get('torrent', vars), i.e. on the real
    //    data object immediately before it is substituted into the markup.
    //
    // 2) RELEVANCE
    //    Lampa builds the automatic query as combinations[parse_lang]; 'df'
    //    ("Оригинальное") is card.original_title alone. For a non-Latin original
    //    title (e.g. Solo Leveling -> 俺だけレベルアップな件) some indexers answer
    //    with their latest-uploads feed instead of an empty result, which is how
    //    Ted Lasso ends up under a Solo Leveling card. Measured on this setup:
    //      thepiratebay       100 results / 0 relevant
    //      torrentgalaxyclone  50 results / 0 relevant
    //      rutor / torrentdownload / megapeer  0 results (correct behaviour)
    //    With the Latin alias "Solo Leveling" the same five return 210 / 210.
    //
    //    So: if the query is mostly non-Latin, swap in a Latin alias that Lampa
    //    already holds in the card (alternative_titles are fetched by Lampa itself
    //    via append_to_response) - no extra network request. Then score each
    //    release against the card and hide only clearly wrong ones.
    //
    // No network calls, no eval, no storage writes, no changes to search settings,
    // parser, player or TorrServer. Remove the plugin to revert.
    // ---------------------------------------------------------------------------

    if (!window.Lampa || !Lampa.Utils) return;

    var VERSION = '2.1';
    var DASH = '—';
    var HIDDEN = 'ts-v2-hidden';

    // ============================================================ size utilities

    var MULT = { 'b': 1, 'k': 1024, 'm': 1048576, 'g': 1073741824, 't': 1099511627776 };
    var CYR = { 'к': 'k', 'м': 'm', 'г': 'g', 'т': 't' };

    // "3.5 GCiB" | "555.6 MCiB" | "2.3 GiB" | "3,5 ГБ" | "500 MB" | "1024 B"
    var SIZE_RE = /([0-9]+(?:[.,][0-9]+)?)\s*([KMGTКМГТ])?\s*(?:C?i?B|Б)(?![A-Za-zА-я])/i;

    function parseSize(str, fallback) {
        if (typeof str !== 'string' || !str) return 0;
        var m = str.match(SIZE_RE);
        if (!m) {
            if (typeof fallback === 'function') {
                try { return fallback(str); } catch (e) { return 0; }
            }
            return 0;
        }
        var v = parseFloat(m[1].replace(',', '.'));
        if (isNaN(v)) return 0;
        var u = (m[2] || 'b').toLowerCase();
        if (CYR[u]) u = CYR[u];
        return v * (MULT[u] || 1);
    }

    function toBytes(vars) {
        var n = parseFloat(vars.Size);
        if (isFinite(n) && n > 0) return n;              // parser already gave bytes
        return parseSize(vars.size || vars.Size || '');  // otherwise parse the string
    }

    // ============================================================ text utilities

    var LATIN_RE = /[A-Za-z]/g;
    var LETTER_RE = /[A-Za-zА-Яа-яЁё぀-ヿ㐀-鿿가-힯؀-ۿ]/g;

    function latinShare(s) {
        if (!s) return 1;
        var letters = s.match(LETTER_RE);
        if (!letters || !letters.length) return 1;
        var latin = s.match(LATIN_RE);
        return (latin ? latin.length : 0) / letters.length;
    }

    var ROMAN = { 'i': 1, 'ii': 2, 'iii': 3, 'iv': 4, 'v': 5, 'vi': 6, 'vii': 7, 'viii': 8, 'ix': 9, 'x': 10 };

    function normalize(s) {
        if (!s) return '';
        return String(s)
            .toLowerCase()
            .replace(/[‘’ʼ`']/g, '')
            .replace(/[^0-9a-zа-яё぀-ヿ㐀-鿿]+/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    // Words that carry no identity - dropped before comparing titles.
    // Quoted keys on purpose: "in" is a reserved word and unquoted reserved words
    // as property names break older TV WebViews.
    var STOP = {
        'the': 1, 'a': 1, 'an': 1, 'of': 1, 'and': 1, 'or': 1, 'in': 1, 'on': 1,
        'at': 1, 'to': 1, 'и': 1, 'в': 1, 'на': 1, 'с': 1
    };

    function tokens(s) {
        var out = [];
        var parts = normalize(s).split(' ');
        for (var i = 0; i < parts.length; i++) {
            var p = parts[i];
            if (!p || STOP[p]) continue;
            if (ROMAN[p] !== undefined) p = String(ROMAN[p]);
            out.push(p);
        }
        return out;
    }

    // "part 2", "part ii", "часть 2", "pt 2", "vol 2", "chapter 2"
    var PART_RE = /(?:^|\s)(?:part|pt|vol|volume|chapter|часть|том|глава)\s*([0-9]{1,2}|[ivx]{1,4})(?:\s|$)/i;

    function partNumber(s) {
        var all = partNumbers(s);
        return all.length ? all[0] : 0;
    }

    // A release can carry more than one "part" token, e.g.
    // "Part 8 Harry Potter And The Deathly Hallows Part 2 2011" - the first one is
    // a pack index, the real one is next to the title. Collect them all and let
    // the caller accept a match on any.
    function partNumbers(s) {
        var norm = normalize(s);
        var re = new RegExp(PART_RE.source, 'gi');
        var out = [], m;
        while ((m = re.exec(norm)) !== null) {
            var v = m[1].toLowerCase();
            var n = ROMAN[v] !== undefined ? ROMAN[v] : parseInt(v, 10);
            if (isFinite(n) && n > 0 && out.indexOf(n) < 0) out.push(n);
            if (re.lastIndex === m.index) re.lastIndex++;
        }
        return out;
    }

    function yearsIn(s) {
        var out = [];
        var m = String(s || '').match(/(19|20)\d{2}/g);
        if (m) for (var i = 0; i < m.length; i++) out.push(parseInt(m[i], 10));
        return out;
    }

    // Season/collection packs: the card runtime is one episode, so a bitrate from
    // the whole pack would be wrong. "Complete" alone is not enough - there are
    // films called "A Complete Unknown".
    var PACK_RE = new RegExp(
        '(^|[^A-Za-z0-9А-я])(' +
            's\\d{1,2}(?!\\s*e\\s*\\d)' +
            '|seasons?[\\s._-]*\\d{1,2}' +
            '|сезон' +
            '|complete[\\s._-]+(series|season|collection)' +
            '|collection|коллекция' +
            '|dilogy|trilogy|anthology|дилогия|трилогия|антология' +
        ')([^A-Za-z0-9А-я]|$)', 'i');

    function isPack(t) { return typeof t === 'string' && PACK_RE.test(t); }

    // Structural markers that separate the show name from the episode part:
    // S01, S01E05, S6E11, 1x05, Season 1, Сезон 2.
    var MARKER_RE = /^(s\d{1,2}(e\d{1,3})?|\d{1,2}x\d{1,3}|seasons?|сезон)$/i;

    // Tokens of the primary show title: everything before the first marker, with
    // any leading markers stripped first so "[S01] Breaking Bad" still works.
    // Returns [] when the release carries no marker at all - then the caller
    // keeps its normal whole-title matching.
    function showTitle(title) {
        var tk = tokens(title);
        var i = 0;
        while (i < tk.length && (MARKER_RE.test(tk[i]) || /^\d{1,2}$/.test(tk[i]) && i > 0 && MARKER_RE.test(tk[i - 1]))) i++;
        var head = [];
        for (var j = i; j < tk.length; j++) {
            if (MARKER_RE.test(tk[j])) return head;
            head.push(tk[j]);
        }
        return [];
    }

    // ============================================================ card / target

    function activeMovie() {
        try {
            var a = Lampa.Activity && Lampa.Activity.active ? Lampa.Activity.active() : null;
            if (!a) return null;
            return a.movie || a.card || null;
        } catch (e) { return null; }
    }

    function aliases(movie) {
        var list = [];
        if (!movie) return list;

        function add(v) { if (v && typeof v === 'string' && list.indexOf(v) < 0) list.push(v); }

        add(movie.title); add(movie.original_title);
        add(movie.name); add(movie.original_name);

        if (movie.names && movie.names.length) {
            for (var i = 0; i < movie.names.length; i++) add(movie.names[i]);
        }
        var alt = movie.alternative_titles && movie.alternative_titles.titles;
        if (alt && alt.length) for (var j = 0; j < alt.length; j++) add(alt[j].title);

        return list;
    }

    // Many localized titles keep the Latin name in front of a separator, e.g.
    //   "Solo Leveling: Поднятие уровня в одиночку"
    // Take that leading Latin part when it is a meaningful phrase. This is an
    // extraction from metadata the card already holds - never a transliteration.
    function latinPrefix(s) {
        if (!s) return '';
        var head = String(s).split(/[:\-–—\/|(\[]/)[0];
        if (!head) return '';
        head = head.replace(/\s+/g, ' ').trim();
        if (head.length < 4) return '';                 // reject "S", "A", stray letters
        if (latinShare(head) < 0.9) return '';          // the head itself must be Latin
        var words = head.split(' ');
        var real = 0;
        for (var i = 0; i < words.length; i++) if (words[i].length >= 2) real++;
        if (!real) return '';
        // one very short word alone is not a meaningful title
        if (real === 1 && head.replace(/[^A-Za-z]/g, '').length < 4) return '';
        return head;
    }

    // A Latin alias already present in the card - no extra request is made.
    function latinAlias(movie) {
        if (!movie) return '';

        // 1-2. official alternative titles (Lampa already fetched them)
        var alt = movie.alternative_titles && movie.alternative_titles.titles;
        if (alt && alt.length) {
            for (var i = 0; i < alt.length; i++) {
                var c = (alt[i].iso_3166_1 || '').toLowerCase();
                if ((c === 'us' || c === 'gb') && latinShare(alt[i].title) > 0.6) return alt[i].title;
            }
            for (var k = 0; k < alt.length; k++) {
                if (latinShare(alt[k].title) > 0.6) return alt[k].title;
            }
        }

        // 4. another already-Latin title field
        var pool = [movie.original_title, movie.original_name, movie.title, movie.name];
        for (var j = 0; j < pool.length; j++) {
            if (pool[j] && latinShare(pool[j]) > 0.6) return pool[j];
        }

        // 3. meaningful Latin prefix of the display/localized title
        for (var p = 0; p < pool.length; p++) {
            var pre = latinPrefix(pool[p]);
            if (pre) return pre;
        }

        // 5. nothing safe - leave the query alone
        return '';
    }

    function isSeries(movie) {
        if (!movie) return false;
        return !!(movie.number_of_seasons || movie.first_air_date || movie.name || movie.original_name);
    }

    function targetYear(movie) {
        if (!movie) return 0;
        var d = movie.release_date || movie.first_air_date || '';
        var y = parseInt(String(d).slice(0, 4), 10);
        return isFinite(y) ? y : 0;
    }

    // ============================================================ relevance

    // Conservative on purpose: only clear mismatches are rejected. When anything
    // is unknown the release is kept - losing a good release is worse than
    // showing one extra.
    function relevant(title, movie) {
        if (!movie || !title) return true;

        var al = aliases(movie);
        if (!al.length) return true;

        // For a series the show name comes first; whatever follows a season or
        // episode marker is the episode title. Without this, an episode called
        // "Breaking Bad" inside "Better Call Saul S06E11 Breaking Bad" matches
        // the Breaking Bad card.
        if (isSeries(movie)) {
            var head = showTitle(title);
            if (head.length) {
                var best2 = 0;
                for (var s = 0; s < al.length; s++) {
                    var at = tokens(al[s]);
                    if (!at.length) continue;
                    // The head is already cut at the season/episode marker, so
                    // matching anywhere inside it is strict enough: the episode
                    // title that caused the false positive lives after the
                    // marker. No positional window - releases legitimately put a
                    // romaji or site prefix before the English show name, e.g.
                    // "[Xspitfire911] Ore dake Level Up na Ken - Solo Leveling S01".
                    var seen = {};
                    for (var w = 0; w < head.length; w++) seen[head[w]] = 1;
                    var n = 0;
                    for (var q = 0; q < at.length; q++) if (seen[at[q]]) n++;
                    var c2 = n / at.length;
                    if (c2 > best2) best2 = c2;
                }
                if (best2 < 0.6) return false;
            }
        }

        var relTokens = tokens(title);
        if (!relTokens.length) return true;

        var have = {};
        for (var i = 0; i < relTokens.length; i++) have[relTokens[i]] = 1;

        var best = 0, bestAlias = null;
        for (var a = 0; a < al.length; a++) {
            var tk = tokens(al[a]);
            if (!tk.length) continue;
            var hit = 0;
            for (var t = 0; t < tk.length; t++) if (have[tk[t]]) hit++;
            var cov = hit / tk.length;
            if (cov > best) { best = cov; bestAlias = al[a]; }
        }

        // Shares almost nothing with any known title of this work.
        if (best < 0.6) return false;

        // Part / chapter number must not contradict.
        var wantPart = 0;
        for (var p = 0; p < al.length; p++) { wantPart = partNumber(al[p]); if (wantPart) break; }
        if (wantPart) {
            var gotParts = partNumbers(title);
            if (gotParts.length && gotParts.indexOf(wantPart) < 0) return false;
        }

        // Year, films only. Series release years mean seasons, so skip them.
        if (!isSeries(movie)) {
            var want = targetYear(movie);
            var got = yearsIn(title);
            if (want && got.length) {
                var ok = false;
                for (var y = 0; y < got.length; y++) if (Math.abs(got[y] - want) <= 1) ok = true;
                if (!ok) return false;
            }
        }

        return true;
    }

    // ============================================================ patch: Utils

    if (!Lampa.Utils.__ts_v2) {
        var stockSize = Lampa.Utils.sizeToBytes;
        var stockRate = Lampa.Utils.calcBitrate;

        Lampa.Utils.sizeToBytes = function (str) {
            return parseSize(str, function (s) {
                return stockSize ? stockSize.call(Lampa.Utils, s) : 0;
            });
        };

        Lampa.Utils.calcBitrate = function (bytes, minutes) {
            if (!minutes || !bytes || !isFinite(bytes) || bytes <= 0) return DASH;
            var mbps = bytes * 8 / 1000000 / (minutes * 60);
            if (!isFinite(mbps) || mbps <= 0) return DASH;
            return mbps.toFixed(1);
        };

        Lampa.Utils.__ts_v2 = true;
        void stockRate;
    }

    // ============================= patch: Template.get - the actual render input

    if (Lampa.Template && Lampa.Template.get && !Lampa.Template.__ts_v2) {
        var stockGet = Lampa.Template.get;

        Lampa.Template.get = function (name, vars, like_static) {
            var reject = false;

            if (name === 'torrent' && vars && typeof vars === 'object') {
                var movie = activeMovie();

                var bytes = toBytes(vars);
                if (bytes > 0) {
                    vars.Size = bytes;
                    try { vars.size = Lampa.Utils.bytesToSize(bytes); } catch (e) {}
                }

                var runtime = movie && movie.runtime ? movie.runtime : 0;
                if (bytes > 0 && runtime && !isPack(vars.Title || vars.title)) {
                    vars.bitrate = (bytes * 8 / 1000000 / (runtime * 60)).toFixed(1);
                } else {
                    vars.bitrate = DASH;
                }

                reject = !relevant(vars.Title || vars.title, movie);
            }

            var res = stockGet.apply(Lampa.Template, arguments);

            if (reject && res && typeof res !== 'string' && res.addClass) res.addClass(HIDDEN);
            return res;
        };

        Lampa.Template.__ts_v2 = true;
    }

    // ================= patch: Activity.push - Latin fallback for non-Latin query

    if (Lampa.Activity && Lampa.Activity.push && !Lampa.Activity.__ts_v2) {
        var stockPush = Lampa.Activity.push;

        Lampa.Activity.push = function (params) {
            try {
                if (params && params.component === 'torrents' && params.search && params.movie) {
                    if (latinShare(params.search) < 0.4) {
                        var alias = latinAlias(params.movie);
                        if (alias) params.search = alias;
                    }
                }
            } catch (e) {}
            return stockPush.apply(Lampa.Activity, arguments);
        };

        Lampa.Activity.__ts_v2 = true;
    }

    // ============ safety net: the last point before the request leaves Lampa
    //
    // The torrents parser builds its request as
    //   Utils.buildUrl(base_url, path, [{ name: 'query', value: params.search }])
    // so this catches any path that reached the request with a still non-Latin
    // query - for instance when the activity was created before this plugin
    // loaded. Only the query value is touched; the URL is otherwise untouched.

    if (Lampa.Utils.buildUrl && !Lampa.Utils.__ts_v2_url) {
        var stockBuild = Lampa.Utils.buildUrl;

        Lampa.Utils.buildUrl = function (base, path, args) {
            try {
                if (args && args.length) {
                    for (var i = 0; i < args.length; i++) {
                        if (args[i] && args[i].name === 'query' && typeof args[i].value === 'string') {
                            if (latinShare(args[i].value) < 0.4) {
                                var alias = latinAlias(activeMovie());
                                if (alias) args[i].value = alias;
                            }
                        }
                    }
                }
            } catch (e) {}
            return stockBuild.apply(Lampa.Utils, arguments);
        };

        Lampa.Utils.__ts_v2_url = true;
    }

    // ============================================ DOM fallback (safety net only)

    function fixItem(item) {
        if (item.__ts_v2_done) return true;
        var titleEl = item.querySelector('.torrent-item__title');
        var rateEl = item.querySelector('.torrent-item__bitrate span');
        if (!titleEl || !rateEl) return false;

        var text = rateEl.textContent || '';
        var m = text.match(/^\s*([0-9]+(?:[.,][0-9]+)?)\s*(.*)$/);
        var v = m ? parseFloat(m[1].replace(',', '.')) : NaN;

        if (isPack(titleEl.textContent) || !isFinite(v) || v <= 0) rateEl.textContent = DASH;
        else rateEl.textContent = v.toFixed(1) + (m[2] ? ' ' + m[2] : '');

        item.__ts_v2_done = true;
        return true;
    }

    function scan(root) {
        if (!root || root.nodeType !== 1) return;
        if (root.classList && root.classList.contains('torrent-item')) fixItem(root);
        if (!root.querySelectorAll) return;
        var list = root.querySelectorAll('.torrent-item');
        for (var i = 0; i < list.length; i++) fixItem(list[i]);
    }

    if (document.body) {
        try {
            var st = document.createElement('style');
            st.textContent = '.' + HIDDEN + '{display:none!important}';
            document.head.appendChild(st);
        } catch (e) {}

        if (window.MutationObserver) {
            new window.MutationObserver(function (muts) {
                for (var i = 0; i < muts.length; i++) {
                    var add = muts[i].addedNodes;
                    for (var j = 0; j < add.length; j++) scan(add[j]);
                }
            }).observe(document.body, { childList: true, subtree: true });
            scan(document.body);
        }
    }

    // Version marker - no telemetry, just something to read off the console.
    try {
        window.__lampa_torrfix_version = VERSION;
        if (window.console && console.log) console.log('[Lampa TorrFix] v' + VERSION + ' loaded');
    } catch (e) {}
})();
