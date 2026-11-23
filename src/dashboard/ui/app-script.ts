import { buildSparkline } from './sparkline-model.js';
import { buildWaterfall } from './waterfall-model.js';

/**
 * The dashboard client, served verbatim as one classic script (no import/export). Vanilla JS with
 * string concatenation only: the String.raw templates must hold no backtick and no dollar-brace
 * sequence. The waterfall and sparkline layout functions are embedded as their own compiled text, so
 * the unit-tested functions are the ones the browser runs; each is assigned to a var because a
 * minifier may rename the function itself.
 */
export const APP_SCRIPT: string =
  String.raw`(function () {
  'use strict';

  var MAX_ALERTS = 20;
  var MAX_TRACES = 20;
  var MAX_SPANS = 500;
  var MAX_WINDOWS = 300;
  var TREND_HEIGHT = 40;
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var BACKOFF_START_MS = 1000;
  var BACKOFF_CAP_MS = 30000;
  var STALE_MIN_MS = 5000;

  var buildWaterfall = ` +
  buildWaterfall.toString() +
  String.raw`;

  var buildSparkline = ` +
  buildSparkline.toString() +
  String.raw`;

  function formatMs(ns) {
    return (ns / 1e6).toFixed(1) + ' ms';
  }

  function formatMiB(bytes) {
    return (bytes / 1048576).toFixed(1) + ' MiB';
  }

  function formatTime(epochMs) {
    try {
      return new Date(epochMs).toISOString();
    } catch (error) {
      return String(epochMs);
    }
  }

  /** Splits complete SSE frames out of the buffer; returns the frames and the unfinished rest. */
  function splitFrames(buffer) {
    var frames = [];
    var index = buffer.indexOf('\n\n');
    while (index !== -1) {
      frames.push(buffer.slice(0, index));
      buffer = buffer.slice(index + 2);
      index = buffer.indexOf('\n\n');
    }
    return { frames: frames, rest: buffer };
  }

  /** One frame to { event, data }; a frame of only comment lines (the heartbeat) gives null. */
  function parseFrame(frame) {
    var event = 'message';
    var dataLines = [];
    var lines = frame.split('\n');
    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i];
      if (line === '' || line.charAt(0) === ':') {
        continue;
      }
      var colon = line.indexOf(':');
      var field = colon === -1 ? line : line.slice(0, colon);
      var value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.charAt(0) === ' ') {
        value = value.slice(1);
      }
      if (field === 'event') {
        event = value;
      } else if (field === 'data') {
        dataLines.push(value);
      }
    }
    if (dataLines.length === 0) {
      return null;
    }
    return { event: event, data: dataLines.join('\n') };
  }

  function init() {
    var meta = document.querySelector('meta[name="phargus-events"]');
    var statusEl = document.getElementById('status');
    var droppedEl = document.getElementById('dropped');
    var lagEl = document.getElementById('lag');
    var memoryEl = document.getElementById('memory');
    var gcEl = document.getElementById('gc');
    var backpressureEl = document.getElementById('backpressure');
    var hotspotsEl = document.getElementById('hotspots');
    var alertsEl = document.getElementById('alerts');
    var emptyEl = document.getElementById('alerts-empty');
    var waterfallEl = document.getElementById('waterfall');
    var waterfallEmptyEl = document.getElementById('waterfall-empty');
    var waterfallDroppedEl = document.getElementById('waterfall-dropped');
    var windowEndEls = document.querySelectorAll('.window-end');

    if (
      !meta ||
      !statusEl ||
      !droppedEl ||
      !lagEl ||
      !memoryEl ||
      !gcEl ||
      !backpressureEl ||
      !hotspotsEl ||
      !alertsEl ||
      !emptyEl ||
      !waterfallEl ||
      !waterfallEmptyEl ||
      !waterfallDroppedEl
    ) {
      console.error('phargus dashboard: the page is missing an expected element');
      if (statusEl) {
        statusEl.textContent = 'error: the page is incomplete';
        statusEl.className = 'status-error';
      }
      return;
    }

    var eventsUrl = new URL(meta.getAttribute('content') || 'events', document.baseURI);
    var backoffMs = BACKOFF_START_MS;
    var retryTimer = null;
    // Staleness: windows close only when a later sample arrives, so a frozen app sends nothing.
    var connected = false;
    var stale = false;
    var lastWindowAt = 0;
    var windowMs = 0;

    function setStatus(text, kind) {
      statusEl.textContent = text;
      statusEl.className = 'status-' + kind;
    }

    function renderWindow(w) {
      lagEl.textContent = 'p99 ' + formatMs(w.eventLoop.p99) + ' · max ' + formatMs(w.eventLoop.max);
      memoryEl.textContent =
        'heap ' + formatMiB(w.memory.heapUsedLast) + ' · rss ' + formatMiB(w.memory.rssLast);
      gcEl.textContent =
        w.gc.count +
        ' collections · ' +
        formatMs(w.gc.totalPause) +
        ' total pause · ' +
        formatMs(w.gc.maxPause) +
        ' max';
      for (var i = 0; i < windowEndEls.length; i += 1) {
        windowEndEls[i].textContent = 'window ending ' + formatTime(w.end);
      }
      lastWindowAt = Date.now();
      windowMs = w.end - w.start;
      if (stale) {
        stale = false;
        setStatus('live', 'live');
      }
      renderBackpressure(w.backpressure);
      renderDropped(w.dropped || { samples: 0, spans: 0 });
    }

    function renderDropped(dropped) {
      droppedEl.textContent =
        'agent dropped ' + dropped.samples + ' samples, ' + dropped.spans + ' spans';
      droppedEl.hidden = dropped.samples === 0 && dropped.spans === 0;
      waterfallDroppedEl.hidden = dropped.spans === 0;
    }

    /** Runs every second: after max(3 windows, 5 s) without a window, a live stream reads stale. */
    function checkStale() {
      if (!connected || lastWindowAt === 0) {
        return;
      }
      var silentMs = Date.now() - lastWindowAt;
      if (silentMs >= Math.max(3 * windowMs, STALE_MIN_MS)) {
        stale = true;
        setStatus('stale: no data for ' + Math.floor(silentMs / 1000) + ' s', 'error');
      }
    }

    /** An empty sparkline (one polyline per series) and its max label, inserted after the figure. */
    function createTrend(figureEl, lineCount) {
      var svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('class', 'trend');
      svg.setAttribute('viewBox', '0 0 ' + (MAX_WINDOWS - 1) + ' ' + TREND_HEIGHT);
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.setAttribute('aria-hidden', 'true');
      var lines = [];
      for (var i = 0; i < lineCount; i += 1) {
        var line = document.createElementNS(SVG_NS, 'polyline');
        line.setAttribute('class', 'trend-line trend-line-' + i);
        svg.appendChild(line);
        lines.push(line);
      }
      var maxEl = document.createElement('p');
      maxEl.className = 'trend-max';
      figureEl.parentNode.insertBefore(maxEl, figureEl.nextSibling);
      figureEl.parentNode.insertBefore(svg, maxEl);
      return { lines: lines, maxEl: maxEl };
    }

    // The last MAX_WINDOWS windows' figures, oldest first; each trend draws some of their keys.
    var recent = [];
    var trends = [
      { view: createTrend(lagEl, 1), keys: ['lag'], format: formatMs },
      { view: createTrend(memoryEl, 2), keys: ['heap', 'rss'], format: formatMiB },
      { view: createTrend(gcEl, 1), keys: ['gc'], format: formatMs },
      { view: createTrend(backpressureEl, 1), keys: ['stall'], format: formatMs },
    ];

    function drawTrends() {
      for (var t = 0; t < trends.length; t += 1) {
        var trend = trends[t];
        var series = trend.keys.map(function (key) {
          return recent.map(function (figures) {
            return figures[key];
          });
        });
        var sparkline = buildSparkline(series, MAX_WINDOWS, TREND_HEIGHT);
        for (var j = 0; j < sparkline.points.length; j += 1) {
          trend.view.lines[j].setAttribute('points', sparkline.points[j]);
        }
        trend.view.maxEl.textContent = recent.length === 0 ? '' : 'max ' + trend.format(sparkline.max);
      }
    }

    function renderBackpressure(bp) {
      while (hotspotsEl.firstChild) {
        hotspotsEl.removeChild(hotspotsEl.firstChild);
      }
      if (bp.events === 0) {
        backpressureEl.textContent = 'No stalls';
        return;
      }
      backpressureEl.textContent =
        bp.events +
        ' stalls · ' +
        formatMs(bp.totalStall) +
        ' total · ' +
        formatMs(bp.maxStall) +
        ' max';
      var hotspots = bp.hotspots || [];
      for (var i = 0; i < hotspots.length; i += 1) {
        var h = hotspots[i];
        var item = document.createElement('li');
        item.textContent =
          h.site +
          ' — ' +
          h.events +
          ' stalls · ' +
          formatMs(h.totalStall) +
          ' total · ' +
          formatMs(h.maxStall) +
          ' max';
        hotspotsEl.appendChild(item);
      }
    }

    function addAlert(a) {
      var item = document.createElement('li');
      item.textContent =
        a.ruleId +
        ' ' +
        a.state +
        ' — ' +
        a.metric +
        ' ' +
        a.comparison +
        ' ' +
        a.threshold +
        ' (observed ' +
        a.observed +
        ') ' +
        formatTime(a.windowEnd);
      alertsEl.insertBefore(item, alertsEl.firstChild);
      while (alertsEl.children.length > MAX_ALERTS) {
        alertsEl.removeChild(alertsEl.lastChild);
      }
      emptyEl.hidden = true;
    }

    function clearAlerts() {
      while (alertsEl.firstChild) {
        alertsEl.removeChild(alertsEl.firstChild);
      }
      emptyEl.hidden = false;
    }

    var spans = [];

    function renderWaterfall(model) {
      while (waterfallEl.firstChild) {
        waterfallEl.removeChild(waterfallEl.firstChild);
      }
      for (var t = 0; t < model.traces.length; t += 1) {
        var trace = model.traces[t];
        var item = document.createElement('li');
        item.className = 'trace';
        for (var r = 0; r < trace.rows.length; r += 1) {
          var row = trace.rows[r];
          var rowEl = document.createElement('div');
          rowEl.className = row.isError ? 'row row-error' : 'row';
          var labelEl = document.createElement('span');
          labelEl.className = 'row-label';
          labelEl.textContent = (row.isError ? 'error ' : '') + row.label;
          var trackEl = document.createElement('span');
          trackEl.className = 'track';
          var barEl = document.createElement('span');
          barEl.className = 'bar';
          barEl.style.left = row.offsetPct + '%';
          barEl.style.width = row.widthPct + '%';
          trackEl.appendChild(barEl);
          rowEl.appendChild(labelEl);
          rowEl.appendChild(trackEl);
          item.appendChild(rowEl);
        }
        waterfallEl.appendChild(item);
      }
      waterfallEmptyEl.hidden = model.traces.length > 0;
    }

    // Renders run at most once per animation frame: a change sets its dirty flag and calls
    // scheduleFrame, and the one pending frame redraws whatever is dirty.
    var frameRequested = false;
    var waterfallDirty = false;
    var trendsDirty = false;

    function scheduleFrame() {
      if (!frameRequested) {
        frameRequested = true;
        requestAnimationFrame(onFrame);
      }
    }

    function onFrame() {
      frameRequested = false;
      try {
        if (trendsDirty) {
          trendsDirty = false;
          drawTrends();
        }
        if (waterfallDirty) {
          waterfallDirty = false;
          renderWaterfall(buildWaterfall(spans, MAX_TRACES));
        }
      } catch (error) {
        console.error('phargus dashboard: render failed', error);
        setStatus('error: render failed', 'error');
      }
    }

    function clearWaterfall() {
      spans = [];
      waterfallDirty = true;
      scheduleFrame();
    }

    function clearTrends() {
      recent = [];
      trendsDirty = true;
      scheduleFrame();
    }

    /** Keeps the window's figures for the sparklines; they redraw on the next frame. */
    function addTrendPoint(w) {
      recent.push({
        lag: w.eventLoop.p99,
        heap: w.memory.heapUsedLast,
        rss: w.memory.rssLast,
        gc: w.gc.totalPause,
        stall: w.backpressure.totalStall,
      });
      if (recent.length > MAX_WINDOWS) {
        recent.shift();
      }
      trendsDirty = true;
      scheduleFrame();
    }

    function addSpan(span) {
      spans.push(span);
      if (spans.length > MAX_SPANS) {
        spans.shift();
      }
      waterfallDirty = true;
      scheduleFrame();
    }

    function handleFrame(frame) {
      var parsed = parseFrame(frame);
      if (parsed === null) {
        return;
      }
      if (parsed.event !== 'window' && parsed.event !== 'alert' && parsed.event !== 'span') {
        return;
      }
      try {
        var payload = JSON.parse(parsed.data);
        if (parsed.event === 'window') {
          renderWindow(payload);
          addTrendPoint(payload);
        } else if (parsed.event === 'span') {
          addSpan(payload);
        } else {
          addAlert(payload);
        }
      } catch (error) {
        console.error('phargus dashboard: bad ' + parsed.event + ' event', error);
        setStatus('error: bad ' + parsed.event + ' event', 'error');
      }
    }

    function scheduleRetry() {
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
      }
      retryTimer = setTimeout(function () {
        retryTimer = null;
        connect();
      }, backoffMs);
      backoffMs = Math.min(backoffMs * 2, BACKOFF_CAP_MS);
    }

    function onDisconnect(error) {
      if (error) {
        console.error('phargus dashboard: stream error', error);
      }
      connected = false;
      stale = false;
      setStatus('reconnecting', 'reconnecting');
      scheduleRetry();
    }

    async function readLoop(reader) {
      var decoder = new TextDecoder();
      var buffer = '';
      while (true) {
        var result = await reader.read();
        if (result.done) {
          return;
        }
        buffer += decoder.decode(result.value, { stream: true });
        buffer = buffer.replace(/\r\n/g, '\n');
        var split = splitFrames(buffer);
        for (var i = 0; i < split.frames.length; i += 1) {
          handleFrame(split.frames[i]);
        }
        buffer = split.rest;
      }
    }

    function connect() {
      setStatus('connecting', 'reconnecting');
      fetch(eventsUrl.href, {
        headers: { accept: 'text/event-stream' },
        cache: 'no-store',
        credentials: 'same-origin',
      })
        .then(function (response) {
          if (response.status === 401 || response.status === 403) {
            setStatus('unauthorized — open the dashboard login link /login#token=… again', 'error');
            return null;
          }
          if (!response.ok || !response.body) {
            setStatus('error: HTTP ' + response.status, 'error');
            scheduleRetry();
            return null;
          }
          backoffMs = BACKOFF_START_MS;
          clearAlerts();
          clearTrends();
          clearWaterfall();
          connected = true;
          setStatus('live', 'live');
          return readLoop(response.body.getReader()).then(function () {
            onDisconnect(null);
          });
        })
        .catch(onDisconnect);
    }

    connect();
    setInterval(checkStale, 1000);
  }

  if (document.readyState !== 'loading') {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }
})();
`;
