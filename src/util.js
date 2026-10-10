function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}

// Ligne issue de : books LEFT JOIN loans(=en_cours) LEFT JOIN users
function mapBook(row) {
  const hasLoan = !!row.loan_id;
  return {
    id: row.id,
    code: row.code,
    titre: row.titre,
    auteur: row.auteur,
    tome: row.tome || null,
    genre: row.genre || null,
    description: row.description || null,
    dateMiseEnLigne: row.date_mise_en_ligne,
    coverUrl: row.cover_url || null,
    pdfUrl: row.pdf_url || null,
    disponible: !hasLoan,
    reservations: Number(row.reservations || 0),
    note: row.note !== null && row.note !== undefined && row.nb_avis > 0 ? round1(row.note) : null,
    nbAvis: Number(row.nb_avis || 0),
    createdAt: row.created_at,
    emprunt: hasLoan
      ? {
          id: row.loan_id,
          userId: row.loan_user_id,
          eleve: `${row.loan_prenom || ''} ${row.loan_nom || ''}`.trim(),
          classe: row.loan_classe || null,
          dateEmprunt: row.date_emprunt,
          dateRetourPrevue: row.date_retour_prevue,
          enRetard: new Date(row.date_retour_prevue).getTime() < Date.now()
        }
      : null
  };
}

// Ligne issue de : loans LEFT JOIN books LEFT JOIN users (x2)
function mapLoan(row) {
  return {
    id: row.id,
    bookId: row.book_id,
    userId: row.user_id,
    titre: row.titre || 'Livre supprime',
    code: row.code || null,
    auteur: row.auteur || null,
    coverUrl: row.cover_url || null,
    eleve: `${row.prenom || ''} ${row.nom || ''}`.trim() || 'Inconnu',
    eleveNom: row.nom || null,
    elevePrenom: row.prenom || null,
    classe: row.classe || null,
    staff: row.staff_prenom || row.staff_nom ? `${row.staff_prenom || ''} ${row.staff_nom || ''}`.trim() : null,
    dateEmprunt: row.date_emprunt,
    dateRetourPrevue: row.date_retour_prevue,
    dateRetour: row.date_retour || null,
    status: row.status,
    enRetard: row.status === 'en_cours' && new Date(row.date_retour_prevue).getTime() < Date.now()
  };
}

const BOOK_SELECT = `
  SELECT b.*,
    (SELECT COUNT(*) FROM reservations r WHERE r.book_id = b.id) AS reservations,
    (SELECT COUNT(*) FROM reviews rv WHERE rv.book_id = b.id) AS nb_avis,
    (SELECT AVG(rv.rating) FROM reviews rv WHERE rv.book_id = b.id) AS note,
    l.id AS loan_id,
    l.user_id AS loan_user_id,
    l.date_emprunt,
    l.date_retour_prevue,
    lu.prenom AS loan_prenom,
    lu.nom AS loan_nom,
    lu.classe AS loan_classe
  FROM books b
  LEFT JOIN loans l ON l.book_id = b.id AND l.status = 'en_cours'
  LEFT JOIN users lu ON lu.id = l.user_id
`;

const LOAN_SELECT = `
  SELECT l.*,
    b.titre, b.code, b.auteur, b.cover_url,
    u.prenom, u.nom, u.classe,
    s.prenom AS staff_prenom, s.nom AS staff_nom
  FROM loans l
  LEFT JOIN books b ON b.id = l.book_id
  LEFT JOIN users u ON u.id = l.user_id
  LEFT JOIN users s ON s.id = l.staff_id
`;

module.exports = { addDays, round1, mapBook, mapLoan, BOOK_SELECT, LOAN_SELECT };
