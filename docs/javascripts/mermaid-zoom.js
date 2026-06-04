(function () {
  const overlayClass = 'mermaid-zoom-overlay';
  let initialized = false;
  let started = false;
  let renderSeq = 0;
  let scheduled = false;

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    window.setTimeout(() => {
      scheduled = false;
      renderAndBind();
    }, 100);
  }

  function initializeMermaid() {
    if (initialized || typeof window.mermaid === 'undefined') return false;
    window.mermaid.initialize({
      startOnLoad: false,
      theme: 'default',
      securityLevel: 'loose'
    });
    initialized = true;
    return true;
  }

  async function renderMermaidBlocks() {
    if (!initializeMermaid()) return;

    const blocks = Array.from(document.querySelectorAll('pre.mermaid')).filter(
      block => !block.dataset.mermaidRendered
    );

    for (const block of blocks) {
      block.dataset.mermaidRendered = 'true';

      const codeEl = block.querySelector('code');
      const rawSource = codeEl ? codeEl.textContent : block.textContent;

      // Title is passed via %% title: comment at start of source
      let title = '';
      let source = rawSource;
      const titleMatch = rawSource.match(/^%%\s*title:\s*(.+)\n?/);
      if (titleMatch) {
        title = titleMatch[1].trim();
        source = rawSource.replace(/^%%\s*title:\s*.+\n?/, '');
      }

      try {
        const id = `mermaid-zoom-${Date.now()}-${renderSeq++}`;
        const result = await window.mermaid.render(id, source.trim());
        const svg = typeof result === 'string' ? result : result && result.svg;
        if (!svg) throw new Error('Mermaid render did not return SVG content');

        // Wrap in <figure> with <figcaption>
        const figure = document.createElement('figure');
        figure.className = 'mermaid-figure';

        const wrapper = document.createElement('div');
        wrapper.className = 'mermaid mermaid-zoomable';
        wrapper.innerHTML = svg;
        // Remove inline max-width from SVG so it fills container
        const renderedSvg = wrapper.querySelector('svg');
        if (renderedSvg) renderedSvg.style.maxWidth = 'none';
        if (title) wrapper.dataset.title = title;

        figure.appendChild(wrapper);

        if (title) {
          const caption = document.createElement('figcaption');
          caption.className = 'mermaid-caption';
          caption.textContent = title;
          figure.appendChild(caption);
        }

        block.replaceWith(figure);
      } catch (error) {
        block.dataset.mermaidRendered = 'error';
        console.warn('Failed to render Mermaid diagram:', error);
      }
    }
  }

  function openOverlay(svg) {
    const wrapper = svg.closest('.mermaid-zoomable') || svg.closest('.mermaid');
    const title = wrapper ? wrapper.dataset.title || '' : '';

    const overlay = document.createElement('div');
    overlay.className = overlayClass;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'width:100vw',
      'height:100vh',
      'background:rgba(0,0,0,0.85)',
      'z-index:9999',
      'display:flex',
      'flex-direction:column',
      'align-items:center',
      'justify-content:center',
      'cursor:zoom-out',
      'padding:2rem',
      'box-sizing:border-box',
      'overflow:auto'
    ].join(';');

    const clone = svg.cloneNode(true);
    clone.removeAttribute('width');
    clone.removeAttribute('height');
    clone.style.cssText = [
      'width:auto',
      'height:auto',
      'max-width:95vw',
      'max-height:80vh',
      'cursor:zoom-out',
      'background:#fff',
      'border-radius:4px'
    ].join(';');

    overlay.appendChild(clone);

    if (title) {
      const titleEl = document.createElement('div');
      titleEl.style.cssText = [
        'color:#fff',
        'font-size:1.1em',
        'margin-top:0.75rem',
        'text-align:center',
        'opacity:0.9'
      ].join(';');
      titleEl.textContent = title;
      overlay.appendChild(titleEl);
    }

    function close() {
      overlay.remove();
      document.removeEventListener('keydown', onKeydown);
    }

    function onKeydown(event) {
      if (event.key === 'Escape') close();
    }

    overlay.addEventListener('click', close);
    document.addEventListener('keydown', onKeydown);
    document.body.appendChild(overlay);
  }

  function makeZoomable() {
    document.querySelectorAll('.mermaid-zoomable svg').forEach(svg => {
      const container = svg.closest('.mermaid-zoomable') || svg;
      if (container.dataset.zoomable === 'true') return;
      container.dataset.zoomable = 'true';
      container.style.cursor = 'zoom-in';
      container.setAttribute('role', 'button');
      container.setAttribute('tabindex', '0');
      container.setAttribute('title', 'Click to enlarge');

      container.addEventListener('click', event => {
        event.preventDefault();
        openOverlay(svg);
      });

      container.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        openOverlay(svg);
      });
    });
  }

  async function renderAndBind() {
    await renderMermaidBlocks();
    makeZoomable();
  }

  function start() {
    if (started) return;
    started = true;
    renderAndBind();
    window.setTimeout(renderAndBind, 500);
    window.setTimeout(renderAndBind, 1500);

    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.body) {
    start();
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  if (window.document$) {
    window.document$.subscribe(() => schedule());
  }
}());
