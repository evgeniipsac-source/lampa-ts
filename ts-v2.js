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

    var VERSION = '2.3';
    var DASH = '—';
    var HIDDEN = 'ts-v2-hidden';

    // ------------------------------------------------------------- journal

    // Local-only. The collector runs on the same LAN PC and writes JSONL.
    // Nothing is sent anywhere else. If the collector is unreachable the queue
    // is capped and the UI is never blocked or slowed.
    var JOURNAL_URL = 'http://192.168.31.175:8091/event';
    var QUEUE_KEY = 'ts_journal_queue';
    var QUEUE_MAX = 500;

    var jq = [];
    var jSending = false;
    var jOffline = 0;

    // Storage.get normally returns a parsed value, but be defensive: a string
    // slipping through here would corrupt the queue.
    function jParse(raw, fallback) {
        if (typeof raw === 'string') {
            try { raw = JSON.parse(raw); } catch (e) { return fallback; }
        }
        return raw || fallback;
    }

    function jLoad() {
        try {
            var raw = jParse(Lampa.Storage.get(QUEUE_KEY, '[]'), []);
            if (raw && raw.length) jq = raw.slice(0, QUEUE_MAX);
        } catch (e) { jq = []; }
    }

    function jSave() {
        try { Lampa.Storage.set(QUEUE_KEY, jq.slice(-QUEUE_MAX)); } catch (e) {}
    }

    function jFlush() {
        if (jSending || !jq.length) return;
        if (jOffline && Date.now() < jOffline) return;      // back off while down
        jSending = true;

        var batch = jq.slice(0, 50);
        try {
            var xhr = new XMLHttpRequest();
            xhr.open('POST', JOURNAL_URL, true);
            xhr.timeout = 4000;
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.onload = function () {
                jSending = false;
                if (xhr.status === 200) {
                    jq = jq.slice(batch.length);
                    jOffline = 0;
                    jSave();
                    if (jq.length) setTimeout(jFlush, 50);
                } else {
                    jOffline = Date.now() + 60000;
                }
            };
            xhr.onerror = xhr.ontimeout = function () {
                jSending = false;
                jOffline = Date.now() + 60000;              // retry in a minute
            };
            xhr.send(JSON.stringify(batch));
        } catch (e) {
            jSending = false;
            jOffline = Date.now() + 60000;
        }
    }

    function isoNow() {
        var d = new Date();
        if (d.toISOString) { try { return d.toISOString(); } catch (e) {} }
        function p(n, w) { var s = String(n); while (s.length < (w || 2)) s = '0' + s; return s; }
        return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) +
               'T' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds()) +
               '.' + p(d.getUTCMilliseconds(), 3) + 'Z';
    }

    function journal(event, data) {
        try {
            var ev = data || {};
            ev.event = event;
            ev.v = VERSION;
            ev.ts_client = isoNow();
            jq.push(ev);
            if (jq.length > QUEUE_MAX) jq = jq.slice(-QUEUE_MAX);
            jSave();
            jFlush();
        } catch (e) {}
    }

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

    // ------------------------------------------- pack / episode classification

    var EP_RE = /(^|[^a-z0-9])(s\d{1,2}\s*e\d{1,3}|\d{1,2}x\d{1,3}|e\d{1,3}|эп(изод)?\s*\d{1,3}|серия\s*\d{1,3})([^a-z0-9]|$)/i;
    var MULTI_SEASON_RE = /(^|[^a-z0-9])(s\d{1,2}\s*[-–—+]\s*s?\d{1,2}|seasons?\s*\d{1,2}\s*[-–—+]\s*\d{1,2}|сезоны?\s*\d{1,2}\s*[-–—]\s*\d{1,2})([^a-z0-9]|$)/i;
    var COMPLETE_RE = /(^|[^a-z0-9])(complete|全集|全 ?话|полностью|все серии|весь сезон)([^a-z0-9]|$)/i;
    var SEASON_RE = /(^|[^a-z0-9])(s\d{1,2}(?!\s*e\s*\d)|seasons?[\s._-]*\d{1,2}|сезон[\s._-]*\d{1,2}|batch)([^a-z0-9]|$)/i;

    // A: complete series, B: multi-season, C: season pack, D: single episode, E: other
    function classify(title) {
        if (typeof title !== 'string' || !title) return 'E';
        var t = ' ' + title + ' ';
        if (EP_RE.test(t)) return 'D';                      // S01E05 wins - it is one episode
        if (MULTI_SEASON_RE.test(t)) return 'B';
        if (COMPLETE_RE.test(t)) return 'A';
        if (SEASON_RE.test(t)) return 'C';
        return 'E';
    }

    var CLASS_RANK = { 'A': 0, 'B': 1, 'C': 2, 'E': 3, 'D': 4 };   // packs first, episodes last

    // --------------------------------------------- inferred audio / subtitles

    // Only confident, explicit markers. Anything unrecognised stays unknown and
    // is never filtered out.
    var LANG_RE = [
        ['RUS', /(^|[^a-z])(rus|ru|russian|многоголос|дубляж|дублирован|русск)([^a-z]|$)/i],
        ['ENG', /(^|[^a-z])(eng|en|english)([^a-z]|$)/i],
        ['ITA', /(^|[^a-z])(ita|italian)([^a-z]|$)/i],
        ['JPN', /(^|[^a-z])(jpn|jap|japanese|яп)([^a-z]|$)/i],
        ['UKR', /(^|[^a-z])(ukr|ukrainian|укр)([^a-z]|$)/i],
        ['GER', /(^|[^a-z])(ger|deu|german)([^a-z]|$)/i],
        ['FRA', /(^|[^a-z])(fra|fre|french)([^a-z]|$)/i],
        ['SPA', /(^|[^a-z])(spa|esp|spanish)([^a-z]|$)/i],
        ['KOR', /(^|[^a-z])(kor|korean)([^a-z]|$)/i],
        ['CHI', /(^|[^a-z])(chi|chs|cht|chinese)([^a-z]|$)/i]
    ];

    var DUB_RE = [
        ['DUB', /(^|[^a-z])(dub|дубляж|дублирован)([^a-z]|$)/i],
        ['MVO', /(^|[^a-z])(mvo|многоголос)([^a-z]|$)/i],
        ['DVO', /(^|[^a-z])(dvo|двухголос)([^a-z]|$)/i],
        ['AVO', /(^|[^a-z])(avo|авторск)([^a-z]|$)/i],
        ['VO',  /(^|[^a-z])(vo|voice ?over|озвуч)([^a-z]|$)/i],
        ['ORIG',/(^|[^a-z])(original ?audio|orig)([^a-z]|$)/i]
    ];

    var MULTI_RE = /(^|[^a-z])(multi|dual|multilang)([^a-z]|$)/i;
    // the subtitle part of a release name, e.g. "... AAC Sub ita eng"
    var SUB_TAIL_RE = /(sub(s|title|titles)?|суб(титры)?)[\s._:-]*([a-zа-я ,._\/+-]{0,40})/i;

    function inferTracks(title) {
        var out = { audio: [], subs: [], dub: [], multi: false };
        if (typeof title !== 'string' || !title) return out;

        var subM = title.match(SUB_TAIL_RE);
        var subPart = subM ? subM[0] : '';
        var audioPart = subPart ? title.replace(subPart, ' ') : title;

        for (var i = 0; i < LANG_RE.length; i++) {
            if (LANG_RE[i][1].test(audioPart)) out.audio.push(LANG_RE[i][0]);
        }
        if (subPart) {
            for (var j = 0; j < LANG_RE.length; j++) {
                if (LANG_RE[j][1].test(subPart)) out.subs.push(LANG_RE[j][0]);
            }
            if (!out.subs.length) out.subs.push('?');       // subs present, language unclear
        }
        for (var d = 0; d < DUB_RE.length; d++) {
            if (DUB_RE[d][1].test(title)) out.dub.push(DUB_RE[d][0]);
        }
        out.multi = MULTI_RE.test(title);
        return out;
    }

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

                // Inferred audio / subtitles / pack class, appended to the
                // tracker line so nothing in the layout has to move.
                try {
                    var title = vars.Title || vars.title || '';
                    var cls = classify(title);
                    var tr = inferTracks(title);
                    var bits = [];

                    if (cls === 'A') bits.push('COMPLETE');
                    else if (cls === 'B') bits.push('MULTI-SEASON');
                    else if (cls === 'C') bits.push('SEASON');

                    var ver = verified(vars.Hash || vars.hash);
                    var au = ver ? ver.audio : tr.audio;
                    var su = ver ? ver.subs : tr.subs;
                    var mark = ver ? '✓' : '';          // check mark = verified

                    if (au && au.length) bits.push(mark + 'A: ' + au.join(' · '));
                    else if (tr.multi) bits.push('A: MULTI');
                    if (tr.dub.length && !ver) bits.push(tr.dub.join(' '));
                    if (su && su.length) bits.push(mark + 'S: ' + su.join(' · '));

                    if (bits.length) {
                        vars.tracker = (vars.tracker || vars.Tracker || '') + '  •  ' + bits.join('  •  ');
                    }
                    vars.__ts_class = cls;
                } catch (e) {}
            }

            var res = stockGet.apply(Lampa.Template, arguments);

            if (name === 'torrent' && res && typeof res !== 'string' && res.addClass) {
                if (reject) res.addClass(HIDDEN);
                else if (vars && vars.__ts_class) res.addClass('ts-cls-' + vars.__ts_class);
            }
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
                    var requested = params.search;
                    var reason = '';
                    if (latinShare(params.search) < 0.4) {
                        var alias = latinAlias(params.movie);
                        if (alias) { params.search = alias; reason = 'non_latin_to_latin_alias'; }
                        else reason = 'non_latin_no_alias_found';
                    }
                    var mv = params.movie;
                    searchId = rnd();
                    searchStartedAt = Date.now();
                    resultBuf = []; renderCount = 0;
                    var ev = {
                        session_id: SESSION, search_id: searchId,
                        id: mv.id,
                        media_type: mv.number_of_seasons ? 'tv' : 'movie',
                        anime_like: (mv.original_language === 'ja' || mv.original_language === 'zh') ? true : undefined,
                        title: mv.title || mv.name,
                        original_title: mv.original_title || mv.original_name,
                        original_language: mv.original_language,
                        requested_query: requested,
                        actual_query: params.search,
                        rewrite_reason: reason,
                        year: (mv.release_date || mv.first_air_date || '').slice(0, 4),
                        season: params.season || null,
                        episode: params.episode || null
                    };
                    var pc = parserContext();
                    for (var pk in pc) ev[pk] = pc[pk];
                    try { ev.active_filters = Lampa.Storage.get('torrents_filter', '{}'); } catch (e2) {}
                    journal('torrent_search_start', ev);
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

    // =========================================== verified track cache (Phase 3.4)

    var VER_KEY = 'ts_verified_tracks';
    var verCache = null;

    function verified(hash) {
        if (!hash) return null;
        if (verCache === null) {
            try { verCache = jParse(Lampa.Storage.get(VER_KEY, '{}'), {}); } catch (e) { verCache = {}; }
        }
        return verCache[String(hash).toLowerCase()] || null;
    }

    function rememberTracks(hash, audio, subs) {
        if (!hash) return;
        try {
            if (verCache === null) verCache = jParse(Lampa.Storage.get(VER_KEY, '{}'), {});
            var keys = [];
            for (var k in verCache) keys.push(k);
            if (keys.length > 300) delete verCache[keys[0]];        // bounded
            verCache[String(hash).toLowerCase()] = { audio: audio, subs: subs };
            Lampa.Storage.set(VER_KEY, verCache);
            journal('tracks_verified', { infohash: hash, audio: audio, subs: subs });
        } catch (e) {}
    }

    // ================================================= Shots row on the home page

    function hideShots() {
        try {
            var lines = document.querySelectorAll('.items-line');
            for (var i = 0; i < lines.length; i++) {
                var line = lines[i];
                if (line.__ts_shots) continue;
                var t = line.querySelector('.items-line__title');
                if (!t) continue;
                var name = (t.textContent || '').trim().toLowerCase();
                if (name === 'shots' || name === 'шортсы' || name === 'шорты') {
                    line.__ts_shots = true;
                    line.classList.add(HIDDEN);
                    journal('shots_hidden', { title: t.textContent });
                }
            }
        } catch (e) {}
    }

    // ================================================================ journal taps

    function rnd() { return Math.random().toString(36).slice(2, 10); }

    var SESSION = rnd();
    var searchId = '';
    var playbackId = '';
    var searchStartedAt = 0;

    // Where the parser actually sends the query. Host and path only - any key,
    // token or apikey in the URL is dropped, never logged.
    function parserContext() {
        var out = { parser_type: 'unknown', parser_host: '', parser_path: '', parser_mode: '', parser_use_link: '' };
        try {
            var t = Lampa.Storage.field('parser_torrent_type');
            out.parser_type = t || 'unknown';
            out.parser_use_link = Lampa.Storage.field('parser_use_link') || 'one';

            if (t === 'jackett' || t === 'prowlarr') {
                out.parser_mode = Lampa.Storage.field('jackett_interview') === 'healthy' ? 'status:healthy' : 'all';
                var url = Lampa.Storage.field(t === 'jackett' ? 'jackett_url' : 'prowlarr_url') || '';
                var m = String(url).match(/^(https?):\/\/([^\/?#]+)([^?#]*)/i);
                if (m) {
                    out.parser_protocol = m[1];
                    // A URL may carry basic-auth credentials (user:pass@host).
                    // Drop them - only the host itself is ever logged.
                    var hostPart = m[2];
                    var at = hostPart.lastIndexOf('@');
                    if (at >= 0) { hostPart = hostPart.slice(at + 1); out.parser_userinfo = 'present-redacted'; }
                    out.parser_host = hostPart;
                    out.parser_path = m[3] || '/';
                }
                else if (url) { out.parser_host = '<unparsed>'; }
            } else if (t === 'torrserver') {
                out.parser_mode = 'torrserver';
                var tu = Lampa.Storage.field(Lampa.Storage.field('torrserver_use_link') === 'two' ? 'torrserver_url_two' : 'torrserver_url') || '';
                var m2 = String(tu).match(/^(https?):\/\/([^\/?#]+)([^?#]*)/i);
                if (m2) {
                    out.parser_protocol = m2[1];
                    var hp = m2[2];
                    var at2 = hp.lastIndexOf('@');
                    if (at2 >= 0) { hp = hp.slice(at2 + 1); out.parser_userinfo = 'present-redacted'; }
                    out.parser_host = hp;
                    out.parser_path = m2[3] || '/';
                }
            }
        } catch (e) {}
        return out;
    }

    // ---- search result accumulation (from the 'torrent' render channel) -------

    var resultBuf = [];
    var renderCount = 0;
    var endTimer = null;
    var SNAPSHOT_N = 30;

    function noteResult(item) {
        renderCount++;
        if (resultBuf.length < SNAPSHOT_N) {
            var title = item.Title || item.title || '';
            var tr = inferTracks(title);
            resultBuf.push({
                position: renderCount,
                title: String(title).slice(0, 180),
                source: item.Tracker || '',
                infohash: (item.Hash || item.hash || '') || undefined,
                size_bytes: isFinite(parseFloat(item.Size)) ? parseFloat(item.Size) : undefined,
                size_raw: typeof item.size === 'string' ? item.size : undefined,
                seeders: item.Seeders,
                peers: item.Peers,
                publish_date: item.PublishDate || undefined,
                category: item.CategoryDesc || undefined,
                pack_class: classify(title),
                inferred_audio: tr.audio,
                inferred_subtitles: tr.subs,
                inferred_dub: tr.dub
            });
        }
        if (endTimer) clearTimeout(endTimer);
        endTimer = setTimeout(flushSearchEnd, 1500);      // list finished rendering
    }

    function flushSearchEnd() {
        endTimer = null;
        if (!searchId) return;
        journal('search_results_snapshot', {
            session_id: SESSION, search_id: searchId,
            count: resultBuf.length, of_total: renderCount, results: resultBuf
        });
        journal('torrent_search_end', {
            session_id: SESSION, search_id: searchId,
            render_result_count: renderCount,
            elapsed_ms: searchStartedAt ? (Date.now() - searchStartedAt) : undefined,
            note: 'render_result_count is what Lampa actually drew; the parser raw count is not exposed to plugins'
        });
        resultBuf = []; renderCount = 0;
    }

    // ---- playback ------------------------------------------------------------

    var pb = null;

    function newPlayback(extra) {
        playbackId = rnd();
        pb = {
            id: playbackId, opened_at: Date.now(), first_playing_at: 0,
            buffering_count: 0, buffering_total: 0, buffering_at: 0,
            min_ahead: null, last_sample: 0, watch_from: 0
        };
        if (extra) for (var k in extra) pb[k] = extra[k];
        return pb;
    }

    function videoEl() {
        try { return document.querySelector ? document.querySelector('video') : null; } catch (e) { return null; }
    }

    function bufferSample() {
        if (!pb) return;
        var v = videoEl();
        if (!v || !v.duration || isNaN(v.duration)) return;      // native players expose no <video>
        var end = 0;
        try {
            for (var i = 0; i < v.buffered.length; i++) {
                if (v.buffered.start(i) <= v.currentTime && v.buffered.end(i) > end) end = v.buffered.end(i);
            }
        } catch (e) { return; }
        var ahead = Math.max(0, end - v.currentTime);
        if (pb.min_ahead === null || ahead < pb.min_ahead) pb.min_ahead = ahead;
        journal('player_buffer_sample', {
            session_id: SESSION, playback_id: pb.id,
            current_time: Math.round(v.currentTime), duration: Math.round(v.duration),
            buffered_end: Math.round(end), buffer_ahead_seconds: Math.round(ahead),
            buffer_percent: Math.round(end / v.duration * 100)
        });
    }

    function playbackSummary(reason) {
        if (!pb) return;
        var v = videoEl();
        var watched = pb.first_playing_at ? Math.round((Date.now() - pb.first_playing_at) / 1000) : 0;
        journal('playback_summary', {
            session_id: SESSION, playback_id: pb.id, search_id: searchId, reason: reason,
            total_watch_seconds: watched,
            time_to_first_playing_ms: pb.first_playing_at ? (pb.first_playing_at - pb.opened_at) : undefined,
            buffering_count: pb.buffering_count,
            buffering_total_ms: pb.buffering_total,
            min_buffer_ahead: pb.min_ahead === null ? undefined : Math.round(pb.min_ahead),
            file_size: pb.file_size, infohash: pb.infohash,
            duration: v && v.duration ? Math.round(v.duration) : undefined,
            computed_bitrate_mbps: (pb.file_size && v && v.duration)
                ? +(pb.file_size * 8 / 1000000 / v.duration).toFixed(2) : undefined
        });
        pb = null;
    }

    try {
        jLoad();
        journal('app_start', { session_id: SESSION, plugin_version: VERSION });

        var L = Lampa.Listener;

        if (L && L.follow) {
            L.follow('full', function (e) {
                if (e && e.type === 'complite' && e.data && e.data.movie) {
                    var m = e.data.movie;
                    var alt = (m.alternative_titles && m.alternative_titles.titles) || [];
                    var altList = [];
                    for (var i = 0; i < alt.length && i < 12; i++) {
                        altList.push({ c: alt[i].iso_3166_1, t: String(alt[i].title).slice(0, 60) });
                    }
                    journal('card_open', {
                        session_id: SESSION, id: m.id,
                        media_type: m.number_of_seasons ? 'tv' : 'movie',
                        anime_like: (m.original_language === 'ja' || m.original_language === 'zh') ? true : undefined,
                        title: m.title || m.name,
                        original_title: m.original_title || m.original_name,
                        original_language: m.original_language,
                        year: (m.release_date || m.first_air_date || '').slice(0, 4),
                        runtime: m.runtime || 0,
                        alternative_titles: altList,
                        alternative_titles_count: alt.length
                    });
                }
            });

            L.follow('activity', function () { setTimeout(hideShots, 300); });

            // torrent list: each rendered row, and the row the user picks
            L.follow('torrent', function (e) {
                try {
                    if (!e || !e.element) return;
                    if (e.type === 'render') noteResult(e.element);
                    else if (e.type === 'onenter') {
                        // Flush whatever the list produced even if the user picked
                        // a row before the debounce fired.
                        if (renderCount) {
                            if (endTimer) { clearTimeout(endTimer); endTimer = null; }
                            flushSearchEnd();
                        }
                        var it = e.element;
                        var tr = inferTracks(it.Title || '');
                        newPlayback({
                            infohash: it.Hash || it.hash || undefined,
                            file_size: isFinite(parseFloat(it.Size)) ? parseFloat(it.Size) : undefined
                        });
                        journal('torrent_selected', {
                            session_id: SESSION, search_id: searchId, playback_id: playbackId,
                            title: String(it.Title || '').slice(0, 180),
                            source: it.Tracker, infohash: it.Hash || it.hash || undefined,
                            size_bytes: isFinite(parseFloat(it.Size)) ? parseFloat(it.Size) : undefined,
                            size_raw: it.size, seeders: it.Seeders, peers: it.Peers,
                            pack_class: classify(it.Title || ''),
                            inferred_audio: tr.audio, inferred_subtitles: tr.subs, inferred_dub: tr.dub
                        });
                    }
                } catch (err) {}
            });

            // file list inside the torrent
            L.follow('torrent_file', function (e) {
                try {
                    if (!e) return;
                    if (e.type === 'list_open') {
                        journal('file_list_ready', {
                            session_id: SESSION, playback_id: playbackId,
                            file_count: (e.items || []).length,
                            elapsed_ms: pb ? (Date.now() - pb.opened_at) : undefined
                        });
                    } else if (e.type === 'onenter' && e.element) {
                        if (pb && e.element.length) pb.file_size = e.element.length;
                        journal('file_selected', {
                            session_id: SESSION, playback_id: playbackId,
                            path: String(e.element.path || '').slice(0, 200),
                            file_size: e.element.length
                        });
                    }
                } catch (err) {}
            });
        }

        // player: real HTML5 semantics, documented per event
        var PV = Lampa.PlayerVideo && Lampa.PlayerVideo.listener;
        if (PV && PV.follow) {
            PV.follow('canplay', function () {
                if (!pb) newPlayback({});
                if (!pb.opened_logged) {
                    pb.opened_logged = true;
                    journal('player_open', { session_id: SESSION, playback_id: pb.id, search_id: searchId, on: 'canplay' });
                }
            });
            PV.follow('playing', function () {
                if (!pb) return;
                if (!pb.first_playing_at) {
                    pb.first_playing_at = Date.now();
                    journal('first_playing', {
                        session_id: SESSION, playback_id: pb.id,
                        elapsed_ms: pb.first_playing_at - pb.opened_at,
                        semantic: 'HTML5 video "playing" event - playback actually started, not a decoded first frame'
                    });
                } else if (pb.buffering_at) {
                    var d = Date.now() - pb.buffering_at;
                    pb.buffering_at = 0; pb.buffering_total += d;
                    journal('buffering_end', { session_id: SESSION, playback_id: pb.id, duration_ms: d });
                }
            });
            PV.follow('waiting', function () {
                if (!pb || !pb.first_playing_at || pb.buffering_at) return;   // initial load is not rebuffering
                pb.buffering_at = Date.now(); pb.buffering_count++;
                journal('buffering_start', { session_id: SESSION, playback_id: pb.id });
            });
            PV.follow('timeupdate', function () {
                if (!pb) return;
                var now = Date.now();
                if (now - pb.last_sample < 5000) return;                      // at most once per 5 s
                pb.last_sample = now;
                bufferSample();
            });
            PV.follow('ended', function () { playbackSummary('ended'); });
            PV.follow('error', function (e) {
                journal('player_error', {
                    session_id: SESSION, playback_id: pb ? pb.id : undefined,
                    error: String((e && e.error) || '').slice(0, 200)
                });
                playbackSummary('error');
            });
            PV.follow('destroy', function () { playbackSummary('stop'); });
        }
        if (Lampa.Player && Lampa.Player.listener && Lampa.Player.listener.follow) {
            Lampa.Player.listener.follow('destroy', function () { playbackSummary('stop'); });
        }

        if (window.MutationObserver && document.body) {
            new window.MutationObserver(function () { hideShots(); })
                .observe(document.body, { childList: true, subtree: true });
        }
        hideShots();
    } catch (e) {}

    // Version marker - no telemetry, just something to read off the console.
    try {
        window.__lampa_torrfix_version = VERSION;
        window.__lampa_torrfix = { journal: journal, classify: classify, inferTracks: inferTracks, rememberTracks: rememberTracks };
        if (window.console && console.log) console.log('[Lampa TorrFix] v' + VERSION + ' loaded');
    } catch (e) {}
})();
