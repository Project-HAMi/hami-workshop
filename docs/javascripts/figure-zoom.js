(function () {
  const overlayClass = 'figure-zoom-overlay';
  const zoomableFlag = 'figureZoomable';

  // Content images served from /images/: lab figures and screenshots.
  // Inline svg icons and the header logo never match, mermaid figures
  // keep their own lightbox.
  const SELECTOR = '.md-typeset img[src*="/images/"]';

  function openOverlay(img) {
    const title = img.getAttribute('alt') || '';

    const overlay = document.createElement('div');
    overlay.className = overlayClass;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', title || 'Enlarged figure');
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

    const clone = img.cloneNode(false);
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
    document.querySelectorAll(SELECTOR).forEach((img) => {
      if (img.dataset[zoomableFlag] === 'true') return;
      if (img.closest('a')) return; // never break a real link

      img.dataset[zoomableFlag] = 'true';
      img.style.cursor = 'zoom-in';
      img.setAttribute('role', 'button');
      img.setAttribute('tabindex', '0');
      img.setAttribute('title', 'Click to enlarge');

      img.addEventListener('click', (event) => {
        event.preventDefault();
        openOverlay(img);
      });

      img.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        openOverlay(img);
      });
    });
  }

  function start() {
    makeZoomable();
    // Material swaps the article on instant navigation; rebind each time.
    if (window.document$) window.document$.subscribe(() => makeZoomable());
  }

  if (document.body) {
    start();
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
}());
