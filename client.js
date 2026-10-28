/**
 * dsh-chat-search — Ctrl+F over the open conversation.
 *
 * Design rules (they matter more than the feature list):
 *   - Nothing is opened and nothing is scrolled while the search runs. Collapsed
 *     blocks are conditional renders, so their text is simply not in the DOM —
 *     the search covers what is actually rendered and never mutates the
 *     conversation to reach more.
 *   - The scan is sliced across frames, so the count climbs while the rest of
 *     the conversation is still being scanned and the app stays usable.
 *   - The first stop is the match nearest to where the reader already is, and
 *     it is scrolled into view only as far as needed (not at all when it is
 *     already visible).
 *   - Matches are painted with the CSS Custom Highlight API: ranges only, no
 *     DOM mutation, nothing for React to reconcile.
 *   - IME composition is respected: while a composition is open nothing is
 *     searched, so a Chinese word is searched once, not as its latin key noise.
 */
window.__ModuleLoader__.load({
  id: 'dsh-chat-search',
  factory(require) {
    'use strict';

    const React = require('react');
    const h = React.createElement;

    const ALL_HIGHLIGHT = 'dsh-chat-search-all';
    const CURRENT_HIGHLIGHT = 'dsh-chat-search-current';

    /** Matches collected by one scan; beyond this the counter is capped. */
    const MAX_MATCHES = 3000;
    /** Ranges handed to the highlight registry. */
    const MAX_PAINT = 1200;
    /** Rows the positions list draws at most. */
    const LIST_LIMIT = 300;
    /** Nodes walked per frame slice, and the time budget for one slice. */
    const SLICE_NODES = 900;
    const SLICE_MS = 8;
    /** Pages of older history paged in per search. */
    const MAX_HISTORY_PAGES = 80;
    const HISTORY_DEADLINE_MS = 12000;

    const CHAT_REGION = '[data-conversation-region="chat"]';
    const COMPOSER_REGION = '[data-conversation-region="composer"]';
    const SCROLL_ATTR = 'data-conversation-scroll';

    /** Tags whose text is chrome rather than conversation content. */
    const SKIP_TAGS = {
      SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, TEXTAREA: 1, INPUT: 1,
      SELECT: 1, OPTION: 1, SVG: 1, CANVAS: 1, IFRAME: 1, VIDEO: 1, AUDIO: 1,
    };

    /** Tags that do not start a new matchable block, so phrases can span them. */
    const INLINE_TAGS = {
      A: 1, ABBR: 1, B: 1, BDI: 1, BDO: 1, BR: 1, CITE: 1, CODE: 1, DATA: 1,
      DEL: 1, DFN: 1, EM: 1, I: 1, INS: 1, KBD: 1, MARK: 1, Q: 1, S: 1,
      SAMP: 1, SMALL: 1, SPAN: 1, STRONG: 1, SUB: 1, SUP: 1, TIME: 1, U: 1,
      VAR: 1, WBR: 1, IMG: 1, LABEL: 1, MATH: 1,
    };

    const TEXT = {
      zh: {
        label: '在当前对话中搜索',
        placeholder: '在当前对话中搜索',
        prev: '上一个（Shift+Enter）',
        next: '下一个（Enter）',
        close: '关闭搜索（Esc）',
        positions: '点击查看全部命中位置',
        positionsOpen: '收起命中位置',
        none: '无结果',
        loadingHistory: '正在加载更早的消息…',
        historyIncomplete: '只搜索了已加载的部分',
        truncated: '命中超过 {max} 处，仅统计前 {max} 处',
        listTruncated: '共 {total} 处，仅列出前 {shown} 处',
        noConversation: '没有可搜索的对话',
        noHighlight: '此浏览器不支持正文高亮',
        returnHome: '回到搜索前的位置',
      },
      en: {
        label: 'Search in this conversation',
        placeholder: 'Search this conversation',
        prev: 'Previous match (Shift+Enter)',
        next: 'Next match (Enter)',
        close: 'Close search (Esc)',
        positions: 'Show every match',
        positionsOpen: 'Hide the match list',
        none: 'no results',
        loadingHistory: 'Loading earlier messages…',
        historyIncomplete: 'Only the loaded part was searched',
        truncated: 'More than {max} matches; the first {max} are counted',
        listTruncated: '{total} matches, the first {shown} are listed',
        noConversation: 'No conversation to search',
        noHighlight: 'This browser cannot highlight the text',
        returnHome: 'Back to where you were',
      },
    };

    const CSS_TEXT = [
      '.dsf-layer{position:fixed;display:block;pointer-events:none;z-index:40}',
      '.dsf-panel{pointer-events:auto;box-sizing:border-box;display:flex;flex-direction:column;gap:6px;',
      'width:min(380px,calc(100vw - 32px));padding:8px 10px;border-radius:12px;',
      'background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1,#fff));',
      'border:.5px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));',
      'box-shadow:var(--dsw-elevation-prominent,0 8px 28px rgba(0,0,0,.16));',
      'color:var(--dsw-alias-label-primary,#111);font-size:13px;line-height:18px;font-family:inherit}',
      '.dsf-row{display:flex;align-items:center;gap:4px;min-width:0}',
      '.dsf-icon{display:inline-flex;flex:none;width:16px;height:16px;',
      'color:var(--dsw-alias-label-secondary,#666)}',
      '.dsf-input{flex:1 1 auto;min-width:0;height:26px;box-sizing:border-box;padding:0 8px;',
      'border-radius:7px;border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.18));',
      'background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);',
      'font:inherit;outline:none}',
      '.dsf-input::placeholder{color:var(--dsw-alias-label-secondary,#666);opacity:.75}',
      '.dsf-input:focus{border-color:var(--dsw-alias-brand-primary,#1f6feb)}',
      '.dsf-count{flex:none;display:inline-flex;align-items:center;justify-content:center;',
      'min-width:46px;height:24px;padding:0 5px;border:0;border-radius:6px;background:transparent;',
      'font:inherit;font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap;',
      'color:var(--dsw-alias-label-secondary,#666);cursor:pointer}',
      '.dsf-count:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));',
      'color:var(--dsw-alias-label-primary,#111)}',
      '.dsf-count:disabled{cursor:default}',
      '.dsf-btn{flex:none;display:inline-flex;align-items:center;justify-content:center;',
      'width:24px;height:24px;padding:0;border:0;border-radius:6px;background:transparent;',
      'color:var(--dsw-alias-label-secondary,#666);cursor:pointer}',
      '.dsf-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));',
      'color:var(--dsw-alias-label-primary,#111)}',
      '.dsf-btn:disabled{opacity:.35;cursor:default}',
      '.dsf-btn:focus-visible,.dsf-count:focus-visible,.dsf-item:focus-visible{',
      'outline:2px solid var(--dsw-alias-brand-primary,#1f6feb);outline-offset:1px}',
      '.dsf-note{margin:-2px 2px 0;font-size:12px;line-height:16px;',
      'color:var(--dsw-alias-label-secondary,#666)}',
      '.dsf-list{margin:0;padding:2px;max-height:220px;overflow-y:auto;list-style:none;',
      'border-top:.5px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));',
      'display:flex;flex-direction:column;gap:1px}',
      '.dsf-item{display:flex;align-items:baseline;gap:8px;width:100%;padding:3px 6px;box-sizing:border-box;',
      'border:0;border-radius:6px;background:transparent;text-align:left;font:inherit;font-size:12px;',
      'line-height:16px;color:var(--dsw-alias-label-primary,#111);cursor:pointer}',
      '.dsf-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}',
      '.dsf-item[data-active="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));',
      'box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary,#1f6feb)}',
      '.dsf-item-index{flex:none;min-width:26px;text-align:right;font-variant-numeric:tabular-nums;',
      'color:var(--dsw-alias-label-secondary,#666)}',
      '.dsf-item-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsf-item-text mark{background:transparent;color:var(--dsw-alias-brand-primary,#1f6feb)}',
      '::highlight(dsh-chat-search-all){background-color:rgba(255,196,0,.34);color:inherit}',
      '::highlight(dsh-chat-search-current){background-color:rgba(255,145,0,.85);color:#1b1b1b}',
    ].join('');

    /* ------------------------------------------------------------------ *
     * Small helpers
     * ------------------------------------------------------------------ */

    function escapeRegExp(value) {
      return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function delay(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function nextFrame() {
      return new Promise((resolve) => {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
        else setTimeout(resolve, 16);
      });
    }

    let services = {};

    function text(key, params) {
      let locale = 'en';
      try {
        const service = services.locale;
        if (service) {
          const current = service.getLocale();
          if (current && current.active) locale = String(current.active);
        }
      } catch (err) {
        locale = 'en';
      }
      if (!/^zh/i.test(locale)) {
        try {
          const lang = document.documentElement.getAttribute('lang') || navigator.language || 'en';
          if (/^zh/i.test(String(lang))) locale = 'zh';
        } catch (err) {
          /* keep the default */
        }
      }
      const dict = /^zh/i.test(locale) ? TEXT.zh : TEXT.en;
      let value = dict[key] || TEXT.en[key] || key;
      if (params) {
        Object.keys(params).forEach((name) => {
          value = value.replace(new RegExp('\\{' + name + '\\}', 'g'), String(params[name]));
        });
      }
      return value;
    }

    let highlightSupport = null;
    function supportsHighlight() {
      if (highlightSupport === null) {
        highlightSupport = Boolean(
          typeof CSS !== 'undefined' && CSS && CSS.highlights && typeof window.Highlight === 'function',
        );
      }
      return highlightSupport;
    }

    /** The visible conversation body — the panel scans the largest one. */
    function findChatRoot() {
      let best = null;
      let bestArea = 0;
      let nodes;
      try {
        nodes = document.querySelectorAll(CHAT_REGION);
      } catch (err) {
        return null;
      }
      for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index];
        if (node.closest(COMPOSER_REGION)) continue;
        let rect;
        try {
          rect = node.getBoundingClientRect();
        } catch (err) {
          continue;
        }
        if (rect.width < 80 || rect.height < 80) continue;
        const area = rect.width * rect.height;
        if (area > bestArea) {
          bestArea = area;
          best = node;
        }
      }
      return best;
    }

    function scrollContainer(root) {
      if (!root) return null;
      try {
        return root.querySelector(':scope > [' + SCROLL_ATTR + ']') || root.querySelector('[' + SCROLL_ATTR + ']');
      } catch (err) {
        return null;
      }
    }

    function rootSessionId(root) {
      if (!root) return '';
      return root.getAttribute('data-conversation-session') || '';
    }

    function skipElement(element) {
      if (SKIP_TAGS[element.tagName]) return true;
      if (element.hasAttribute('hidden')) return true;
      if (element.hasAttribute('inert')) return true;
      if (element.getAttribute('data-conversation-region') === 'composer') return true;
      return false;
    }

    /* ------------------------------------------------------------------ *
     * Text indexing, sliced across frames
     * ------------------------------------------------------------------ */

    /**
     * Walks the conversation in document order and yields match blocks: an
     * element plus the text of its inline descendants joined together, so a
     * query may span `<b>`, `<code>` and friends. `step()` visits at most
     * `limit` nodes and reports whether the tree is exhausted.
     */
    function createGroupWalker(scope) {
      const groups = [];
      const byBlock = new Map();
      const nodeStack = [scope];
      const blockStack = [scope];
      let matched = 0;

      const addText = (block, node) => {
        const value = node.nodeValue;
        if (!value || !value.trim()) return;
        let group = byBlock.get(block);
        if (!group) {
          group = { block, nodes: [], starts: [], size: 0 };
          byBlock.set(block, group);
          groups.push(group);
        }
        group.starts.push(group.size);
        group.nodes.push(node);
        group.size += value.length;
      };

      return {
        groups,
        get matched() {
          return matched;
        },
        set matched(value) {
          matched = value;
        },
        step(limit) {
          let visited = 0;
          while (nodeStack.length && visited < limit) {
            const last = nodeStack.length - 1;
            const node = nodeStack.pop();
            const block = blockStack.pop();
            visited += 1;
            if (node.nodeType === 3) {
              addText(block, node);
              continue;
            }
            if (node.nodeType !== 1) continue;
            if (node !== scope && skipElement(node)) continue;
            const children = node.childNodes;
            for (let index = children.length - 1; index >= 0; index -= 1) {
              const child = children[index];
              nodeStack.push(child);
              blockStack.push(child.nodeType === 1 && !INLINE_TAGS[child.tagName] ? child : block);
            }
          }
          return nodeStack.length === 0;
        },
      };
    }

    /**
     * Runs `pattern` over one block's joined text. `visit` receives the joined
     * string, the regex hit and the group; returning false stops the group.
     * Returns true when it was stopped early.
     */
    function eachMatch(group, pattern, visit) {
      let joined = '';
      for (let index = 0; index < group.nodes.length; index += 1) {
        joined += group.nodes[index].nodeValue;
      }
      pattern.lastIndex = 0;
      let hit = pattern.exec(joined);
      while (hit) {
        if (!hit[0].length) {
          pattern.lastIndex += 1;
          hit = pattern.exec(joined);
          continue;
        }
        if (visit(joined, hit, group) === false) return true;
        hit = pattern.exec(joined);
      }
      return false;
    }

    function locate(group, offset) {
      const starts = group.starts;
      if (!starts.length) return null;
      if (offset >= group.size) {
        const last = group.nodes[group.nodes.length - 1];
        return { node: last, offset: last.nodeValue.length };
      }
      let low = 0;
      let high = starts.length - 1;
      while (low < high) {
        const middle = (low + high + 1) >> 1;
        if (starts[middle] <= offset) low = middle;
        else high = middle - 1;
      }
      const node = group.nodes[low];
      return { node, offset: Math.min(offset - starts[low], node.nodeValue.length) };
    }

    function makeRange(group, start, end) {
      const from = locate(group, start);
      const to = locate(group, end);
      if (!from || !to) return null;
      const range = document.createRange();
      try {
        range.setStart(from.node, from.offset);
        range.setEnd(to.node, to.offset);
      } catch (err) {
        return null;
      }
      return range;
    }

    /* ------------------------------------------------------------------ *
     * Revealing a match
     * ------------------------------------------------------------------ */

    /** Scrollable ancestors of a node, innermost first, stopping at the chat scroller. */
    function collectScrollers(element) {
      const scrollers = [];
      for (let node = element; node && node !== document.body; node = node.parentElement) {
        let style = null;
        try {
          style = window.getComputedStyle(node);
        } catch (err) {
          style = null;
        }
        if (
          style &&
          (style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflowY === 'overlay') &&
          node.scrollHeight > node.clientHeight + 2
        ) {
          scrollers.push(node);
        }
        if (node.hasAttribute(SCROLL_ATTR)) break;
      }
      return scrollers;
    }

    function scrollIntoBox(box, rect, mode) {
      const boxRect = box.getBoundingClientRect();
      const margin = 12;
      let delta = 0;
      if (mode === 'center') {
        delta = rect.top - boxRect.top - (boxRect.height - rect.height) / 2;
      } else {
        if (rect.top >= boxRect.top + margin && rect.bottom <= boxRect.bottom - margin) return false;
        if (rect.top < boxRect.top + margin) delta = rect.top - boxRect.top - margin;
        else delta = rect.bottom - boxRect.bottom + margin;
      }
      if (Math.abs(delta) < 1) return false;
      try {
        box.scrollBy({ top: delta, behavior: 'auto' });
      } catch (err) {
        return false;
      }
      return true;
    }

    /**
     * Brings a match into view. `nearest` moves the view only when the match is
     * not visible already; `center` puts it in the middle (explicit navigation).
     */
    function revealMatch(range, mode) {
      if (!range || !range.startContainer || !range.startContainer.isConnected) return false;
      const start = range.startContainer;
      const element = start.nodeType === 1 ? start : start.parentElement;
      if (!element) return false;

      const scrollers = collectScrollers(element);
      if (!scrollers.length) {
        if (mode === 'center') {
          try {
            element.scrollIntoView({ block: 'center', inline: 'nearest' });
          } catch (err) {
            return false;
          }
          return true;
        }
        let rect;
        try {
          rect = range.getBoundingClientRect();
        } catch (err) {
          return false;
        }
        if (rect.top >= 0 && rect.bottom <= (window.innerHeight || 0)) return false;
        try {
          element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        } catch (err) {
          return false;
        }
        return true;
      }

      for (let index = 0; index < scrollers.length; index += 1) {
        let rect;
        try {
          rect = range.getBoundingClientRect();
        } catch (err) {
          return false;
        }
        if (!rect || (!rect.width && !rect.height)) return false;
        scrollIntoBox(scrollers[index], rect, mode);
      }
      return true;
    }

    /* ------------------------------------------------------------------ *
     * Controller
     * ------------------------------------------------------------------ */

    function createController() {
      const listeners = new Set();
      let state = {
        open: false,
        query: '',
        total: 0,
        filled: 0,
        index: -1,
        phase: '',
        searching: false,
        truncated: false,
        noRoot: false,
        historyIncomplete: false,
        showList: false,
        canReturn: false,
        focusTick: 0,
      };

      let root = null;
      let sessionKey = '';
      let matches = [];
      let current = null;
      let allHighlight = null;
      let painted = 0;
      let observer = null;
      let queryTimer = null;
      let rescanTimer = null;
      let chain = Promise.resolve();
      let token = 0;
      let scanning = false;
      let lastScanEnd = 0;
      let historyStarted = false;
      let lastScannedQuery = '';
      let home = null;
      let pendingJump = false;
      let steppedDuringScan = false;
      let focusReturn = null;
      let uiElement = null;

      function emit() {
        listeners.forEach((listener) => {
          try {
            listener();
          } catch (err) {
            console.error('[dsh-chat-search] listener failed', err);
          }
        });
      }

      function patch(changes) {
        state = Object.assign({}, state, changes);
        emit();
      }

      function subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }

      function getState() {
        return state;
      }

      /* ----- highlights ----- */

      function clearHighlights() {
        allHighlight = null;
        painted = 0;
        if (!supportsHighlight()) return;
        try {
          CSS.highlights.delete(ALL_HIGHLIGHT);
          CSS.highlights.delete(CURRENT_HIGHLIGHT);
        } catch (err) {
          /* the registry is best effort */
        }
      }

      function beginHighlights() {
        clearHighlights();
        if (!supportsHighlight()) return;
        try {
          allHighlight = new Highlight();
          allHighlight.priority = 0;
          CSS.highlights.set(ALL_HIGHLIGHT, allHighlight);
        } catch (err) {
          allHighlight = null;
        }
      }

      function addHighlight(range) {
        if (!allHighlight || painted >= MAX_PAINT) return;
        try {
          allHighlight.add(range);
          painted += 1;
        } catch (err) {
          /* ignore a range the registry rejects */
        }
      }

      function setCurrent(range) {
        if (!supportsHighlight()) return;
        try {
          if (!range) {
            CSS.highlights.delete(CURRENT_HIGHLIGHT);
            return;
          }
          const highlight = new Highlight(range);
          highlight.priority = 1;
          CSS.highlights.set(CURRENT_HIGHLIGHT, highlight);
        } catch (err) {
          /* ignore */
        }
      }

      /* ----- history paging ----- */

      async function loadHistory(scope) {
        const service = services.sessions;
        const id = rootSessionId(scope);
        if (!service || !id || typeof service.binding !== 'function') return false;
        let binding = null;
        try {
          binding = service.binding(id);
        } catch (err) {
          binding = null;
        }
        if (!binding || !binding.session) return false;
        const session = binding.session;

        const deadline = Date.now() + HISTORY_DEADLINE_MS;
        let pages = 0;
        let stalls = 0;
        while (pages < MAX_HISTORY_PAGES) {
          if (!state.open) return false;
          let snapshot = null;
          try {
            snapshot = session.getSnapshot();
          } catch (err) {
            return true;
          }
          if (!snapshot || !snapshot.hasMore) return false;
          if (snapshot.loadingOlder) {
            stalls += 1;
            if (stalls > 200) return true;
            await delay(50);
            continue;
          }
          if (Date.now() > deadline) return true;
          try {
            await session.loadOlder();
          } catch (err) {
            return true;
          }
          pages += 1;
          await delay(16);
        }
        return true;
      }

      /* ----- where the reader is ----- */

      function viewportAnchor(scope) {
        const scroller = scrollContainer(scope) || scope;
        let rect;
        try {
          rect = scroller.getBoundingClientRect();
        } catch (err) {
          return null;
        }
        const x = rect.left + Math.min(160, Math.max(24, rect.width * 0.3));
        const viewHeight = window.innerHeight || 800;
        const spots = [Math.max(rect.top, 0) + 12, Math.min(rect.bottom, viewHeight) - 12];
        for (let index = 0; index < spots.length; index += 1) {
          let element = null;
          try {
            element = document.elementFromPoint(x, spots[index]);
          } catch (err) {
            element = null;
          }
          if (!element || !scope.contains(element)) continue;
          // Our own panel may sit over the conversation; look past it.
          if (typeof element.closest === 'function' && element.closest('[data-dsh-find-panel]')) continue;
          return element;
        }
        return null;
      }

      /** True when `block` sits at or after the anchor in document order. */
      function atOrAfter(block, anchor) {
        if (!anchor || !block) return true;
        if (block === anchor) return true;
        if (anchor.contains(block)) return true;
        if (block.contains(anchor)) return false;
        try {
          return Boolean(anchor.compareDocumentPosition(block) & 4);
        } catch (err) {
          return true;
        }
      }

      /* ----- the reading position the panel gives back ----- */

      /**
       * Remembers where the reader stood when the panel opened: the top visible
       * element plus its offset inside the scroller, not a scroll number, so
       * paging older history in (which changes scrollTop) cannot spoil it.
       */
      function captureHome() {
        const scope = root && root.isConnected ? root : findChatRoot();
        if (!scope) {
          home = null;
          return;
        }
        const scroller = scrollContainer(scope) || scope;
        let rect = null;
        try {
          rect = scroller.getBoundingClientRect();
        } catch (err) {
          rect = null;
        }
        const element = viewportAnchor(scope);
        home = {
          scope,
          scroller,
          element,
          offset: element && rect ? element.getBoundingClientRect().top - rect.top : 0,
          scrollTop: scroller.scrollTop || 0,
          session: rootSessionId(scope),
        };
      }

      function homeDelta() {
        if (!home || !home.element || !home.element.isConnected) return 0;
        let rect;
        try {
          rect = home.scroller.getBoundingClientRect();
        } catch (err) {
          return 0;
        }
        return home.element.getBoundingClientRect().top - rect.top - home.offset;
      }

      /** True when the view has left the saved reading position. */
      function homeAway() {
        if (!home) return false;
        if (home.element && home.element.isConnected) return Math.abs(homeDelta()) >= 8;
        const scroller = home.scroller;
        if (!scroller || !scroller.isConnected) return false;
        return Math.abs((scroller.scrollTop || 0) - home.scrollTop) >= 8;
      }

      /** Called after anything scrolled the conversation for us. */
      function noteMoved() {
        if (!home) return;
        const away = homeAway();
        if (away !== state.canReturn) patch({ canReturn: away });
      }

      function returnHome() {
        if (!home) return false;
        const target = home;
        if (!target.scroller || !target.scroller.isConnected) {
          home = null;
          patch({ canReturn: false });
          return false;
        }
        if (target.session !== rootSessionId(root)) {
          home = null;
          patch({ canReturn: false });
          return false;
        }
        if (target.element && target.element.isConnected) {
          const delta = homeDelta();
          if (Math.abs(delta) < 1) {
            patch({ canReturn: false });
            return true;
          }
          try {
            target.scroller.scrollBy({ top: delta, behavior: 'auto' });
          } catch (err) {
            return false;
          }
          patch({ canReturn: false });
          return true;
        }
        // The element was re-rendered away; fall back to the raw scroll offset,
        // which is only exact while nothing was prepended above it.
        if (Math.abs((target.scroller.scrollTop || 0) - target.scrollTop) >= 1) {
          target.scroller.scrollTop = target.scrollTop;
          patch({ canReturn: false });
          return true;
        }
        patch({ canReturn: false });
        return true;
      }

      /* ----- scanning ----- */

      function attachObserver(scope) {
        if (observer || typeof MutationObserver !== 'function') return;
        observer = new MutationObserver(() => {
          if (!state.open || !state.query.trim()) return;
          // Streaming re-renders constantly; each mutation pushes the rescan a
          // little further out, so the panel only catches up once the
          // conversation goes quiet instead of scanning on every token.
          scheduleRescan(Math.max(500, 900 - (Date.now() - lastScanEnd)));
        });
        try {
          observer.observe(scope, { childList: true, subtree: true, characterData: true });
        } catch (err) {
          observer = null;
        }
      }

      function detachObserver() {
        if (observer) {
          try {
            observer.disconnect();
          } catch (err) {
            /* ignore */
          }
          observer = null;
        }
      }

      function scheduleRescan(ms) {
        if (rescanTimer) clearTimeout(rescanTimer);
        rescanTimer = setTimeout(() => {
          rescanTimer = null;
          runNow();
        }, ms);
      }

      function scheduleQuery(ms) {
        if (queryTimer) clearTimeout(queryTimer);
        queryTimer = setTimeout(() => {
          queryTimer = null;
          runNow();
        }, ms);
      }

      /** Runs a scan now, or retries shortly when one is already in flight. */
      function runNow() {
        if (scanning) {
          scheduleRescan(250);
          return;
        }
        refresh();
      }

      function refresh() {
        if (!state.open) return;
        chain = chain
          .then(() => scan())
          .catch((err) => console.error('[dsh-chat-search] scan failed', err));
      }

      function matchGroup(group, pattern, anchor) {
        return eachMatch(group, pattern, (joined, hit) => {
          const start = hit.index;
          const end = start + hit[0].length;
          const range = makeRange(group, start, end);
          if (range) {
            const entry = {
              range,
              text: joined.slice(Math.max(0, start - 28), Math.min(joined.length, end + 28)),
            };
            matches.push(entry);
            addHighlight(range);
            if (!current && atOrAfter(group.block, anchor)) current = entry;
          }
          return matches.length < MAX_MATCHES;
        });
      }

      async function scan() {
        if (scanning) return;
        scanning = true;
        const mine = ++token;
        try {
          await runScan(mine);
        } catch (err) {
          console.error('[dsh-chat-search] scan failed', err);
        } finally {
          scanning = false;
          lastScanEnd = Date.now();
          // A scan that died half way must not leave the panel spinning.
          if (mine === token && state.open && state.searching) patch({ searching: false });
        }
      }

      async function runScan(mine) {
        if (!state.open) return;
        const scope = findChatRoot();
        if (!scope) {
          matches = [];
          current = null;
          clearHighlights();
          patch({ total: 0, filled: 0, index: -1, noRoot: true, phase: '', searching: false, truncated: false });
          return;
        }
        const key = rootSessionId(scope);
        if (scope !== root || key !== sessionKey) {
          root = scope;
          sessionKey = key;
          historyStarted = false;
          // Only a different conversation invalidates the saved reading
          // position; the same one re-rendering an element does not.
          if (home && home.session !== key) {
            home = null;
            patch({ canReturn: false });
          }
        }
        attachObserver(root);
        patch({ noRoot: false });

        const query = state.query;
        if (!query.trim()) {
          matches = [];
          current = null;
          clearHighlights();
          patch({ total: 0, filled: 0, index: -1, phase: '', searching: false, truncated: false });
          return;
        }

        const reset = query !== lastScannedQuery;
        lastScannedQuery = query;
        const jump = pendingJump;
        pendingJump = false;
        steppedDuringScan = false;
        matches = [];
        current = null;
        beginHighlights();
        patch(
          reset
            ? { total: 0, filled: 0, index: -1, phase: '', searching: true, truncated: false }
            : { filled: 0, phase: '', searching: true, truncated: false },
        );

        const anchor = jump ? viewportAnchor(root) : null;

        if (!historyStarted) {
          historyStarted = true;
          patch({ phase: 'history' });
          const incomplete = await loadHistory(root);
          if (mine !== token || !state.open) return;
          patch({ phase: '', historyIncomplete: incomplete });
        }

        const pattern = new RegExp(escapeRegExp(query), 'gi');
        const walker = createGroupWalker(root);
        let truncated = false;
        let lastEmit = 0;

        for (;;) {
          if (mine !== token || !state.open) return;
          const sliceStart = Date.now();
          let done = false;
          do {
            done = walker.step(SLICE_NODES);
            for (; walker.matched < walker.groups.length; walker.matched += 1) {
              if (matchGroup(walker.groups[walker.matched], pattern, anchor)) {
                truncated = true;
                break;
              }
            }
            if (truncated) break;
          } while (!done && Date.now() - sliceStart < SLICE_MS);

          const now = Date.now();
          if (now - lastEmit > 90) {
            lastEmit = now;
            patch({ total: matches.length, filled: matches.length });
          }
          if (truncated) break;
          if (done && walker.matched >= walker.groups.length) break;
          await nextFrame();
        }

        if (mine !== token || !state.open) return;

        let index = -1;
        if (matches.length) {
          if (jump) {
            if (!current) current = matches[matches.length - 1];
            index = matches.indexOf(current);
          } else {
            index = Math.min(Math.max(state.index, 0), matches.length - 1);
            current = matches[index];
          }
        }
        setCurrent(current ? current.range : null);
        patch({
          total: matches.length,
          filled: matches.length,
          index,
          truncated,
          searching: false,
          phase: '',
        });
        if (index >= 0 && jump && !steppedDuringScan) {
          revealMatch(matches[index].range, 'nearest');
          noteMoved();
        }
      }

      /* ----- public actions ----- */

      function open() {
        const fresh = !state.open;
        if (fresh) {
          const active = document.activeElement;
          focusReturn = active && active !== document.body ? active : null;
          pendingJump = true;
        }
        const scope = findChatRoot();
        if (scope) {
          root = scope;
          sessionKey = rootSessionId(scope);
        }
        if (root) attachObserver(root);
        if (fresh) {
          // Remember the reading position before the first scan can scroll it.
          captureHome();
          patch({
            open: true,
            focusTick: state.focusTick + 1,
            total: 0,
            filled: 0,
            index: -1,
            phase: '',
            searching: false,
            truncated: false,
            noRoot: false,
            historyIncomplete: false,
            canReturn: false,
          });
        } else {
          pendingJump = true;
          patch({ focusTick: state.focusTick + 1 });
        }
        refresh();
      }

      function close() {
        if (!state.open) return;
        token += 1;
        if (queryTimer) {
          clearTimeout(queryTimer);
          queryTimer = null;
        }
        if (rescanTimer) {
          clearTimeout(rescanTimer);
          rescanTimer = null;
        }
        detachObserver();
        clearHighlights();
        matches = [];
        current = null;
        root = null;
        sessionKey = '';
        historyStarted = false;
        home = null;
        patch({
          open: false,
          total: 0,
          filled: 0,
          index: -1,
          phase: '',
          searching: false,
          truncated: false,
          noRoot: false,
          historyIncomplete: false,
          showList: false,
          canReturn: false,
        });

        const previous = focusReturn;
        focusReturn = null;
        const active = document.activeElement;
        const insideUi = uiElement && active && uiElement.contains(active);
        if (previous && previous.isConnected && (insideUi || !active || active === document.body)) {
          try {
            previous.focus({ preventScroll: true });
          } catch (err) {
            /* ignore */
          }
        }
      }

      function setQuery(value) {
        const next = String(value == null ? '' : value);
        if (next === state.query) return;
        pendingJump = true;
        patch({ query: next });
        if (!state.open) return;
        scheduleQuery(140);
      }

      function setIndex(next, mode) {
        if (next < 0 || next >= matches.length) return;
        if (scanning) steppedDuringScan = true;
        current = matches[next];
        patch({ index: next });
        setCurrent(current.range);
        if (mode) {
          revealMatch(current.range, mode);
          noteMoved();
        }
      }

      function step(delta) {
        if (!state.open || !matches.length) return;
        const total = matches.length;
        let base = state.index;
        if (base < 0) base = delta > 0 ? -1 : 0;
        setIndex(((base + delta) % total + total) % total, 'center');
      }

      function jumpTo(index) {
        if (!state.open) return;
        setIndex(index, 'center');
      }

      function entryAt(index) {
        return matches[index] || { text: '', range: null };
      }

      function toggleList() {
        if (!state.open) return;
        patch({ showList: !state.showList });
      }

      function placement() {
        const scope = root && root.isConnected ? root : findChatRoot();
        if (!scope) return { top: 64, right: 24 };
        let rect;
        try {
          rect = scope.getBoundingClientRect();
        } catch (err) {
          return { top: 64, right: 24 };
        }
        const width = window.innerWidth || 1280;
        return {
          top: Math.max(8, Math.round(rect.top + 12)),
          right: Math.max(12, Math.round(width - rect.right + 16)),
        };
      }

      function notify() {
        emit();
      }

      function setUiElement(element) {
        uiElement = element || null;
      }

      function onKeyDown(event) {
        const key = event.key;
        const accelerator = event.ctrlKey || event.metaKey;
        if (accelerator && !event.altKey && !event.shiftKey && (key === 'f' || key === 'F' || event.code === 'KeyF')) {
          if (!state.open && !findChatRoot()) return; // elsewhere: leave the browser alone
          event.preventDefault();
          event.stopPropagation();
          if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
          open();
          return;
        }
        if (key === 'Escape' && state.open && !event.isComposing && event.keyCode !== 229) {
          close();
        }
      }

      function install(context) {
        services = {
          sessions: safeGet(context, 'sessions'),
          locale: safeGet(context, 'locale'),
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => {
          window.removeEventListener('keydown', onKeyDown, true);
          if (state.open) {
            token += 1;
            detachObserver();
            clearHighlights();
            if (queryTimer) clearTimeout(queryTimer);
            if (rescanTimer) clearTimeout(rescanTimer);
            state = Object.assign({}, state, { open: false, total: 0, filled: 0, index: -1, searching: false });
            listeners.clear();
            matches = [];
            current = null;
          }
          services = {};
        };
      }

      return {
        subscribe,
        getState,
        install,
        open,
        close,
        setQuery,
        step,
        jumpTo,
        returnHome,
        entryAt,
        toggleList,
        placement,
        setUiElement,
        notify,
        refresh,
      };
    }

    function safeGet(context, name) {
      if (!context || typeof context.get !== 'function') return null;
      try {
        return context.get(name) || null;
      } catch (err) {
        return null;
      }
    }

    /* ------------------------------------------------------------------ *
     * Icons
     * ------------------------------------------------------------------ */

    function icon(paths) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 16,
          height: 16,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        paths,
      );
    }

    const ICON_SEARCH = icon([h('circle', { key: 'c', cx: 7.2, cy: 7.2, r: 4.6 }), h('path', { key: 'p', d: 'M10.7 10.7 14 14' })]);
    const ICON_PREV = icon([h('path', { key: 'p', d: 'M4 10 8 6l4 4' })]);
    const ICON_NEXT = icon([h('path', { key: 'p', d: 'M4 6l4 4 4-4' })]);
    const ICON_BACK = icon([
      h('path', { key: 'h', d: 'M5.9 4 2.9 7l3 3' }),
      h('path', { key: 'p', d: 'M2.9 7h6.2a3.2 3.2 0 0 1 0 6.4H7.4' }),
    ]);
    const ICON_CLOSE = icon([h('path', { key: 'p', d: 'M4.6 4.6l6.8 6.8M11.4 4.6l-6.8 6.8' })]);

    /* ------------------------------------------------------------------ *
     * React face
     * ------------------------------------------------------------------ */

    const controller = createController();

    function useControllerState() {
      const [snapshot, setSnapshot] = React.useState(controller.getState());
      React.useEffect(() => {
        const unsubscribe = controller.subscribe(() => setSnapshot(controller.getState()));
        // Pick up anything that changed between render and subscription.
        setSnapshot(controller.getState());
        return unsubscribe;
      }, []);
      return snapshot;
    }

    function noteFor(state) {
      if (state.noRoot) return text('noConversation');
      if (state.phase === 'history') return text('loadingHistory');
      if (state.historyIncomplete) return text('historyIncomplete');
      if (state.truncated) return text('truncated', { max: MAX_MATCHES });
      if (!supportsHighlight()) return text('noHighlight');
      return '';
    }

    function countFor(state) {
      if (!state.query.trim()) return '0/0';
      if (!state.total) return state.searching ? '…' : text('none');
      const total = String(state.total) + (state.truncated ? '+' : '');
      // While the scan is still running the count simply climbs; the position
      // is only claimed once everything has been collected.
      if (state.searching || state.index < 0) return total;
      return String(state.index + 1) + '/' + total;
    }

    function snippetParts(entry, query) {
      const value = entry.text || '';
      if (!query) return [{ key: 'plain', text: value }];
      const pattern = new RegExp(escapeRegExp(query), 'gi');
      const parts = [];
      let last = 0;
      let hit = pattern.exec(value);
      let guard = 0;
      while (hit && guard < 8) {
        guard += 1;
        if (hit.index > last) parts.push({ key: 'plain' + last, text: value.slice(last, hit.index) });
        parts.push({ key: 'hit' + hit.index, text: hit[0], hit: true });
        last = hit.index + hit[0].length;
        if (!hit[0].length) pattern.lastIndex += 1;
        hit = pattern.exec(value);
      }
      if (last < value.length) parts.push({ key: 'plain' + last, text: value.slice(last) });
      return parts;
    }

    function FindOverlay() {
      const state = useControllerState();
      const inputRef = React.useRef(null);
      const listRef = React.useRef(null);
      const composingRef = React.useRef(false);
      const [draft, setDraft] = React.useState('');
      const [placement, setPlacement] = React.useState({ top: 64, right: 24 });
      const open = state.open;

      // A callback ref, so the controller always knows the mounted panel and can
      // tell whether focus is still inside it when the panel closes.
      const setPanelNode = React.useCallback((node) => {
        controller.setUiElement(node);
      }, []);

      React.useEffect(() => {
        if (!open) return undefined;
        let frame = 0;
        const update = () => {
          if (frame) return;
          frame = requestAnimationFrame(() => {
            frame = 0;
            setPlacement(controller.placement());
          });
        };
        update();
        const region = document.querySelector(CHAT_REGION);
        let resizeObserver = null;
        if (typeof ResizeObserver === 'function') {
          resizeObserver = new ResizeObserver(update);
          try {
            resizeObserver.observe(document.documentElement);
            if (region) resizeObserver.observe(region);
          } catch (err) {
            /* ignore */
          }
        }
        window.addEventListener('resize', update);
        return () => {
          if (frame) cancelAnimationFrame(frame);
          if (resizeObserver) resizeObserver.disconnect();
          window.removeEventListener('resize', update);
        };
      }, [open]);

      // Seed the visible value and take focus each time the panel is summoned.
      React.useEffect(() => {
        if (!open) return;
        composingRef.current = false;
        setDraft(controller.getState().query);
        const input = inputRef.current;
        if (!input) return;
        try {
          input.focus({ preventScroll: true });
          input.select();
        } catch (err) {
          /* ignore */
        }
      }, [open, state.focusTick]);

      // Keep the active row of the list in view while stepping.
      React.useEffect(() => {
        if (!open || !state.showList) return;
        const node = listRef.current;
        if (!node) return;
        const active = node.querySelector('[data-active="true"]');
        if (active && typeof active.scrollIntoView === 'function') {
          try {
            active.scrollIntoView({ block: 'nearest' });
          } catch (err) {
            /* ignore */
          }
        }
      }, [open, state.showList, state.index]);

      if (!open) return null;

      const note = noteFor(state);
      const disabled = state.total === 0;
      const rows = state.showList ? Math.min(state.total, state.filled, LIST_LIMIT) : 0;

      return h(
        'div',
        {
          className: 'dsf-layer',
          'data-dsh-find-panel': '',
          style: { top: placement.top + 'px', right: placement.right + 'px' },
        },
        h('style', { key: 'style' }, CSS_TEXT),
        h(
          'div',
          {
            key: 'panel',
            ref: setPanelNode,
            className: 'dsf-panel',
            role: 'search',
            'aria-label': text('label'),
          },
          h(
            'div',
            { className: 'dsf-row', key: 'row' },
            h('span', { className: 'dsf-icon', key: 'icon' }, ICON_SEARCH),
            h('input', {
              key: 'input',
              ref: inputRef,
              className: 'dsf-input',
              type: 'text',
              value: draft,
              placeholder: text('placeholder'),
              'aria-label': text('placeholder'),
              autoComplete: 'off',
              spellCheck: false,
              onChange: (event) => {
                const value = event.target.value;
                setDraft(value);
                if (composingRef.current || event.nativeEvent.isComposing) return;
                controller.setQuery(value);
              },
              onCompositionStart: () => {
                composingRef.current = true;
              },
              onCompositionEnd: (event) => {
                composingRef.current = false;
                const value = event.currentTarget.value;
                setDraft(value);
                controller.setQuery(value);
              },
              onKeyDown: (event) => {
                const composing =
                  composingRef.current ||
                  event.nativeEvent.isComposing ||
                  event.keyCode === 229;
                if (event.key === 'Enter' && !composing) {
                  event.preventDefault();
                  controller.step(event.shiftKey ? -1 : 1);
                  return;
                }
                if (event.key === 'Escape' && !composing) {
                  event.preventDefault();
                  event.stopPropagation();
                  controller.close();
                }
              },
            }),
            h(
              'button',
              {
                key: 'count',
                type: 'button',
                className: 'dsf-count',
                title: state.showList ? text('positionsOpen') : text('positions'),
                'aria-label': state.showList ? text('positionsOpen') : text('positions'),
                'aria-expanded': state.showList,
                disabled,
                onClick: () => controller.toggleList(),
              },
              countFor(state),
            ),
            state.canReturn
              ? h(
                  'button',
                  {
                    key: 'home',
                    type: 'button',
                    className: 'dsf-btn',
                    title: text('returnHome'),
                    'aria-label': text('returnHome'),
                    onClick: () => controller.returnHome(),
                  },
                  ICON_BACK,
                )
              : null,
            h(
              'button',
              {
                key: 'prev',
                type: 'button',
                className: 'dsf-btn',
                title: text('prev'),
                'aria-label': text('prev'),
                disabled,
                onClick: () => controller.step(-1),
              },
              ICON_PREV,
            ),
            h(
              'button',
              {
                key: 'next',
                type: 'button',
                className: 'dsf-btn',
                title: text('next'),
                'aria-label': text('next'),
                disabled,
                onClick: () => controller.step(1),
              },
              ICON_NEXT,
            ),
            h(
              'button',
              {
                key: 'close',
                type: 'button',
                className: 'dsf-btn',
                title: text('close'),
                'aria-label': text('close'),
                onClick: () => controller.close(),
              },
              ICON_CLOSE,
            ),
          ),
          note ? h('div', { key: 'note', className: 'dsf-note' }, note) : null,
          rows > 0
            ? h(
                'ul',
                { key: 'list', className: 'dsf-list', ref: listRef, role: 'list' },
                Array.from({ length: rows }, (_, offset) =>
                  h(
                    'li',
                    { key: offset, role: 'listitem' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsf-item',
                        'data-active': state.index === offset ? 'true' : 'false',
                        onClick: () => controller.jumpTo(offset),
                      },
                      h('span', { className: 'dsf-item-index', key: 'i' }, String(offset + 1)),
                      h(
                        'span',
                        { className: 'dsf-item-text', key: 't' },
                        snippetParts(controller.entryAt(offset), state.query).map((part) =>
                          part.hit ? h('mark', { key: part.key }, part.text) : h('span', { key: part.key }, part.text),
                        ),
                      ),
                    ),
                  ),
                ),
              )
            : null,
          rows > 0 && state.filled > rows
            ? h('div', { key: 'listnote', className: 'dsf-note' }, text('listTruncated', { total: state.total, shown: rows }))
            : null,
        ),
      );
    }

    return {
      inject: ['slots', 'sessions', 'locale'],
      apply(ctx) {
        ctx.effect(() => controller.install(ctx));
        ctx.effect(() => {
          let off = null;
          try {
            off = ctx.on('locale/change', () => controller.notify());
          } catch (err) {
            off = null;
          }
          return () => {
            if (typeof off === 'function') off();
          };
        });
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'dsh-chat-search', order: 60 },
            FindOverlay,
          ),
        );
      },
    };
  },
});
