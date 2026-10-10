(function () {
  'use strict';

  const state = {
    user: null,
    settings: {},
    genres: [],
    bookCache: {},
    borrow: { student: null, book: null }
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = UI.escapeHtml;

  let blobModulePromise = null;
  async function uploadToBlob(file, prefix) {
    if (!blobModulePromise) blobModulePromise = import('/js/vendor/blob-client.js');
    let mod;
    try {
      mod = await blobModulePromise;
    } catch (e) {
      throw new Error("Module d'upload indisponible (verifiez /js/vendor/blob-client.js).");
    }
    const safe = (file.name || 'fichier').replace(/[^\w.\-]+/g, '_');
    const pathname = `${prefix}/${Date.now()}-${safe}`;
    const result = await mod.uploadPresigned(pathname, file, {
      access: 'public',
      handleUploadUrl: '/api/blob/upload'
    });
    return result.url;
  }

  function isStaff() {
    return state.user && ['documentaliste', 'principal', 'principal_adjoint'].includes(state.user.role);
  }
  function canManage() {
    return state.user && ['documentaliste', 'principal'].includes(state.user.role);
  }

  /* ------------------------------------------------------------------ boot */

  async function boot() {
    try {
      const me = await API.get('/api/auth/me', { skipAuthRedirect: true });
      state.user = me.user;
    } catch (err) {
      location.href = '/';
      return;
    }

    if (state.user.mustChangePassword) {
      UI.toast('Pensez a changer votre mot de passe (compte par defaut).', 'info', 6000);
    }

    try {
      const s = await API.get('/api/settings', { skipAuthRedirect: true });
      state.settings = s;
      $('#brand-school').textContent = s.etablissement || 'College Saint-Exupery';
      document.title = `CDI en ligne - ${s.etablissement || 'College Saint-Exupery'}`;
    } catch (e) { /* ignore */ }

    renderNav();
    renderUserChip();

    if (!location.hash) location.hash = isStaff() ? '#/tableau-de-bord' : '#/catalogue';
    window.addEventListener('hashchange', router);
    router();
  }

  /* --------------------------------------------------------------- topbar */

  function navItems() {
    if (isStaff()) {
      const items = [
        { route: '#/tableau-de-bord', label: 'Tableau de bord' },
        { route: '#/catalogue', label: 'Catalogue' },
        { route: '#/emprunter', label: 'Emprunter' },
        { route: '#/emprunts', label: 'Emprunts' },
        { route: '#/ajouter', label: 'Ajouter un livre' },
        { route: '#/gestion', label: 'Gestion' }
      ];
      return items;
    }
    return [
      { route: '#/catalogue', label: 'Catalogue' },
      { route: '#/emprunts', label: 'Mes emprunts' },
      { route: '#/favoris', label: 'Mes favoris' }
    ];
  }

  function renderNav() {
    const nav = $('#main-nav');
    nav.innerHTML = navItems()
      .map((it) => `<a href="${it.route}" data-nav="${it.route}">${esc(it.label)}</a>`)
      .join('');
  }

  function renderUserChip() {
    $('#user-avatar').textContent = UI.initials(state.user.prenom, state.user.nom);
    $('#user-name').textContent = `${state.user.prenom} ${state.user.nom}`;
    const labels = {
      eleve: state.user.classe ? `Eleve - ${state.user.classe}` : 'Eleve',
      documentaliste: 'Prof. documentaliste',
      principal: 'Principal',
      principal_adjoint: 'Principal adjoint'
    };
    $('#user-role').textContent = labels[state.user.role] || state.user.role;
  }

  function setActiveNav(hash) {
    $$('#main-nav a').forEach((a) => a.classList.toggle('is-active', hash.startsWith(a.getAttribute('href'))));
  }

  /* --------------------------------------------------------------- router */

  const routes = {
    'catalogue': renderCatalogue,
    'livre': renderBookDetail,
    'lire': renderReader,
    'emprunts': renderLoans,
    'favoris': renderFavorites,
    'compte': renderAccount,
    'tableau-de-bord': renderDashboard,
    'emprunter': renderBorrow,
    'ajouter': renderBookForm,
    'modifier': renderBookForm,
    'gestion': renderManage
  };

  async function router() {
    const raw = location.hash.replace(/^#\/?/, '') || 'catalogue';
    const [name, ...rest] = raw.split('/');
    const view = routes[name] || renderCatalogue;
    setActiveNav('#/' + name);
    $('#main-nav').classList.remove('is-open');
    try {
      await view(rest);
    } catch (err) {
      console.error(err);
      $('#view').innerHTML = `<div class="empty"><h3>Oups</h3><p>${esc(err.message)}</p></div>`;
    }
    window.scrollTo(0, 0);
  }

  function setView(html) {
    $('#view').innerHTML = html;
  }

  function bannerMustChange() {
    if (!state.user.mustChangePassword) return '';
    return `<div class="notice notice--warn">
      <strong>Mot de passe par defaut.</strong>
      Pour proteger votre compte, changez votre mot de passe dans <a href="#/compte">Mon compte</a>.
    </div>`;
  }

  /* ------------------------------------------------------------ catalogue */

  let searchTimer = null;

  function bookCard(b) {
    const cover = b.coverUrl
      ? `<img src="${esc(b.coverUrl)}" alt="Couverture de ${esc(b.titre)}" loading="lazy">`
      : `<div class="cover-fallback">${esc(UI.initials('', b.titre))}</div>`;
    const badge = b.disponible
      ? '<span class="badge badge--ok">Disponible</span>'
      : '<span class="badge badge--busy">Emprunte</span>';
    const tome = b.tome ? ` <span class="muted">t.${esc(b.tome)}</span>` : '';
    return `<article class="book-card" data-id="${b.id}">
      <button type="button" class="book-card__cover" data-action="read" data-id="${b.id}" title="Lire : ${esc(b.titre)}">
        ${cover}
        ${badge}
        <span class="book-card__read">Lire</span>
      </button>
      <div class="book-card__body">
        <h4 data-action="open-book" data-id="${b.id}">${esc(b.titre)}${tome}</h4>
        <p class="book-card__author">${esc(b.auteur)}</p>
        <div class="book-card__meta">
          <span class="chip">${esc(b.code)}</span>
          ${UI.stars(b.note)}
        </div>
      </div>
    </article>`;
  }

  async function renderCatalogue() {
    const staffBtn = isStaff() ? '<a class="btn btn--primary" href="#/ajouter">+ Ajouter un livre</a>' : '';
    setView(`
      ${bannerMustChange()}
      <div class="page-head">
        <div>
          <h1>Catalogue du CDI</h1>
          <p class="muted">Cliquez sur une couverture pour lire le livre en PDF.</p>
        </div>
        ${staffBtn}
      </div>
      <div class="toolbar">
        <input type="search" id="cat-q" class="input" placeholder="Rechercher un titre, un auteur, un code...">
        <select id="cat-genre" class="input"><option value="">Tous les genres</option></select>
        <select id="cat-dispo" class="input">
          <option value="">Tous</option>
          <option value="disponible">Disponibles</option>
          <option value="emprunte">Empruntes</option>
        </select>
        <select id="cat-sort" class="input">
          <option value="recent">Plus recents</option>
          <option value="titre">Titre (A-Z)</option>
          <option value="auteur">Auteur (A-Z)</option>
          <option value="note">Mieux notes</option>
          <option value="ancien">Plus anciens</option>
        </select>
      </div>
      <div id="cat-count" class="muted small"></div>
      <div id="cat-grid" class="book-grid"></div>
    `);

    try {
      const g = await API.get('/api/books/genres');
      state.genres = g.genres;
      const sel = $('#cat-genre');
      g.genres.forEach((genre) => {
        const opt = document.createElement('option');
        opt.value = genre; opt.textContent = genre;
        sel.appendChild(opt);
      });
    } catch (e) { /* ignore */ }

    const reload = () => loadBooks();
    $('#cat-q').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(reload, 300); });
    $('#cat-q').addEventListener('search', reload);
    $('#cat-genre').addEventListener('change', reload);
    $('#cat-dispo').addEventListener('change', reload);
    $('#cat-sort').addEventListener('change', reload);

    await loadBooks();
  }

  async function loadBooks() {
    const grid = $('#cat-grid');
    if (!grid) return;
    grid.innerHTML = '<div class="loader"><span class="spinner"></span> Chargement...</div>';
    const params = new URLSearchParams();
    const q = $('#cat-q').value.trim();
    if (q) params.set('q', q);
    const genre = $('#cat-genre').value;
    if (genre) params.set('genre', genre);
    const dispo = $('#cat-dispo').value;
    if (dispo) params.set('dispo', dispo);
    params.set('sort', $('#cat-sort').value);

    try {
      const data = await API.get('/api/books?' + params.toString());
      $('#cat-count').textContent = `${data.total} livre${data.total > 1 ? 's' : ''}`;
      if (!data.books.length) {
        grid.innerHTML = '<div class="empty"><h3>Aucun livre</h3><p>Aucun ouvrage ne correspond a votre recherche.</p></div>';
        return;
      }
      grid.innerHTML = data.books.map(bookCard).join('');
    } catch (err) {
      grid.innerHTML = `<div class="empty"><p>${esc(err.message)}</p></div>`;
    }
  }

  /* --------------------------------------------------------- book detail */

  async function getBook(id) {
    const data = await API.get('/api/books/' + id);
    state.bookCache[id] = data.book;
    return data.book;
  }

  async function renderBookDetail([id]) {
    setView('<div class="loader"><span class="spinner"></span> Chargement...</div>');
    const b = await getBook(id);
    const tome = b.tome ? ` - Tome ${esc(b.tome)}` : '';
    const dispo = b.disponible
      ? '<span class="badge badge--ok">Disponible</span>'
      : '<span class="badge badge--busy">Emprunte</span>';

    const staffActions = isStaff()
      ? `<a class="btn btn--ghost" href="#/modifier/${b.id}">Modifier</a>
         <button class="btn btn--danger" data-action="delete-book" data-id="${b.id}">Supprimer</button>`
      : '';

    const studentActions = !isStaff()
      ? `<button class="btn btn--primary" data-action="request-loan" data-id="${b.id}">Demander l'emprunt au CDI</button>
         <button class="btn btn--ghost" data-action="toggle-favorite" data-id="${b.id}">Ajouter aux favoris</button>`
      : '';

    const loanInfo = b.emprunt
      ? `<p class="muted small">Emprunte par ${esc(b.emprunt.eleve)}${b.emprunt.classe ? ' (' + esc(b.emprunt.classe) + ')' : ''} - retour prevu le ${UI.formatDate(b.emprunt.dateRetourPrevue)}${b.emprunt.enRetard ? ' <span class="text-danger">(en retard)</span>' : ''}</p>`
      : '';

    const reviewsHtml = b.reviews.length
      ? b.reviews.map((r) => `<div class="review">
          <div class="review__head"><strong>${esc(r.auteur)}</strong><span class="review__stars">${UI.stars(r.rating)}</span><span class="muted small">${UI.formatDate(r.at)}</span></div>
          ${r.text ? `<p>${esc(r.text)}</p>` : ''}
        </div>`).join('')
      : '<p class="muted">Aucun avis pour le moment.</p>';

    const reviewForm = !isStaff()
      ? `<form data-form="review" data-id="${b.id}" class="review-form">
          <h4>Laisser un avis</h4>
          <div class="rating-input" data-rating="5">
            ${[1,2,3,4,5].map((n) => `<button type="button" class="star-btn" data-action="set-rating" data-value="${n}">&#9733;</button>`).join('')}
          </div>
          <input type="hidden" name="rating" value="5">
          <textarea name="text" class="input" rows="3" placeholder="Votre avis (optionnel)"></textarea>
          <button class="btn btn--primary" type="submit">Publier mon avis</button>
        </form>`
      : '';

    setView(`
      <a class="back-link" href="#/catalogue">&larr; Retour au catalogue</a>
      ${bannerMustChange()}
      <div class="book-detail">
        <div class="book-detail__cover">
          <button type="button" class="book-detail__cover-btn" data-action="read" data-id="${b.id}" title="Lire le livre">
            ${b.coverUrl ? `<img src="${esc(b.coverUrl)}" alt="Couverture">` : '<div class="cover-fallback large"></div>'}
            <span class="book-card__read">Lire maintenant</span>
          </button>
        </div>
        <div class="book-detail__info">
          <div class="book-detail__title-row">
            <h1>${esc(b.titre)}${tome}</h1>
            ${dispo}
          </div>
          <p class="book-detail__author">par ${esc(b.auteur)}</p>
          <div class="book-detail__meta">
            <span class="chip">Code ${esc(b.code)}</span>
            ${b.genre ? `<span class="chip">${esc(b.genre)}</span>` : ''}
            <span class="chip">Mise en ligne : ${UI.formatDate(b.dateMiseEnLigne)}</span>
            ${UI.stars(b.note)}
          </div>
          ${loanInfo}
          ${b.description ? `<p class="book-detail__desc">${esc(b.description)}</p>` : ''}
          <div class="book-detail__actions">
            <a class="btn btn--primary" href="#/lire/${b.id}">Lire le PDF</a>
            ${studentActions}
            ${staffActions}
          </div>
        </div>
      </div>
      <section class="panel">
        <h3>Avis des eleves (${b.nbAvis})</h3>
        ${reviewsHtml}
        ${reviewForm}
      </section>
    `);

    if (!isStaff()) {
      const ratingInput = $('.rating-input');
      if (ratingInput) {
        const saved = 5;
        setRating(ratingInput, saved);
      }
      refreshFavoriteButton(b.id);
    }
  }

  function setRating(container, value) {
    container.dataset.rating = value;
    container.parentElement.querySelector('input[name="rating"]').value = value;
    $$('.star-btn', container).forEach((btn) => {
      btn.classList.toggle('on', Number(btn.dataset.value) <= value);
    });
  }

  async function refreshFavoriteButton(bookId) {
    try {
      const favs = await API.get('/api/favorites');
      const isFav = favs.books.some((x) => x.id === Number(bookId));
      const btn = $('[data-action="toggle-favorite"]');
      if (btn) btn.textContent = isFav ? 'Retirer des favoris' : 'Ajouter aux favoris';
    } catch (e) { /* ignore */ }
  }

  /* --------------------------------------------------------------- reader */

  async function renderReader([id]) {
    setView('<div class="loader"><span class="spinner"></span> Ouverture du livre...</div>');
    const b = await getBook(id);
    setView(`
      <div class="reader-head">
        <a class="back-link" href="#/livre/${b.id}">&larr; Fiche du livre</a>
        <div class="reader-head__title"><strong>${esc(b.titre)}</strong><span class="muted"> ${esc(b.auteur)}</span></div>
        <div class="reader-head__actions">
          <a class="btn btn--ghost" href="${esc(b.pdfUrl)}" target="_blank" rel="noopener">Ouvrir dans un onglet</a>
          <a class="btn btn--ghost" href="${esc(b.pdfUrl)}" download>Télécharger</a>
        </div>
      </div>
      <div class="reader">
        <iframe src="${esc(b.pdfUrl)}#toolbar=1&view=FitH" title="Lecture de ${esc(b.titre)}"></iframe>
      </div>
    `);
  }

  /* ------------------------------------------------------ student loans */

  async function renderLoans() {
    if (isStaff()) return renderStaffLoans();
    setView(`
      ${bannerMustChange()}
      <div class="page-head"><h1>Mes emprunts</h1></div>
      <div id="loans-active" class="panel"></div>
      <div id="loans-demandes" class="panel"></div>
      <div class="panel"><h3>Historique</h3><div id="loans-history"></div></div>
    `);
    try {
      const [loansData, resData] = await Promise.all([
        API.get('/api/loans'),
        API.get('/api/reservations')
      ]);
      const active = loansData.loans.filter((l) => l.status === 'en_cours');
      const history = loansData.loans.filter((l) => l.status !== 'en_cours');

      $('#loans-active').innerHTML = `<h3>En cours (${active.length})</h3>` +
        (active.length ? active.map((l) => loanRow(l, false)).join('') : '<p class="muted">Aucun emprunt en cours.</p>');

      $('#loans-demandes').innerHTML = `<h3>Mes demandes (${resData.total})</h3>` +
        (resData.total ? resData.reservations.map((r) => `
          <div class="list-row">
            <div class="list-row__main"><strong>${esc(r.titre)}</strong><span class="muted small">Code ${esc(r.code)} - demande du ${UI.formatDate(r.at)}</span></div>
            <button class="btn btn--ghost btn--sm" data-action="cancel-reservation" data-id="${r.id}">Annuler</button>
          </div>`).join('') : '<p class="muted">Aucune demande en cours.</p>');

      $('#loans-history').innerHTML = history.length
        ? history.map((l) => loanRow(l, true)).join('')
        : '<p class="muted">Aucun emprunt rendu.</p>';
    } catch (err) {
      $('#loans-active').innerHTML = `<p>${esc(err.message)}</p>`;
    }
  }

  function loanRow(l, history) {
    const late = l.enRetard ? '<span class="badge badge--late">En retard</span>' : '';
    const status = history
      ? `<span class="muted small">Rendu le ${UI.formatDate(l.dateRetour)}</span>`
      : `<span class="muted small">Retour prevu le ${UI.formatDate(l.dateRetourPrevue)} (${UI.relative(l.dateRetourPrevue)})</span> ${late}`;
    return `<div class="list-row">
      <div class="list-row__cover">${l.coverUrl ? `<img src="${esc(l.coverUrl)}" alt="">` : ''}</div>
      <div class="list-row__main">
        <strong>${esc(l.titre)}</strong>
        <span class="muted small">${esc(l.auteur || '')} - Code ${esc(l.code || '-')}</span>
        ${status}
      </div>
      <div class="list-row__actions">
        <a class="btn btn--ghost btn--sm" href="#/livre/${l.bookId}">Voir</a>
      </div>
    </div>`;
  }

  async function renderFavorites() {
    setView(`
      ${bannerMustChange()}
      <div class="page-head"><h1>Mes favoris</h1></div>
      <div id="fav-grid" class="book-grid"></div>
    `);
    try {
      const data = await API.get('/api/favorites');
      const grid = $('#fav-grid');
      if (!data.books.length) {
        grid.innerHTML = '<div class="empty"><h3>Aucun favori</h3><p>Ajoutez des livres a vos favoris depuis leur fiche.</p></div>';
        return;
      }
      grid.innerHTML = data.books.map(bookCard).join('');
    } catch (err) {
      $('#fav-grid').innerHTML = `<p>${esc(err.message)}</p>`;
    }
  }

  /* ------------------------------------------------------------- account */

  function renderAccount() {
    const u = state.user;
    const roleLabels = {
      eleve: u.classe ? `Eleve - ${esc(u.classe)}` : 'Eleve',
      documentaliste: 'Professeur documentaliste',
      principal: 'Principal (chef d\'etablissement)',
      principal_adjoint: 'Principal adjoint'
    };
    setView(`
      ${bannerMustChange()}
      <div class="page-head"><h1>Mon compte</h1></div>
      <div class="two-col">
        <div class="panel">
          <h3>Informations</h3>
          <dl class="kv">
            <dt>Nom</dt><dd>${esc(u.prenom)} ${esc(u.nom)}</dd>
            <dt>Identifiant</dt><dd>${esc(u.login)}</dd>
            <dt>Role</dt><dd>${roleLabels[u.role] || esc(u.role)}</dd>
            ${u.classe ? `<dt>Classe</dt><dd>${esc(u.classe)}</dd>` : ''}
          </dl>
        </div>
        <div class="panel">
          <h3>Changer mon mot de passe</h3>
          <form data-form="password">
            <label class="field"><span>Mot de passe actuel</span><input type="password" name="currentPassword" required></label>
            <label class="field"><span>Nouveau mot de passe (6 caracteres min.)</span><input type="password" name="newPassword" required minlength="6"></label>
            <label class="field"><span>Confirmer le nouveau mot de passe</span><input type="password" name="confirmPassword" required minlength="6"></label>
            <button class="btn btn--primary" type="submit">Mettre a jour</button>
          </form>
        </div>
      </div>
    `);
  }

  /* ----------------------------------------------------------- dashboard */

  async function renderDashboard() {
    setView('<div class="loader"><span class="spinner"></span> Chargement...</div>');
    const s = await API.get('/api/stats');
    const stat = (label, value, cls) => `<div class="stat ${cls || ''}"><span class="stat__value">${value}</span><span class="stat__label">${esc(label)}</span></div>`;
    const top = s.topBooks.length
      ? s.topBooks.map((b, i) => `<div class="list-row"><span class="rank">${i + 1}</span><div class="list-row__main"><strong>${esc(b.titre)}</strong><span class="muted small">Code ${esc(b.code || '-')}</span></div><span class="chip">${b.emprunts} emprunt${b.emprunts > 1 ? 's' : ''}</span></div>`).join('')
      : '<p class="muted">Aucun emprunt enregistre.</p>';
    const recent = s.recentLoans.length
      ? s.recentLoans.map((l) => `<div class="list-row"><div class="list-row__main"><strong>${esc(l.titre)}</strong><span class="muted small">${esc(l.eleve)}${l.classe ? ' (' + esc(l.classe) + ')' : ''} - ${UI.formatDate(l.dateEmprunt)}</span></div>${l.enRetard ? '<span class="badge badge--late">En retard</span>' : ''}</div>`).join('')
      : '<p class="muted">Aucun emprunt.</p>';

    setView(`
      ${bannerMustChange()}
      <div class="page-head">
        <div><h1>Tableau de bord</h1><p class="muted">Vue d'ensemble du CDI${state.settings.anneeScolaire ? ' - ' + esc(state.settings.anneeScolaire) : ''}.</p></div>
        <div class="page-head__actions">
          <a class="btn btn--primary" href="#/ajouter">+ Ajouter un livre</a>
          <a class="btn btn--ghost" href="#/emprunter">Emprunter un livre</a>
        </div>
      </div>
      <div class="stats-grid">
        ${stat('Livres au catalogue', s.books)}
        ${stat('Eleves inscrits', s.students)}
        ${stat('Emprunts en cours', s.activeLoans)}
        ${stat('En retard', s.overdue, s.overdue ? 'stat--danger' : '')}
        ${stat('Demandes en attente', s.reservations)}
        ${stat('Emprunts au total', s.loansTotal)}
      </div>
      <div class="two-col">
        <div class="panel"><h3>Livres les plus empruntes</h3>${top}</div>
        <div class="panel"><h3>Derniers emprunts</h3>${recent}</div>
      </div>
    `);
  }

  /* ------------------------------------------------------- staff: books */

  async function renderStaffLoans() {
    setView(`
      ${bannerMustChange()}
      <div class="page-head"><h1>Emprunts</h1>
        <div class="page-head__actions"><a class="btn btn--primary" href="#/emprunter">+ Nouvel emprunt</a></div>
      </div>
      <div class="toolbar">
        <input type="search" id="loans-q" class="input" placeholder="Rechercher un eleve, un titre...">
        <select id="loans-status" class="input">
          <option value="en_cours">En cours</option>
          <option value="rendu">Rendus</option>
          <option value="">Tous</option>
        </select>
      </div>
      <div id="staff-loans"></div>
    `);
    $('#loans-q').addEventListener('input', loadStaffLoans);
    $('#loans-status').addEventListener('change', loadStaffLoans);
    await loadStaffLoans();
  }

  async function loadStaffLoans() {
    const box = $('#staff-loans');
    box.innerHTML = '<div class="loader"><span class="spinner"></span> Chargement...</div>';
    const status = $('#loans-status').value;
    const q = $('#loans-q').value.trim().toLowerCase();
    try {
      const data = await API.get('/api/loans' + (status ? '?status=' + status : ''));
      let loans = data.loans;
      if (q) {
        loans = loans.filter((l) => [l.titre, l.eleve, l.classe, l.code].filter(Boolean).some((v) => String(v).toLowerCase().includes(q)));
      }
      if (!loans.length) { box.innerHTML = '<div class="empty"><p>Aucun emprunt.</p></div>'; return; }
      box.innerHTML = loans.map((l) => `
        <div class="list-row">
          <div class="list-row__cover">${l.coverUrl ? `<img src="${esc(l.coverUrl)}" alt="">` : ''}</div>
          <div class="list-row__main">
            <strong>${esc(l.titre)}</strong>
            <span class="muted small">${esc(l.eleve)}${l.classe ? ' (' + esc(l.classe) + ')' : ''} - Code ${esc(l.code || '-')}</span>
            <span class="muted small">
              ${l.status === 'en_cours'
                ? `Emprunte le ${UI.formatDate(l.dateEmprunt)} - retour prevu le ${UI.formatDate(l.dateRetourPrevue)} (${UI.relative(l.dateRetourPrevue)})`
                : `Rendu le ${UI.formatDate(l.dateRetour)}`}
              ${l.enRetard ? ' <span class="badge badge--late">En retard</span>' : ''}
            </span>
          </div>
          <div class="list-row__actions">
            ${l.status === 'en_cours' ? `
              <button class="btn btn--primary btn--sm" data-action="return-loan" data-id="${l.id}">Retour</button>
              <button class="btn btn--ghost btn--sm" data-action="renew-loan" data-id="${l.id}">Prolonger</button>` : ''}
            <a class="btn btn--ghost btn--sm" href="#/livre/${l.bookId}">Fiche</a>
          </div>
        </div>`).join('');
    } catch (err) {
      box.innerHTML = `<p>${esc(err.message)}</p>`;
    }
  }

  function renderBookForm([editId]) {
    const editing = !!editId;
    setView(`
      ${bannerMustChange()}
      <div class="page-head"><h1>${editing ? 'Modifier un livre' : 'Ajouter un livre'}</h1></div>
      <form data-form="book" data-id="${editId || ''}" class="panel form-grid">
        <label class="field"><span>Code du livre * <small class="muted">(pour le retrouver a l'emprunt)</small></span>
          <input name="code" required placeholder="ex : ROM-0042"></label>
        <label class="field"><span>Titre *</span><input name="titre" required placeholder="Titre du livre"></label>
        <label class="field"><span>Auteur *</span><input name="auteur" required placeholder="Nom de l'auteur"></label>
        <div class="form-row">
          <label class="field"><span>Tome <small class="muted">(optionnel)</small></span><input name="tome" placeholder="ex : 2"></label>
          <label class="field"><span>Genre <small class="muted">(optionnel)</small></span>
            <input name="genre" list="genre-list" placeholder="ex : Roman, BD, Manga...">
            <datalist id="genre-list">${state.genres.map((g) => `<option value="${esc(g)}"></option>`).join('')}</datalist>
          </label>
        </div>
        <label class="field"><span>Resume <small class="muted">(optionnel)</small></span>
          <textarea name="description" class="input" rows="3" placeholder="Petit resume..."></textarea></label>

        <div class="field">
          <span>Date de mise en ligne *</span>
          <label class="checkline"><input type="checkbox" name="now" id="field-now" ${editing ? '' : 'checked'}> Tout de suite (maintenant)</label>
          <input type="datetime-local" name="dateMiseEnLigne" id="field-date" ${editing ? '' : 'disabled'}>
        </div>

        <label class="field dropzone"><span>Couverture * <small class="muted">(png, jpg, jpeg, webp...)</small></span>
          <input type="file" name="cover" accept="image/*" ${editing ? '' : 'required'}>
          <div class="dropzone__preview" id="cover-preview"></div>
        </label>

        <label class="field dropzone"><span>Fichier PDF du livre *</span>
          <input type="file" name="pdf" accept="application/pdf" ${editing ? '' : 'required'}>
          <div class="dropzone__preview" id="pdf-preview"></div>
        </label>

        <div class="form-actions">
          <a class="btn btn--ghost" href="#/catalogue">Annuler</a>
          <button class="btn btn--primary" type="submit">${editing ? 'Enregistrer les modifications' : 'Ajouter le livre'}</button>
        </div>
      </form>
    `);

    const nowCheck = $('#field-now');
    const dateInput = $('#field-date');
    if (nowCheck && dateInput) {
      nowCheck.addEventListener('change', () => {
        dateInput.disabled = nowCheck.checked;
        if (nowCheck.checked) dateInput.value = '';
      });
    }
    const cover = $('input[name="cover"]');
    cover.addEventListener('change', () => previewImage(cover, '#cover-preview'));
    const pdf = $('input[name="pdf"]');
    pdf.addEventListener('change', () => {
      const f = pdf.files[0];
      $('#pdf-preview').textContent = f ? f.name + ' (' + Math.round(f.size / 1024) + ' Ko)' : '';
    });

    if (editing) fillBookForm(editId);
  }

  function previewImage(input, target) {
    const file = input.files[0];
    const box = $(target);
    if (!file) { box.innerHTML = ''; return; }
    const url = URL.createObjectURL(file);
    box.innerHTML = `<img src="${url}" alt="Apercu">`;
  }

  async function fillBookForm(id) {
    const b = await getBook(id);
    const f = $('form[data-form="book"]');
    f.code.value = b.code;
    f.titre.value = b.titre;
    f.auteur.value = b.auteur;
    f.tome.value = b.tome || '';
    f.genre.value = b.genre || '';
    f.description.value = b.description || '';
    const nowCheck = $('#field-now');
    const dateInput = $('#field-date');
    nowCheck.checked = false;
    dateInput.disabled = false;
    dateInput.value = UI.formatDateTimeInput(b.dateMiseEnLigne);
    if (b.coverUrl) $('#cover-preview').innerHTML = `<img src="${esc(b.coverUrl)}" alt="Couverture actuelle">`;
    $('#pdf-preview').textContent = 'Fichier actuel conserve si aucun nouveau PDF.';
  }

  /* ------------------------------------------------------- staff: borrow */

  function renderBorrow() {
    state.borrow = { student: null, book: null };
    setView(`
      ${bannerMustChange()}
      <div class="page-head"><h1>Emprunter un livre</h1>
        <p class="muted">Recherchez l'eleve, puis saisissez le code du livre.</p>
      </div>
      <div class="borrow">
        <section class="panel borrow__step" id="step-student">
          <div class="borrow__badge">1</div>
          <h3>Eleve</h3>
          <p class="muted small">Tapez le nom de famille, puis Entree pour rechercher.</p>
          <input type="search" id="student-search" class="input" placeholder="Nom de famille de l'eleve...">
          <div id="student-results" class="student-results"></div>
          <div id="student-selected" class="selected-box" hidden></div>
        </section>
        <section class="panel borrow__step is-disabled" id="step-book">
          <div class="borrow__badge">2</div>
          <h3>Livre</h3>
          <p class="muted small">Saisissez le code du livre et validez.</p>
          <form data-form="borrow-code" class="inline-form">
            <input name="bookCode" id="book-code" class="input" placeholder="Code du livre (ex : ROM-0042)" disabled>
            <button class="btn btn--primary" type="submit" disabled id="book-code-btn">Verifier</button>
          </form>
          <div id="book-check"></div>
        </section>
      </div>
    `);

    const search = $('#student-search');
    let t = null;
    search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(searchStudents, 250); });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); clearTimeout(t); searchStudents(); }
    });
    $('#step-book').classList.add('is-disabled');
    $('#book-code').disabled = true;
    $('#book-code-btn').disabled = true;
  }

  let studentTimer = null;

  async function searchStudents() {
    const q = $('#student-search').value.trim();
    const box = $('#student-results');
    box.innerHTML = '<div class="loader small"><span class="spinner"></span> Recherche...</div>';
    try {
      const data = await API.get('/api/loans/students/search?q=' + encodeURIComponent(q));
      if (!data.students.length) {
        box.innerHTML = '<p class="muted small">Aucun eleve trouve.</p>';
        return;
      }
      box.innerHTML = data.students.map((s) => `
        <button type="button" class="student-item" data-action="select-student" data-id="${s.id}">
          <span class="avatar">${esc(UI.initials(s.prenom, s.nom))}</span>
          <span class="student-item__main"><strong>${esc(s.nom)} ${esc(s.prenom)}</strong>
            <span class="muted small">${esc(s.classe || '')} - ${esc(s.login)}</span></span>
          <span class="chip">${s.empruntsEnCours} en cours</span>
        </button>`).join('');
    } catch (err) {
      box.innerHTML = `<p class="text-danger">${esc(err.message)}</p>`;
    }
  }

  function selectStudent(id) {
    const item = $(`[data-action="select-student"][data-id="${id}"]`);
    const data = {
      id: Number(id),
      label: item.querySelector('strong').textContent,
      sub: item.querySelector('small').textContent
    };
    state.borrow.student = data;
    const box = $('#student-selected');
    box.hidden = false;
    box.innerHTML = `<span class="selected-box__label">Eleve selectionne :</span> <strong>${esc(data.label)}</strong> <span class="muted small">${esc(data.sub)}</span>
      <button class="btn btn--ghost btn--sm" data-action="clear-student">Changer</button>`;
    const stepBook = $('#step-book');
    stepBook.classList.remove('is-disabled');
    const codeInput = $('#book-code');
    codeInput.disabled = false;
    $('#book-code-btn').disabled = false;
    codeInput.focus();
  }

  async function validateBookCode(code) {
    const box = $('#book-check');
    box.innerHTML = '<div class="loader small"><span class="spinner"></span> Verification...</div>';
    try {
      const data = await API.get('/api/books?q=' + encodeURIComponent(code));
      const book = data.books.find((b) => b.code.toUpperCase() === code.toUpperCase());
      if (!book) { box.innerHTML = `<p class="text-danger">Aucun livre ne porte le code ${esc(code)}.</p>`; return; }
      if (!book.disponible) {
        box.innerHTML = `<p class="text-danger">Le livre <strong>${esc(book.titre)}</strong> est deja emprunte (retour prevu le ${UI.formatDate(book.emprunt.dateRetourPrevue)}).</p>`;
        return;
      }
      confirmBorrow(book);
    } catch (err) {
      box.innerHTML = `<p class="text-danger">${esc(err.message)}</p>`;
    }
  }

  function confirmBorrow(book) {
    const student = state.borrow.student;
    if (!student) return;
    const body = `
      <p class="modal__text">Confirmez l'ajout de ce livre au compte CDI de l'eleve :</p>
      <div class="confirm-borrow">
        <div class="confirm-borrow__book">
          ${book.coverUrl ? `<img src="${esc(book.coverUrl)}" alt="">` : ''}
          <div><strong>${esc(book.titre)}</strong><span class="muted small">${esc(book.auteur)} - Code ${esc(book.code)}</span></div>
        </div>
        <div class="confirm-borrow__arrow">&rarr;</div>
        <div class="confirm-borrow__student">
          <span class="avatar">${esc(UI.initials('', student.label))}</span>
          <div><strong>${esc(student.label)}</strong><span class="muted small">${esc(student.sub)}</span></div>
        </div>
      </div>
      <p class="muted small">Retour prevu dans ${state.settings.loanDays || 14} jours.</p>`;

    UI.modal({
      title: 'Confirmer l\'emprunt',
      body,
      actions: [
        { label: 'Annuler', className: 'btn--ghost', onClick: (o) => o.remove() },
        {
          label: 'Confirmer l\'ajout',
          className: 'btn--primary',
          onClick: async (o, btn) => {
            btn.disabled = true;
            btn.textContent = 'Enregistrement...';
            try {
              await API.post('/api/loans', { userId: student.id, bookCode: book.code });
              o.remove();
              UI.toast(`Livre "${book.titre}" ajoute au compte de ${student.label}.`, 'success');
              resetBorrow();
            } catch (err) {
              UI.toast(err.message, 'error');
              btn.disabled = false;
              btn.textContent = 'Confirmer l\'ajout';
            }
          }
        }
      ]
    });
  }

  function resetBorrow() {
    state.borrow = { student: null, book: null };
    $('#student-search').value = '';
    $('#student-results').innerHTML = '';
    $('#student-selected').hidden = true;
    $('#book-code').value = '';
    $('#book-check').innerHTML = '';
    $('#step-book').classList.add('is-disabled');
    $('#book-code').disabled = true;
    $('#book-code-btn').disabled = true;
    renderNav();
    $('#student-search').focus();
  }

  /* ------------------------------------------------------- staff: manage */

  async function renderManage(tab) {
    const active = (tab && tab[0]) || 'eleves';
    const tabsFor = canManage()
      ? [['eleves', 'Eleves'], ['personnel', 'Personnel'], ['demandes', 'Demandes'], ['journal', 'Journal'], ['parametres', 'Parametres']]
      : [['eleves', 'Eleves'], ['demandes', 'Demandes'], ['journal', 'Journal']];
    setView(`
      ${bannerMustChange()}
      <div class="page-head"><h1>Gestion du CDI</h1></div>
      <div class="tabs" id="manage-tabs">
        ${tabsFor.map(([k, label]) => `<button class="tab ${k === active ? 'is-active' : ''}" data-action="manage-tab" data-tab="${k}">${label}</button>`).join('')}
      </div>
      <div id="manage-body"><div class="loader"><span class="spinner"></span> Chargement...</div></div>
    `);
    loadManageTab(active);
  }

  async function loadManageTab(tab) {
    $$('#manage-tabs .tab').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === tab));
    const body = $('#manage-body');
    body.innerHTML = '<div class="loader"><span class="spinner"></span> Chargement...</div>';
    try {
      if (tab === 'eleves') await renderElevesTab(body);
      else if (tab === 'personnel') await renderPersonnelTab(body);
      else if (tab === 'demandes') await renderDemandesTab(body);
      else if (tab === 'journal') await renderJournalTab(body);
      else if (tab === 'parametres') await renderParamsTab(body);
    } catch (err) {
      body.innerHTML = `<p class="text-danger">${esc(err.message)}</p>`;
    }
  }

  async function renderElevesTab(body) {
    const [data, loansData] = await Promise.all([
      API.get('/api/users?role=eleve'),
      API.get('/api/loans?status=en_cours')
    ]);
    const counts = {};
    loansData.loans.forEach((l) => { counts[l.userId] = (counts[l.userId] || 0) + 1; });
    body.innerHTML = `
      <div class="toolbar">
        <input type="search" id="eleves-q" class="input" placeholder="Rechercher un eleve...">
        <button class="btn btn--primary" data-action="new-student">+ Ajouter un eleve</button>
      </div>
      <div id="eleves-list" class="table-wrap"></div>`;
    const draw = (list) => {
      $('#eleves-list').innerHTML = `
        <table class="data-table">
          <thead><tr><th>Nom</th><th>Prenom</th><th>Identifiant Pronote</th><th>Classe</th><th>Emprunts</th><th></th></tr></thead>
          <tbody>
            ${list.map((u) => `<tr>
              <td>${esc(u.nom)}</td>
              <td>${esc(u.prenom)}</td>
              <td><code>${esc(u.login)}</code></td>
              <td>${esc(u.classe || '-')}</td>
              <td>${counts[u.id] ? `<span class="chip">${counts[u.id]}</span>` : '0'}</td>
              <td class="table-actions">
                <button class="btn btn--ghost btn--sm" data-action="edit-user" data-id="${u.id}">Modifier</button>
                <button class="btn btn--ghost btn--sm" data-action="reset-user" data-id="${u.id}">Mot de passe</button>
                <button class="btn btn--danger btn--sm" data-action="delete-user" data-id="${u.id}">Supprimer</button>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>`;
    };
    draw(data.users);
    const q = $('#eleves-q');
    q.addEventListener('input', () => {
      const term = q.value.toLowerCase();
      draw(data.users.filter((u) => [u.nom, u.prenom, u.login, u.classe].filter(Boolean).some((v) => v.toLowerCase().includes(term))));
    });
  }

  async function renderPersonnelTab(body) {
    const data = await API.get('/api/users');
    const staff = data.users.filter((u) => u.role !== 'eleve');
    body.innerHTML = `
      <div class="toolbar"><div></div><button class="btn btn--primary" data-action="new-staff">+ Ajouter un membre du personnel</button></div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>Nom</th><th>Prenom</th><th>Identifiant</th><th>Role</th><th></th></tr></thead>
          <tbody>
            ${staff.map((u) => `<tr>
              <td>${esc(u.nom)}</td>
              <td>${esc(u.prenom)}</td>
              <td><code>${esc(u.login)}</code></td>
              <td>${esc(u.roleLabel)}</td>
              <td class="table-actions">
                <button class="btn btn--ghost btn--sm" data-action="edit-user" data-id="${u.id}">Modifier</button>
                <button class="btn btn--ghost btn--sm" data-action="reset-user" data-id="${u.id}">Mot de passe</button>
                <button class="btn btn--danger btn--sm" data-action="delete-user" data-id="${u.id}">Supprimer</button>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  async function renderDemandesTab(body) {
    const data = await API.get('/api/reservations');
    if (!data.total) { body.innerHTML = '<div class="empty"><p>Aucune demande d\'emprunt pour le moment.</p></div>'; return; }
    body.innerHTML = data.reservations.map((r) => `
      <div class="list-row">
        <div class="list-row__cover">${r.coverUrl ? `<img src="${esc(r.coverUrl)}" alt="">` : ''}</div>
        <div class="list-row__main">
          <strong>${esc(r.titre)}</strong>
          <span class="muted small">Code ${esc(r.code)} - ${esc(r.eleve)}${r.classe ? ' (' + esc(r.classe) + ')' : ''} - demande du ${UI.formatDate(r.at)}</span>
          ${r.disponible ? '<span class="badge badge--ok">Livre disponible</span>' : '<span class="badge badge--busy">Livre emprunte</span>'}
        </div>
        <div class="list-row__actions">
          <button class="btn btn--primary btn--sm" data-action="validate-demand" data-id="${r.id}" data-user="${r.eleve}" data-book="${r.bookId}" data-code="${esc(r.code)}" ${r.disponible ? '' : 'disabled'}>Valider l'emprunt</button>
          <button class="btn btn--ghost btn--sm" data-action="cancel-reservation" data-id="${r.id}">Refuser</button>
        </div>
      </div>`).join('');
  }

  async function renderJournalTab(body) {
    const data = await API.get('/api/activity');
    if (!data.activity.length) { body.innerHTML = '<div class="empty"><p>Aucune activite.</p></div>'; return; }
    body.innerHTML = `<div class="timeline">${data.activity.map((a) => `
      <div class="timeline__item">
        <span class="timeline__dot"></span>
        <div>
          <strong>${esc(a.userLabel || 'Systeme')}</strong>
          <span class="muted small"> ${esc(a.action.replace(/_/g, ' '))}${a.details ? ' - ' + esc(a.details) : ''}</span>
          <div class="muted small">${UI.formatDate(a.at, true)}</div>
        </div>
      </div>`).join('')}</div>`;
  }

  async function renderParamsTab(body) {
    const s = state.settings;
    body.innerHTML = `
      <form data-form="settings" class="panel form-grid">
        <label class="field"><span>Nom de l'etablissement</span><input name="etablissement" value="${esc(s.etablissement || '')}"></label>
        <label class="field"><span>Annee scolaire</span><input name="anneeScolaire" value="${esc(s.anneeScolaire || '')}" placeholder="ex : 2025-2026"></label>
        <div class="form-row">
          <label class="field"><span>Duree d'un emprunt (jours)</span><input type="number" name="loanDays" min="1" max="365" value="${s.loanDays || 14}"></label>
          <label class="field"><span>Emprunts max par eleve</span><input type="number" name="maxLoansPerStudent" min="0" max="50" value="${s.maxLoansPerStudent || 3}"></label>
        </div>
        <div class="form-actions"><button class="btn btn--primary" type="submit">Enregistrer</button></div>
      </form>`;
  }

  /* --------------------------------------------------------- user modals */

  function userFormModal(user, opts = {}) {
    const isEdit = !!user;
    const forceRole = opts.forceRole || null;
    const isTargetStaff = isEdit && user.role !== 'eleve';
    const roleOptions = [
      ['eleve', 'Eleve'],
      ['documentaliste', 'Professeur documentaliste'],
      ['principal', 'Principal (chef d\'etablissement)'],
      ['principal_adjoint', 'Principal adjoint']
    ];
    const canPickRole = !forceRole && (!isEdit || !isTargetStaff) && canManage();
    const generated = Math.random().toString(36).slice(2, 8);

    const body = `
      <form id="user-form" class="form-grid">
        <div class="form-row">
          <label class="field"><span>Nom *</span><input name="nom" required value="${user ? esc(user.nom) : ''}"></label>
          <label class="field"><span>Prenom *</span><input name="prenom" required value="${user ? esc(user.prenom) : ''}"></label>
        </div>
        <label class="field"><span>Identifiant Pronote *</span><input name="login" required value="${user ? esc(user.login) : ''}" placeholder="ex : e.dupont"></label>
        ${canPickRole ? `<label class="field"><span>Role *</span>
          <select name="role" id="uf-role">
            ${roleOptions.map(([v, l]) => `<option value="${v}" ${user && user.role === v ? 'selected' : (!user && v === 'eleve' ? 'selected' : '')}>${esc(l)}</option>`).join('')}
          </select></label>` : ''}
        <label class="field" id="uf-classe-field"><span>Classe *</span><input name="classe" value="${user ? esc(user.classe || '') : ''}" placeholder="ex : 5eB"></label>
        <label class="field"><span>${isEdit ? 'Nouveau mot de passe (laisser vide pour conserver)' : 'Mot de passe (laisser vide = genere)'}</span>
          <input name="password" value="${isEdit ? '' : generated}"></label>
        <label class="checkline"><input type="checkbox" name="mustChangePassword" ${!isEdit ? 'checked' : ''}> Exiger un changement de mot de passe a la 1ere connexion</label>
      </form>`;
    const m = UI.modal({
      title: isEdit ? 'Modifier le compte' : 'Nouveau compte',
      body,
      actions: [
        { label: 'Annuler', className: 'btn--ghost', onClick: (o) => o.remove() },
        { label: isEdit ? 'Enregistrer' : 'Creer le compte', className: 'btn--primary', onClick: (o) => submitUserForm(o, { forceRole }) }
      ]
    });

    const roleSel = $('#uf-role');
    function syncClasse() {
      const val = roleSel ? roleSel.value : (forceRole || (user ? user.role : 'eleve'));
      $('#uf-classe-field').style.display = val === 'eleve' ? '' : 'none';
    }
    if (roleSel) roleSel.addEventListener('change', syncClasse);
    syncClasse();
    return m;
  }

  async function submitUserForm(overlay, opts = {}) {
    const form = overlay.querySelector('#user-form');
    const fd = new FormData(form);
    const payload = Object.fromEntries(fd.entries());
    payload.mustChangePassword = form.querySelector('[name="mustChangePassword"]').checked;
    if (opts.forceRole) payload.role = opts.forceRole;
    const editing = currentEditUserId;
    try {
      if (editing) {
        if (!payload.password) delete payload.password;
        if (!canManage() || !form.querySelector('[name="role"]')) delete payload.role;
        await API.put('/api/users/' + editing, payload);
        UI.toast('Compte modifie.', 'success');
      } else {
        if (!payload.role) payload.role = 'eleve';
        const url = payload.role === 'eleve' ? '/api/users' : '/api/users/staff';
        const res = await API.post(url, payload);
        UI.toast(`Compte cree. Mot de passe : ${payload.password || res.initialPassword}`, 'success', 9000);
      }
      overlay.remove();
      currentEditUserId = null;
      const activeTab = $('.tab.is-active');
      if (location.hash.startsWith('#/gestion') && activeTab) loadManageTab(activeTab.dataset.tab);
    } catch (err) {
      UI.toast(err.message, 'error');
    }
  }

  let currentEditUserId = null;

  async function editUser(id) {
    try {
      const data = await API.get('/api/users');
      const user = data.users.find((u) => u.id === Number(id));
      if (!user) { UI.toast('Compte introuvable.', 'error'); return; }
      currentEditUserId = user.id;
      userFormModal(user);
    } catch (err) { UI.toast(err.message, 'error'); }
  }

  async function resetUser(id) {
    const pwd = window.prompt('Nouveau mot de passe (laisser vide pour en generer un automatique) :');
    if (pwd === null) return;
    try {
      const res = await API.post(`/api/users/${id}/reset-password`, pwd ? { password: pwd } : {});
      UI.modal({
        title: 'Mot de passe reinitialise',
        body: `<p class="modal__text">Nouveau mot de passe :</p><p class="code-box">${esc(res.password)}</p><p class="muted small">Notez-le et transmettez-le a l'eleve.</p>`,
        actions: [{ label: 'Fermer', className: 'btn--primary', onClick: (o) => o.remove() }]
      });
    } catch (err) { UI.toast(err.message, 'error'); }
  }

  async function deleteUser(id) {
    if (!(await UI.confirm({ title: 'Supprimer le compte', message: 'Cette action est definitive. Continuer ?', confirmLabel: 'Supprimer', danger: true }))) return;
    try {
      await API.del('/api/users/' + id);
      UI.toast('Compte supprime.', 'success');
      if (location.hash.startsWith('#/gestion')) loadManageTab($('.tab.is-active')?.dataset.tab || 'eleves');
    } catch (err) { UI.toast(err.message, 'error'); }
  }

  /* --------------------------------------------------------- form handler */

  const formHandlers = {
    async password(form) {
      const fd = new FormData(form);
      const cur = fd.get('currentPassword');
      const nw = fd.get('newPassword');
      const cf = fd.get('confirmPassword');
      if (nw !== cf) { UI.toast('Les deux mots de passe ne correspondent pas.', 'error'); return; }
      try {
        await API.post('/api/auth/me/password', { currentPassword: cur, newPassword: nw });
        UI.toast('Mot de passe mis a jour.', 'success');
        state.user.mustChangePassword = false;
        form.reset();
      } catch (err) { UI.toast(err.message, 'error'); }
    },

    async review(form) {
      const id = form.dataset.id;
      const fd = new FormData(form);
      try {
        await API.post('/api/reviews', { bookId: Number(id), rating: Number(fd.get('rating')), text: fd.get('text') });
        UI.toast('Merci pour votre avis !', 'success');
        renderBookDetail([id]);
      } catch (err) { UI.toast(err.message, 'error'); }
    },

    async book(form) {
      const btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      const original = btn.textContent;
      const editing = form.dataset.id;
      try {
        const coverFile = form.querySelector('input[name="cover"]').files[0];
        const pdfFile = form.querySelector('input[name="pdf"]').files[0];

        const payload = {
          code: form.code.value,
          titre: form.titre.value,
          auteur: form.auteur.value,
          tome: form.tome.value,
          genre: form.genre.value,
          description: form.description.value
        };
        const nowCheck = form.querySelector('[name="now"]');
        if (nowCheck && nowCheck.checked) {
          payload.dateMiseEnLigne = 'now';
        } else {
          const d = form.querySelector('[name="dateMiseEnLigne"]').value;
          if (d) payload.dateMiseEnLigne = d;
        }

        if (coverFile) {
          btn.textContent = 'Envoi de la couverture...';
          payload.coverUrl = await uploadToBlob(coverFile, 'covers');
        }
        if (pdfFile) {
          btn.textContent = 'Envoi du PDF...';
          payload.pdfUrl = await uploadToBlob(pdfFile, 'pdfs');
        }

        btn.textContent = 'Enregistrement...';
        if (editing) {
          await API.put('/api/books/' + editing, payload);
          UI.toast('Livre modifie.', 'success');
        } else {
          await API.post('/api/books', payload);
          UI.toast('Livre ajoute au catalogue.', 'success');
        }
        location.hash = '#/catalogue';
      } catch (err) {
        UI.toast(err.message, 'error');
        btn.disabled = false;
        btn.textContent = original;
      }
    },

    async settings(form) {
      const fd = new FormData(form);
      try {
        await API.put('/api/settings', {
          etablissement: fd.get('etablissement'),
          anneeScolaire: fd.get('anneeScolaire'),
          loanDays: Number(fd.get('loanDays')),
          maxLoansPerStudent: Number(fd.get('maxLoansPerStudent'))
        });
        state.settings = await API.get('/api/settings');
        $('#brand-school').textContent = state.settings.etablissement;
        UI.toast('Parametres enregistres.', 'success');
      } catch (err) { UI.toast(err.message, 'error'); }
    },

    'borrow-code'(form) {
      const code = form.bookCode.value.trim();
      if (!code) return;
      validateBookCode(code);
    }
  };

  /* -------------------------------------------------------------- events */

  document.addEventListener('submit', (e) => {
    const form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    const handler = formHandlers[form.dataset.form];
    if (handler) handler(form, e);
  });

  async function onClick(e) {
    const navLink = e.target.closest('[data-nav]');
    if (navLink) { $('#main-nav').classList.remove('is-open'); }

    const target = e.target.closest('[data-action]');
    if (target) {
      const action = target.dataset.action;
      const id = target.dataset.id;
      switch (action) {
        case 'logout': {
          await API.post('/api/auth/logout', {}, { skipAuthRedirect: true });
          location.href = '/';
          return;
        }
        case 'nav': {
          location.hash = target.dataset.route;
          return;
        }
        case 'change-password': {
          location.hash = '#/compte';
          return;
        }
        case 'open-book': e.preventDefault(); location.hash = '#/livre/' + id; return;
        case 'read': e.preventDefault(); location.hash = '#/lire/' + id; return;
        case 'set-rating': setRating(target.parentElement, Number(target.dataset.value)); return;
        case 'select-student': selectStudent(id); return;
        case 'clear-student': state.borrow.student = null; $('#student-selected').hidden = true; $('#step-book').classList.add('is-disabled'); $('#book-code').disabled = true; $('#book-code-btn').disabled = true; return;
        case 'manage-tab': loadManageTab(target.dataset.tab); return;
        case 'new-student': currentEditUserId = null; userFormModal(null, { forceRole: 'eleve' }); return;
        case 'new-staff': currentEditUserId = null; userFormModal(null); return;
        case 'edit-user': editUser(id); return;
        case 'reset-user': resetUser(id); return;
        case 'delete-user': deleteUser(id); return;
        case 'return-loan': await doReturn(id); return;
        case 'renew-loan': await doRenew(id); return;
        case 'cancel-reservation': await cancelReservation(id); return;
        case 'delete-book': await deleteBook(id); return;
        case 'toggle-favorite': await toggleFavorite(id, target); return;
        case 'request-loan': await requestLoan(id); return;
        case 'validate-demand': await validateDemand(target); return;
      }
    }

    const userChip = e.target.closest('#user-chip');
    if (userChip) {
      const dd = $('#user-dropdown');
      dd.hidden = !dd.hidden;
      userChip.setAttribute('aria-expanded', String(!dd.hidden));
      return;
    }
    if (!e.target.closest('#user-menu')) {
      $('#user-dropdown').hidden = true;
    }

    if (e.target.closest('#nav-toggle')) {
      $('#main-nav').classList.toggle('is-open');
    }
  }
  document.addEventListener('click', onClick);

  async function doReturn(loanId) {
    if (!(await UI.confirm({ title: 'Enregistrer le retour', message: 'Confirmer le retour de ce livre ?', confirmLabel: 'Enregistrer le retour' }))) return;
    try { await API.post(`/api/loans/${loanId}/return`, {}); UI.toast('Retour enregistre.', 'success'); loadStaffLoans(); }
    catch (err) { UI.toast(err.message, 'error'); }
  }

  async function doRenew(loanId) {
    try { const r = await API.post(`/api/loans/${loanId}/renew`, {}); UI.toast('Emprunt prolonge de ' + (state.settings.loanDays || 14) + ' jours.', 'success'); loadStaffLoans(); }
    catch (err) { UI.toast(err.message, 'error'); }
  }

  async function cancelReservation(id) {
    if (!(await UI.confirm({ title: 'Annuler la demande', message: 'Supprimer cette demande d\'emprunt ?', confirmLabel: 'Supprimer', danger: true }))) return;
    try { await API.del('/api/reservations/' + id); UI.toast('Demande supprimee.', 'success'); router(); }
    catch (err) { UI.toast(err.message, 'error'); }
  }

  async function validateDemand(btn) {
    const userId = Number(btn.dataset.user);
    const code = btn.dataset.code;
    state.borrow.student = { id: userId, label: btn.closest('.list-row').querySelector('strong').textContent, sub: '' };
    try {
      const data = await API.get('/api/books?q=' + encodeURIComponent(code));
      const book = data.books.find((b) => b.code === code);
      if (!book) { UI.toast('Livre introuvable.', 'error'); return; }
      confirmBorrow(book);
    } catch (err) { UI.toast(err.message, 'error'); }
  }

  async function deleteBook(id) {
    if (!(await UI.confirm({ title: 'Supprimer le livre', message: 'Le livre et son PDF seront definitivement supprimes. Continuer ?', confirmLabel: 'Supprimer', danger: true }))) return;
    try { await API.del('/api/books/' + id); UI.toast('Livre supprime.', 'success'); location.hash = '#/catalogue'; }
    catch (err) { UI.toast(err.message, 'error'); }
  }

  async function toggleFavorite(id, btn) {
    const isFav = btn.textContent.includes('Retirer');
    try {
      if (isFav) { await API.del('/api/favorites/' + id); UI.toast('Retire des favoris.', 'success'); }
      else { await API.post('/api/favorites', { bookId: Number(id) }); UI.toast('Ajoute aux favoris.', 'success'); }
      refreshFavoriteButton(id);
    } catch (err) { UI.toast(err.message, 'error'); }
  }

  async function requestLoan(id) {
    try {
      await API.post('/api/reservations', { bookId: Number(id) });
      UI.modal({
        title: 'Demande envoyee',
        body: `<p class="modal__text">Votre demande d'emprunt a ete transmise au CDI. Presentez-vous au CDI : la professeure documentaliste ou le principal validera l'emprunt sur votre compte.</p>`,
        actions: [{ label: 'Compris', className: 'btn--primary', onClick: (o) => o.remove() }]
      });
    } catch (err) {
      if (err.message.includes('deja')) UI.toast(err.message, 'info');
      else UI.toast(err.message, 'error');
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
