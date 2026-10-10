const UI = (() => {
  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function toast(message, type = 'info', duration = 3500) {
    const root = document.getElementById('toast-root');
    const el = document.createElement('div');
    el.className = `toast toast--${type}`;
    el.textContent = message;
    root.appendChild(el);
    requestAnimationFrame(() => el.classList.add('is-visible'));
    setTimeout(() => {
      el.classList.remove('is-visible');
      setTimeout(() => el.remove(), 250);
    }, duration);
  }

  const ICONS = {
    success: 'M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z',
    error: 'M12 2 1 21h22L12 2zm1 15h-2v-2h2v2zm0-4h-2V9h2v4z',
    info: 'M11 7h2v2h-2V7zm0 4h2v6h-2v-6zm1-9a10 10 0 1 0 0 20 10 10 0 0 0 0-20z'
  };

  function modal({ title, body, actions = [], size = '' }) {
    const root = document.getElementById('modal-root');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal ${size ? 'modal--' + size : ''}" role="dialog" aria-modal="true">
        <div class="modal__head">
          <h3>${escapeHtml(title)}</h3>
          <button class="modal__close" data-close aria-label="Fermer">&times;</button>
        </div>
        <div class="modal__body"></div>
        <div class="modal__actions"></div>
      </div>`;
    const bodyEl = overlay.querySelector('.modal__body');
    if (typeof body === 'string') bodyEl.innerHTML = body;
    else if (body instanceof Node) bodyEl.appendChild(body);

    const actionsEl = overlay.querySelector('.modal__actions');
    actions.forEach((action) => {
      const btn = document.createElement('button');
      btn.className = `btn ${action.className || 'btn--ghost'}`;
      btn.textContent = action.label;
      btn.addEventListener('click', () => action.onClick && action.onClick(overlay, btn));
      actionsEl.appendChild(btn);
    });
    if (!actions.length) actionsEl.remove();

    function close() {
      overlay.classList.remove('is-visible');
      setTimeout(() => overlay.remove(), 200);
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) { if (e.key === 'Escape') close(); }

    overlay.querySelector('[data-close]').addEventListener('click', close);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey);

    root.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('is-visible'));
    return { close, overlay, bodyEl };
  }

  function confirm({ title = 'Confirmation', message, confirmLabel = 'Confirmer', danger = false }) {
    return new Promise((resolve) => {
      modal({
        title,
        body: `<p class="modal__text">${escapeHtml(message)}</p>`,
        actions: [
          { label: 'Annuler', className: 'btn--ghost', onClick: (overlay) => { overlay.remove(); resolve(false); } },
          {
            label: confirmLabel,
            className: danger ? 'btn--danger' : 'btn--primary',
            onClick: (overlay) => { overlay.remove(); resolve(true); }
          }
        ]
      });
    });
  }

  function formatDate(iso, withTime = false) {
    if (!iso) return '-';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '-';
    const date = d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    if (!withTime) return date;
    const time = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    return `${date} a ${time}`;
  }

  function formatDateTimeInput(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function relative(iso) {
    if (!iso) return '';
    const diff = new Date(iso).getTime() - Date.now();
    const days = Math.round(diff / (1000 * 60 * 60 * 24));
    if (days === 0) return "aujourd'hui";
    if (days > 0) return `dans ${days} jour${days > 1 ? 's' : ''}`;
    return `il y a ${Math.abs(days)} jour${Math.abs(days) > 1 ? 's' : ''}`;
  }

  function initials(prenom, nom) {
    return `${(prenom || '').charAt(0)}${(nom || '').charAt(0)}`.toUpperCase() || '?';
  }

  function stars(note) {
    if (!note) return '<span class="muted">Aucun avis</span>';
    const full = Math.round(note);
    let out = '';
    for (let i = 1; i <= 5; i++) out += `<span class="star ${i <= full ? 'on' : ''}">&#9733;</span>`;
    return `<span class="stars" title="${note}/5">${out}</span>`;
  }

  return { escapeHtml, toast, modal, confirm, formatDate, formatDateTimeInput, relative, initials, stars };
})();

window.UI = UI;
