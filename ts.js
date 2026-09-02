(function () {
    'use strict';

    // Lampa TorrServer size and bitrate fix
    //
    // TorrServer MatriX.142.4 formats torrent sizes with a broken unit suffix: its
    // Go formatter uses "%.1f %cCiB", so it emits "3.5 GCiB" / "555.6 MCiB" instead
    // of "3.5 GiB" / "555.6 MiB".
    //
    // Lampa's Utils.sizeToBytes only matches (Mb|МБ|GB|ГБ|TB|ТБ), so those strings
    // parse to 0 bytes. Two visible consequences:
    //   1. the raw "3.5 GCiB" string is shown instead of Lampa's own "3,5 ГБ";
    //   2. bitrate is computed from 0 bytes, so the row reads "Битрейт: - Мбит/с".
    //
    // Scope: the torrent search list only. No network calls, no external scripts,
    // no storage writes, no eval, no changes to search, parser or player.
    // Remove the plugin to revert completely.

    var DASH = '—'; // em dash

    // ---------------------------------------------------------------- size parser

    var MULTIPLIER = {
        b: 1,
        k: 1024,
        m: 1048576,
        g: 1073741824,
        t: 1099511627776
    };

    var CYR_UNIT = { 'к': 'k', 'м': 'm', 'г': 'g', 'т': 't' }; // к м г т

    // Accepts "3.5 GCiB", "555.6 MCiB", "100 KCiB", "3.5 GiB", "3.5 GB",
    // "3,5 ГБ", "500 МБ", "1024 B". Always 1024-based, which is what both
    // TorrServer and Lampa already use - the numeric value is not rescaled.
    var SIZE_RE = /([0-9]+(?:[.,][0-9]+)?)\s*([KMGTКМГТ])?\s*(?:C?i?B|Б)(?![A-Za-zА-я])/i;

    function parseSize(str, fallback) {
        if (typeof str !== 'string' || !str) return 0;

        var m = str.match(SIZE_RE);
        if (!m) {
            // Unknown shape - defer to stock Lampa rather than guessing.
            if (typeof fallback === 'function') {
                try { return fallback(str); } catch (e) { return 0; }
            }
            return 0;
        }

        var value = parseFloat(m[1].replace(',', '.'));
        if (isNaN(value)) return 0;

        var unit = (m[2] || 'b').toLowerCase();
        if (CYR_UNIT[unit]) unit = CYR_UNIT[unit];

        return value * (MULTIPLIER[unit] || 1);
    }

    // ------------------------------------------------------------ pack detection

    // Deliberately narrow: a season/collection pack holds many episodes, so a
    // bitrate derived from the card's single-episode runtime would be wrong.
    // "Complete" alone is not enough (there are films called "A Complete Unknown"),
    // it only counts together with series/season/collection.
    var PACK_RE = new RegExp(
        '(^|[^A-Za-z0-9А-я])(' +
            's\\d{1,2}(?!\\s*e\\s*\\d)' +                     // S01, S1-S5 - but not S01E05
            '|seasons?[\\s._-]*\\d{1,2}' +                    // Season 1, Seasons 01
            '|сезон' +               // сезон
            '|complete[\\s._-]+(series|season|collection)' +  // Complete Series
            '|collection|коллекция' + // Collection / Коллекция
            '|dilogy|trilogy|anthology' +
            '|дилогия|трилогия|антология' +
        ')([^A-Za-z0-9А-я]|$)',
        'i'
    );

    function isPack(title) {
        return typeof title === 'string' && PACK_RE.test(title);
    }

    // ------------------------------------------------------------------ overrides

    if (!window.Lampa || !Lampa.Utils) return;

    if (!Lampa.Utils.__ts_size_patch) {
        var stock_sizeToBytes = Lampa.Utils.sizeToBytes;
        var stock_calcBitrate = Lampa.Utils.calcBitrate;

        Lampa.Utils.sizeToBytes = function (str) {
            return parseSize(str, function (s) {
                return stock_sizeToBytes ? stock_sizeToBytes.call(Lampa.Utils, s) : 0;
            });
        };

        // Stock calcBitrate returns 0 when runtime is missing, which renders as
        // "Битрейт: 0 Мбит/с". Return a dash instead - never an invented number.
        Lampa.Utils.calcBitrate = function (byteSize, minutes) {
            if (!minutes || !byteSize || !isFinite(byteSize) || byteSize <= 0) return DASH;

            // Same formula as stock Lampa, but rounded once. Calling the stock
            // helper first would round to 2 decimals and then to 1, which turns
            // a true 1.948 Mbps into "2.0" instead of "1.9".
            var mbps = byteSize * 8 / 1000000 / (minutes * 60);
            if (!isFinite(mbps) || mbps <= 0) return DASH;

            return mbps.toFixed(1);
        };

        Lampa.Utils.__ts_size_patch = true;
    }

    // ------------------------------------------------------------- display pass
    //
    // Lampa never calls calcBitrate at all when object.movie.runtime is missing -
    // it assigns bitrate = 0 directly. Overriding the helper is therefore not
    // enough, so the rendered row is normalised here as well.

    function fixItem(item) {
        if (item.__ts_bitrate_done) return true;

        var titleEl = item.querySelector('.torrent-item__title');
        var rateEl = item.querySelector('.torrent-item__bitrate span');

        // Not rendered yet - report failure so the item is retried later.
        if (!titleEl || !rateEl) return false;

        var text = rateEl.textContent || '';
        var parts = text.match(/^\s*([0-9]+(?:[.,][0-9]+)?)\s*(.*)$/);
        var value = parts ? parseFloat(parts[1].replace(',', '.')) : NaN;

        if (isPack(titleEl.textContent) || !isFinite(value) || value <= 0) {
            rateEl.textContent = DASH;
        } else {
            var tail = parts[2] ? ' ' + parts[2] : '';
            rateEl.textContent = value.toFixed(1) + tail;
        }

        item.__ts_bitrate_done = true;
        return true;
    }

    function scan(root) {
        if (!root || root.nodeType !== 1) return;

        // The added node may itself be the torrent item.
        if (root.classList && root.classList.contains('torrent-item')) fixItem(root);

        if (!root.querySelectorAll) return;
        var nested = root.querySelectorAll('.torrent-item');
        for (var i = 0; i < nested.length; i++) fixItem(nested[i]);
    }

    if (window.MutationObserver && document.body) {
        new window.MutationObserver(function (mutations) {
            for (var i = 0; i < mutations.length; i++) {
                var added = mutations[i].addedNodes;
                for (var j = 0; j < added.length; j++) scan(added[j]);
            }
        }).observe(document.body, { childList: true, subtree: true });

        // Anything already on screen when the plugin loaded.
        scan(document.body);
    }
})();
