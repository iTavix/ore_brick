"use strict";

/* =====================================================================
   HourFlow Premium Edition - Core Scripting
   ===================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// Coalesces rapid calls (e.g. search keystrokes) into a single trailing call.
function debounce(fn, wait = 180) {
  let t;
  return function (...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), wait); };
}

// Lazy-load jsPDF + autotable on first export so ~300KB don't block startup.
// Returns a cached promise; rejects if the scripts can't be fetched (offline),
// in which case exportNotePDF() falls back to the print path.
let _pdfLibPromise = null;
function loadPdfLib() {
  if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve();
  if (_pdfLibPromise) return _pdfLibPromise;
  const inject = (src) => new Promise((res, rej) => {
    const sc = document.createElement('script');
    sc.src = src; sc.onload = res; sc.onerror = () => rej(new Error('load failed: ' + src));
    document.head.appendChild(sc);
  });
  _pdfLibPromise = inject('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js')
    .then(() => inject('https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js'))
    .catch((e) => { _pdfLibPromise = null; throw e; });
  return _pdfLibPromise;
}

// Definizione globale posizionata prima del caricamento dello stato dell'app
const DEFAULT_SETTINGS = {
  id: 'app',
  hourlyRate: 25,
  extra: 0,
  taxRate: 0,
  vatRate: 0,
  withholdingTaxRate: 0,
  holderName: '',
  iban: '',
  bic: '',
  causale: 'Prestazione professionale',
  stampDuty: false,
  regime: 'ordinario',        // 'ordinario' | 'forfettario' (forfettario: no IVA, no ritenuta in nota)
  roundingMinutes: 0,         // round timer sessions UP to this increment in minutes (0 = off)
  coefficiente: 78,           // forfettario: coefficiente di redditività (%) — annual estimate
  impostaSostitutiva: 5,      // forfettario: imposta sostitutiva (%) — annual estimate
  clientProfile: { name: '', vat: '', address: '', email: '', phone: '' },
  theme: 'auto'
};

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function genId() {
  try { if (crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (_) {}
  try {
    const b = new Uint8Array(16); crypto.getRandomValues(b);
    return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  } catch (_) {}
  return 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2);
}

function eur(n) {
  return (Number(n) || 0).toLocaleString(numLocale(), { style: 'currency', currency: 'EUR' });
}

function hrs(n) {
  const v = Number(n) || 0;
  return v.toLocaleString(numLocale(), { maximumFractionDigits: 2 }) + ' h';
}

// "1 sessione" / "3 sessioni" — evita i plurali sbagliati con n = 1.
function plural(n, sing, plur) {
  return `${n} ${n === 1 ? sing : plur}`;
}

// Valore economico di una sessione: importo fisso se a forfait, altrimenti
// ore × tariffa. Richiede una entry "mappata" da allEntriesFlat (campo rate).
function entryValue(e) {
  return e.billingType === 'flat' ? (Number(e.amount) || 0) : (Number(e.hours) || 0) * (Number(e.rate) || 0);
}

// Arrotondamento monetario a 2 decimali: i totali fiscali vanno fissati voce per
// voce, altrimenti i float IEEE 754 fanno divergere i centesimi tra nota, PDF e storico.
function round2(n) {
  return Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;
}

// Una data ISO è valida solo se il round-trip Date la riproduce identica
// (il solo regex accetta impossibili come 2026-02-30).
function isValidIsoDate(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// Giorni interi da a → b, calcolati in UTC: immune a fuso locale e ora legale.
function daysBetweenIso(a, b) {
  const utc = (iso) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((utc(b) - utc(a)) / 86400000);
}

function dateIt(iso) {
  if (!isValidIsoDate(iso)) return '—';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function todayIso() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function maskIban(iban) {
  const v = String(iban == null ? '' : iban).replace(/\s+/g, '');
  if (!v) return '';
  let out = v.length <= 8 ? '•'.repeat(v.length) : v.slice(0, 4) + '•'.repeat(v.length - 8) + v.slice(-4);
  return out.replace(/(.{4})/g, '$1 ').trim();
}

// Raggruppa l'IBAN in blocchi da 4 per la stampa leggibile
function groupIban(iban) {
  const v = String(iban == null ? '' : iban).replace(/\s+/g, '');
  return v ? v.replace(/(.{4})/g, '$1 ').trim() : '';
}

// Copia testo negli appunti: Clipboard API moderna con fallback su execCommand.
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) { /* fallback sotto */ }
  try {
    const el = document.createElement('textarea');
    el.value = text;
    el.style.position = 'fixed'; el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
    return true;
  } catch (_) { return false; }
}

// Stampa robusta cross-browser, in particolare iOS/Safari. La nota viene stampata
// dentro un iframe ISOLATO con gli stili della pagina clonati. Cosi' si evitano gli
// ostacoli che mandano in tilt l'anteprima di Safari (header sticky + backdrop blur,
// body a 100vh, contenitori overflow-x-auto, dark mode) e non si dipende dal rinvio
// post-gesto che iOS ignora. Fallback su window.print() se qualcosa fallisce.
function printNote() {
  const area = document.querySelector('.print-area');
  if (!area) { try { window.print(); } catch (_) {} return; }

  const old = document.getElementById('print-frame');
  if (old) old.remove();

  const iframe = document.createElement('iframe');
  iframe.id = 'print-frame';
  iframe.setAttribute('aria-hidden', 'true');
  // Fuori schermo ma con dimensioni reali (A4 a 96dpi): display:none/size 0 non
  // verrebbe impaginato e alcuni browser lo stampano vuoto.
  iframe.style.cssText = 'position:fixed; left:-9999px; top:0; width:794px; height:1123px; border:0;';
  document.body.appendChild(iframe);

  // Clona tutti gli stili della pagina, incluse le utility generate da Tailwind
  // (iniettate come <style>): nell'iframe le classi rendono identiche allo schermo.
  let headStyles = '';
  document.querySelectorAll('style, link[rel="stylesheet"]').forEach((node) => {
    headStyles += node.outerHTML;
  });

  const doc = iframe.contentWindow.document;
  doc.open();
  doc.write(
    '<!DOCTYPE html><html lang="' + LANG + '"><head><meta charset="utf-8">' +
    headStyles +
    '<style>' +
      '@page { size: A4; margin: 14mm; }' +
      'html,body{ margin:0!important; padding:0!important; background:#fff!important; }' +
      '*{ -webkit-print-color-adjust:exact!important; print-color-adjust:exact!important; }' +
      '.no-print{ display:none!important; }' +
      '.print\\:inline{ display:inline!important; }' +
      '.print-area{ box-shadow:none!important; border:none!important; border-radius:0!important; margin:0!important; padding:0!important; overflow:visible!important; background:#fff!important; }' +
      '.overflow-x-auto{ overflow:visible!important; }' +
      '.print-table{ width:100%!important; min-width:0!important; }' +
      '.print-table th,.print-table td{ padding:8px 10px!important; border-bottom:1px solid #e2e2e6!important; }' +
      '.print-table tr,.print-table thead,.print-keep{ break-inside:avoid; }' +
    '</style></head><body>' +
    area.outerHTML +
    '</body></html>'
  );
  doc.close();

  let printed = false;
  const fire = () => {
    if (printed) return; printed = true;
    try {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    } catch (e) {
      console.error('print failed', e);
      try { window.print(); } catch (_) {}
    }
    // afterprint non e' garantito su iOS: pulizia a tempo.
    setTimeout(() => { const f = document.getElementById('print-frame'); if (f) f.remove(); }, 1500);
  };

  // Se il documento e' gia' pronto, stampo SUBITO (resto dentro il gesto del tap,
  // requisito di iOS). Altrimenti attendo onload, con timeout di sicurezza perche'
  // i documenti creati via document.write spesso non emettono onload.
  if (doc.readyState === 'complete') {
    fire();
  } else {
    iframe.onload = fire;
    setTimeout(fire, 300);
  }
}

// Effective fiscal rates honoring the chosen regime. In 'forfettario' the invoice
// carries no VAT and no withholding tax (esente IVA, non soggetto a ritenuta);
// the optional INPS rivalsa is preserved. Centralised so the PDF model and the
// on-screen note never drift apart.
function effectiveFiscal(s) {
  const forfettario = (s.regime || 'ordinario') === 'forfettario';
  return {
    forfettario,
    taxP: Number(s.taxRate) || 0,
    vatP: forfettario ? 0 : (Number(s.vatRate) || 0),
    wTaxP: forfettario ? 0 : (Number(s.withholdingTaxRate) || 0)
  };
}

// Modello della nota corrente: tutti i valori calcolati dai filtri/impostazioni.
// Usato dall'export PDF (e riutilizzabile altrove) senza dipendere dal DOM.
function buildNoteModel() {
  const s = state.settings;
  const filteredIds = new Set(getScopedEntries().map(e => e.id));
  const inScope = allEntriesFlat().filter(e => filteredIds.has(e.id));
  // Le sessioni marcate "già pagata" restano nel progetto e nei report, ma non
  // entrano nella nota: non devono generare importi da incassare.
  const flat = inScope.filter(e => !e.paid);
  const paidExcludedCount = inScope.length - flat.length;
  const tH = flat.reduce((a, e) => a + (Number(e.hours) || 0), 0);
  const baseCompensation = round2(flat.reduce((a, e) => a + entryValue(e), 0) + flatScopedTotal());
  const { taxP, vatP, wTaxP, forfettario } = effectiveFiscal(s);
  const taxValue = round2(baseCompensation * taxP / 100);
  const subtotalWithTax = round2(baseCompensation + taxValue);
  const vatValue = round2(subtotalWithTax * vatP / 100);
  const wTaxValue = round2(subtotalWithTax * wTaxP / 100);
  const grandTotal = round2(subtotalWithTax + vatValue - wTaxValue);
  const stampDuty = (vatP === 0 && s.stampDuty && grandTotal > 77.47) ? 2 : 0;
  const payable = round2(grandTotal + stampDuty);
  const ctx = paymentContext();
  const note = getNote(ctx.key);
  const ctxPayments = paymentsForContext(ctx.key);
  const paid = round2(ctxPayments.reduce((a, p) => a + (Number(p.amount) || 0), 0));
  const residual = round2(payable - paid);
  const clientNames = [...new Set(flat.map(x => x.clientName).filter(Boolean))];
  const clientAddresses = [...new Set(flat.map(x => x.clientAddress).filter(Boolean))];
  const clientVats = [...new Set(flat.map(x => x.clientVat).filter(Boolean))];
  const clientForeignVats = [...new Set(flat.map(x => x.clientForeignVat).filter(Boolean))];
  return { s, flat, tH, baseCompensation, taxP, vatP, wTaxP, taxValue, subtotalWithTax, vatValue, wTaxValue,
           grandTotal, stampDuty, payable, ctx, note, ctxPayments, paid, residual, forfettario, paidExcludedCount,
           clientNames, clientAddresses, clientVats, clientForeignVats };
}

// Esporta la nota come PDF nativo (jsPDF + autotable), senza dialogo di stampa.
// Se la libreria non è disponibile, ripiega sulla stampa via iframe.
function exportNotePDF() {
  if (!(window.jspdf && window.jspdf.jsPDF)) {
    toast(t('Modulo PDF non pronto: uso la stampa'), 'warning');
    printNote();
    return;
  }
  const m = buildNoteModel();
  const s = m.s;
  const money = (n) => (Number(n) || 0).toLocaleString(numLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' EUR';
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 40;
  const accent = [255, 149, 0], ink = [29, 29, 31], soft = [110, 110, 115];

  doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.setTextColor(...accent);
  doc.text(t('NOTA DI PAGAMENTO'), M, 52);

  let ry = 44;
  doc.setFontSize(10);
  if (m.note) { doc.setFont('helvetica', 'bold'); doc.setTextColor(...ink); doc.text(t('Nota N. {n}', { n: noteNumFmt(m.note.n, m.note.year) }), W - M, ry, { align: 'right' }); ry += 14; }
  doc.setFont('helvetica', 'normal'); doc.setTextColor(...soft);
  doc.text(t('Emissione: {d}', { d: dateIt(m.note ? m.note.issuedAt : todayIso()) }), W - M, ry, { align: 'right' }); ry += 14;
  const status = m.payable > 0.005 ? (m.residual <= 0.005 && m.paid > 0 ? t('PAGATA') : (m.paid > 0 ? t('ACCONTO RICEVUTO') : t('DA SALDARE'))) : '';
  if (status) { doc.setFont('helvetica', 'bold'); doc.setTextColor(...ink); doc.text(status, W - M, ry, { align: 'right' }); }

  let y = 88;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(...soft); doc.text(t('MITTENTE'), M, y);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...ink); doc.text(s.holderName || '-', M, y + 14);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(...soft); doc.text(t('DESTINATARIO'), M, y + 36);
  const cname = m.clientNames.length === 1 ? m.clientNames[0] : (m.clientNames.length > 1 ? t('Fatturazione Multi-cliente') : '-');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...ink); doc.text(cname, M, y + 50);
  let dy = y + 64;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...soft);
  if (m.clientNames.length === 1) {
    if (m.clientAddresses[0]) { doc.text(String(m.clientAddresses[0]), M, dy); dy += 12; }
    if (m.clientVats[0]) { doc.text(t('P.IVA/CF') + ': ' + m.clientVats[0], M, dy); dy += 12; }
    if (m.clientForeignVats && m.clientForeignVats[0]) { doc.text(t('IVA estera') + ': ' + m.clientForeignVats[0], M, dy); dy += 12; }
  }

  const body = m.flat.map(e => [
    dateIt(e.date),
    e.billingType === 'flat' ? `${e.project} (${t('forfait')})` : `${e.project} (${money(e.rate)}/h)`,
    e.spec || '',
    e.billingType === 'flat' ? money(e.amount) : hrs(e.hours)
  ]);
  doc.autoTable({
    startY: Math.max(dy + 10, y + 92),
    head: [[t('Data'), t('Progetto'), t('Descrizione'), t('Ore / Forfait')]],
    body: body.length ? body : [['—', '—', t('Nessuna voce'), '—']],
    theme: 'grid',
    headStyles: { fillColor: [245, 245, 247], textColor: ink, fontStyle: 'bold', fontSize: 8 },
    bodyStyles: { fontSize: 9, textColor: ink },
    columnStyles: { 3: { halign: 'right' } },
    margin: { left: M, right: M }
  });

  let ty = doc.lastAutoTable.finalY + 18;
  if (s.causale) { doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...soft); doc.text(`${t('Causale')}: ${causaleText(s.causale)}`, M, ty); ty += 18; }
  if (m.forfettario) {
    doc.setFont('helvetica', 'italic'); doc.setFontSize(8); doc.setTextColor(...soft);
    doc.text(t('Operazione in franchigia da IVA - art. 1, c. 54-89, L. 190/2014.'), M, ty); ty += 11;
    doc.text(t("Compenso non soggetto a ritenuta d'acconto."), M, ty); ty += 16;
    doc.setFont('helvetica', 'normal'); doc.setTextColor(...ink);
  }

  const totals = [];
  totals.push([t('Compenso prestazioni'), money(m.baseCompensation), false]);
  totals.push([t('Totale Ore'), hrs(m.tH), false]);
  if (m.taxP > 0) totals.push([t('Rivalsa Previdenziale ({p}%)', { p: m.taxP }), money(m.taxValue), false]);
  if (m.vatP > 0) totals.push([t('I.V.A. ({p}%)', { p: m.vatP }), money(m.vatValue), false]);
  if (m.wTaxP > 0) totals.push([t("Ritenuta d'Acconto ({p}%)", { p: m.wTaxP }), '-' + money(m.wTaxValue), false]);
  if (m.stampDuty > 0) { totals.push([t('Subtotale'), money(m.grandTotal), false]); totals.push([t('Marca da bollo'), money(m.stampDuty), false]); }
  totals.push([m.stampDuty > 0 ? t('Totale documento') : t('Netto a pagare'), money(m.payable), true]);
  if (m.paid > 0) { totals.push([t('Già versato'), '-' + money(m.paid), false]); totals.push([m.residual <= 0.005 ? t('Saldato') : t('Residuo da pagare'), money(Math.max(0, m.residual)), false]); }

  const colX = W - M, labelX = W - M - 180;
  for (const [label, val, bold] of totals) {
    if (ty > H - 80) { doc.addPage(); ty = 60; }
    doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(bold ? 12 : 10);
    doc.setTextColor(...(bold ? accent : soft)); doc.text(label, labelX, ty);
    doc.setTextColor(...(bold ? accent : ink)); doc.text(val, colX, ty, { align: 'right' });
    ty += bold ? 20 : 14;
  }

  ty += 12;
  if (ty > H - 110) { doc.addPage(); ty = 60; }
  doc.setDrawColor(220); doc.line(M, ty, W - M, ty); ty += 16;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(...soft); doc.text(t('ESTREMI DI LIQUIDAZIONE'), M, ty); ty += 16;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...ink);
  doc.text(`${t('Intestatario')}: ${s.holderName || '-'}`, M, ty); ty += 14;
  doc.text(`IBAN: ${s.iban ? groupIban(s.iban) : '-'}`, M, ty); ty += 14;
  doc.text(`BIC/SWIFT: ${s.bic || '-'}`, M, ty);

  doc.setFontSize(8); doc.setTextColor(...soft); doc.text('HourFlow  ·  iTavix', M, H - 24);

  const numPart = m.note ? `_${String(m.note.n).padStart(4, '0')}-${m.note.year}` : '';
  doc.save(`${isEn() ? 'payment_note' : 'nota_pagamento'}${numPart}_${todayIso()}.pdf`);
  toast(t('PDF generato'));
}

// La causale predefinita è testo dell'app, quindi segue la lingua; una causale
// scritta dall'utente resta com'è.
function causaleText(c) {
  return c === DEFAULT_SETTINGS.causale ? t(c) : c;
}

/* ---------------------------------------------------------------------
   Secure Storage Helper & Fallback Engine
--------------------------------------------------------------------- */
function getLocalStorageItem(key) {
  try {
    return (typeof window !== 'undefined' && window.localStorage) ? window.localStorage.getItem(key) : null;
  } catch (e) { return null; }
}

function setLocalStorageItem(key, value) {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(key, value);
    }
  } catch (e) { console.warn("Impossibile salvare nel localStorage: ", e); }
}

const DB_NAME = 'hourflow-prm';
const DB_VERSION = 3;
let _db = null;
let _useFallback = false;

const fallbackData = {
  settings: {},
  projects: [],
  entries: [],
  clients: [],
  payments: [],
  timer: {}
};

function initFallbackStorage() {
  _useFallback = true;
  const fallbackBadge = $('#fallback-badge');
  if (fallbackBadge) fallbackBadge.classList.remove('hidden');
  try {
    const parsedSettings = JSON.parse(getLocalStorageItem('obb_p_settings'));
    fallbackData.settings = (parsedSettings && typeof parsedSettings === 'object' && !Array.isArray(parsedSettings)) ? parsedSettings : {};

    const parsedProjects = JSON.parse(getLocalStorageItem('obb_p_projects'));
    fallbackData.projects = Array.isArray(parsedProjects) ? parsedProjects : [];

    const parsedEntries = JSON.parse(getLocalStorageItem('obb_p_entries'));
    fallbackData.entries = Array.isArray(parsedEntries) ? parsedEntries : [];

    const parsedClients = JSON.parse(getLocalStorageItem('obb_p_clients'));
    fallbackData.clients = Array.isArray(parsedClients) ? parsedClients : [];

    const parsedPayments = JSON.parse(getLocalStorageItem('obb_p_payments'));
    fallbackData.payments = Array.isArray(parsedPayments) ? parsedPayments : [];

    const parsedTimer = JSON.parse(getLocalStorageItem('obb_p_timer'));
    fallbackData.timer = (parsedTimer && typeof parsedTimer === 'object' && !Array.isArray(parsedTimer)) ? parsedTimer : {};
  } catch (e) {
    console.warn("Storage di fallback volatile in uso.");
    fallbackData.settings = {};
    fallbackData.projects = [];
    fallbackData.entries = [];
    fallbackData.clients = [];
    fallbackData.payments = [];
    fallbackData.timer = {};
  }
}

function saveFallback(store) {
  if (!_useFallback) return;
  setLocalStorageItem('obb_p_' + store, JSON.stringify(fallbackData[store]));
}

function openDB() {
  return new Promise((resolve, reject) => {
    try {
      if (typeof indexedDB === 'undefined' || indexedDB === null) {
        throw new Error("IndexedDB non disponibile.");
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('clients')) db.createObjectStore('clients', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('entries')) {
          const s = db.createObjectStore('entries', { keyPath: 'id' });
          s.createIndex('projectId', 'projectId', { unique: false });
        }
        if (!db.objectStoreNames.contains('timer')) db.createObjectStore('timer', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('payments')) db.createObjectStore('payments', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('expenses')) {
          const ex = db.createObjectStore('expenses', { keyPath: 'id' });
          ex.createIndex('projectId', 'projectId', { unique: false });
        }
        if (!db.objectStoreNames.contains('quotes')) db.createObjectStore('quotes', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("Errore IndexedDB"));
    } catch (err) { reject(err); }
  });
}

function tx(store, mode) {
  return _db.transaction(store, mode).objectStore(store);
}
function idbReq(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const dbGet = async (store, key) => {
  if (_useFallback) {
    if (store === 'settings' || store === 'timer') {
      return fallbackData[store][key] || null;
    }
    return null;
  }
  try { return await idbReq(tx(store, 'readonly').get(key)); } catch (err) {
    initFallbackStorage();
    return dbGet(store, key);
  }
};

const dbGetAll = async (store) => {
  if (_useFallback) {
    if (store === 'projects') return fallbackData.projects;
    if (store === 'entries') return fallbackData.entries;
    if (store === 'clients') return fallbackData.clients;
    if (store === 'payments') return fallbackData.payments;
    if (store === 'settings') return Object.values(fallbackData.settings);
    return [];
  }
  try { return await idbReq(tx(store, 'readonly').getAll()); } catch (err) {
    initFallbackStorage();
    return dbGetAll(store);
  }
};

const dbPut = async (store, value) => {
  // Per-record sync: ogni scrittura LOCALE di un record timbra updatedAt (epoch ms)
  // così il merge cloud puo' decidere chi vince per singolo record (last-write-wins
  // a livello di documento, non dell'intero archivio). Durante applyingRemote NON
  // si timbra, per conservare il timestamp originale arrivato dal cloud.
  if (value && typeof value === 'object' &&
      (store === 'projects' || store === 'entries' || store === 'clients' || store === 'payments') &&
      !sync.applyingRemote) {
    value.updatedAt = Date.now();
  }
  if (_useFallback) {
    if (store === 'settings' || store === 'timer') {
      fallbackData[store][value.id] = value;
    } else if (store === 'projects' || store === 'entries' || store === 'clients' || store === 'payments') {
      const idx = fallbackData[store].findIndex(item => item.id === value.id);
      if (idx > -1) fallbackData[store][idx] = value;
      else fallbackData[store].push(value);
    }
    saveFallback(store);
    return value;
  }
  try { return await idbReq(tx(store, 'readwrite').put(value)); } catch (err) {
    initFallbackStorage();
    return dbPut(store, value);
  }
};

const dbDel = async (store, key) => {
  if (_useFallback) {
    if (store === 'settings' || store === 'timer') {
      delete fallbackData[store][key];
    } else if (store === 'projects' || store === 'entries' || store === 'clients' || store === 'payments') {
      fallbackData[store] = fallbackData[store].filter(item => item.id !== key);
    }
    saveFallback(store);
    return;
  }
  try { return await idbReq(tx(store, 'readwrite').delete(key)); } catch (err) {
    initFallbackStorage();
    return dbDel(store, key);
  }
};

function dbClear(store) {
  if (_useFallback) {
    if (store === 'projects' || store === 'entries' || store === 'clients' || store === 'payments') fallbackData[store] = [];
    saveFallback(store);
    return Promise.resolve();
  }
  try {
    const t = _db.transaction(store, 'readwrite');
    return new Promise((resolve, reject) => {
      const req = t.objectStore(store).clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    initFallbackStorage();
    return dbClear(store);
  }
}

/* ---------------------------------------------------------------------
   State Management & Seed Data
--------------------------------------------------------------------- */
const state = {
  settings: { ...DEFAULT_SETTINGS },
  projects: [],
  entries: [],
  clients: [],
  payments: [],
  expenses: [],
  quotes: [],
  view: 'dashboard',
  expanded: new Set(),
  // Selezione multipla in Dashboard (per segnare più sessioni come pagate).
  selectMode: false,
  selected: new Set(),
  activeTimer: null,
  search: '',
  
  filters: {
    period: 'all',
    startDate: '',
    endDate: '',
    project: 'all',
    // 'all' | 'unpaid' | 'paid' — filtro di sola visualizzazione: non tocca la Nota.
    payment: 'all'
  }
};

async function seedIfEmpty() {
  const existing = await dbGetAll('projects');
  const hasSettings = await dbGet('settings', 'app');
  if (!hasSettings) await dbPut('settings', { ...DEFAULT_SETTINGS });
  if (existing && existing.length) return;

  const p1 = { id: genId(), name: 'Arcade BrickBoy', createdAt: '2026-06-17', hourlyRate: 30, clientId: 'c1' };
  const p2 = { id: genId(), name: 'GameBoy BrickBoy', createdAt: '2026-05-22', hourlyRate: null, clientId: 'c2' };
  const p3 = { id: genId(), name: 'Play station 1 BrickBoy', createdAt: '2026-03-30', hourlyRate: 35, clientId: 'c3' };
  for (const p of [p1, p2, p3]) await dbPut('projects', p);

  const seedEntries = [
    { id: genId(), projectId: p1.id, spec: 'Seconda Iterazione Arcade', date: '2026-06-17', hours: 1.5 },
    { id: genId(), projectId: p2.id, spec: 'Seconda Iterazione istruzioni', date: '2026-05-22', hours: 5 },
    { id: genId(), projectId: p2.id, spec: 'Terza Iterazione istruzioni', date: '2026-06-11', hours: 2.25 },
    { id: genId(), projectId: p3.id, spec: 'Realizzazione file studio Play Station 1', date: '2026-03-30', hours: 4.75 }
  ];
  for (const e of seedEntries) await dbPut('entries', e);
}

async function loadState() {
  const s = await dbGet('settings', 'app');
  state.settings = s ? s : { ...DEFAULT_SETTINGS };
  state.projects = (await dbGetAll('projects')) || [];
  state.entries = (await dbGetAll('entries')) || [];
  state.clients = (await dbGetAll('clients')) || [];
  state.payments = (await dbGetAll('payments')) || [];
  state.expenses = (await dbGetAll('expenses')) || [];
  state.quotes = (await dbGetAll('quotes')) || [];
  state.activeTimer = await dbGet('timer', 'current') || null;

  if (!Array.isArray(state.projects)) state.projects = [];
  if (!Array.isArray(state.entries)) state.entries = [];
  if (!Array.isArray(state.clients)) state.clients = [];
  if (!Array.isArray(state.payments)) state.payments = [];
  if (!Array.isArray(state.expenses)) state.expenses = [];
  if (!Array.isArray(state.quotes)) state.quotes = [];

  // Procedura di Auto-migrazione (Crea record anagrafici dai vecchi testi dei clienti)
  let migrated = false;
  for (const p of state.projects) {
    if (!p.clientId && p.clientName) {
      let existingClient = state.clients.find(c => c.name.toLowerCase() === p.clientName.toLowerCase());
      if (!existingClient) {
        existingClient = {
          id: genId(),
          name: p.clientName,
          address: p.clientAddress || '',
          vatCode: '',
          email: '',
          phone: ''
        };
        state.clients.push(existingClient);
        await dbPut('clients', existingClient);
      }
      p.clientId = existingClient.id;
      await dbPut('projects', p);
      migrated = true;
    }
  }

  if (migrated) {
    state.projects = (await dbGetAll('projects')) || [];
    state.clients = (await dbGetAll('clients')) || [];
  }

  state.projects.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.name || '').localeCompare(String(b.name || '')));
  state.entries.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  state.clients.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}

/* ---------------------------------------------------------------------
   Calcoli Fiscali Relazionali e Filtri
--------------------------------------------------------------------- */
// Perimetro di fatturazione: progetto + finestra temporale. È la base della Nota
// di pagamento, che NON deve cambiare al variare del filtro "Stato pagamento".
function getScopedEntries() {
  let filtered = state.entries;

  if (state.filters.project !== 'all') {
    filtered = filtered.filter(e => e.projectId === state.filters.project);
  }

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();

  if (state.filters.period === 'current-month') {
    const mm = String(month + 1).padStart(2, '0');
    const dd = String(new Date(year, month + 1, 0).getDate()).padStart(2, '0');
    const startIso = `${year}-${mm}-01`;
    const endIso = `${year}-${mm}-${dd}`;
    filtered = filtered.filter(e => e.date >= startIso && e.date <= endIso);
  } else if (state.filters.period === 'last-month') {
    const prevMonth = month === 0 ? 11 : month - 1;
    const prevYear = month === 0 ? year - 1 : year;
    const mm = String(prevMonth + 1).padStart(2, '0');
    const dd = String(new Date(prevYear, prevMonth + 1, 0).getDate()).padStart(2, '0');
    const startIso = `${prevYear}-${mm}-01`;
    const endIso = `${prevYear}-${mm}-${dd}`;
    filtered = filtered.filter(e => e.date >= startIso && e.date <= endIso);
  } else if (state.filters.period === 'current-year') {
    const startIso = `${year}-01-01`;
    const endIso = `${year}-12-31`;
    filtered = filtered.filter(e => e.date >= startIso && e.date <= endIso);
  } else if (state.filters.period === 'custom') {
    if (state.filters.startDate) {
      filtered = filtered.filter(e => e.date >= state.filters.startDate);
    }
    if (state.filters.endDate) {
      filtered = filtered.filter(e => e.date <= state.filters.endDate);
    }
  }

  return filtered;
}

// Voci mostrate a schermo: perimetro + filtro "Stato pagamento" della Dashboard.
function getFilteredEntries() {
  const scoped = getScopedEntries();
  const status = (state.filters && state.filters.payment) || 'all';
  if (status === 'unpaid') return scoped.filter(e => !e.paid);
  if (status === 'paid') return scoped.filter(e => !!e.paid);
  return scoped;
}

function entriesOf(projectId) {
  const filtered = getFilteredEntries();
  return filtered.filter(e => e.projectId === projectId);
}

function projectHours(projectId) {
  return entriesOf(projectId).reduce((sum, e) => sum + (Number(e.hours) || 0), 0);
}

function projectCompensation(project) {
  if (project.billingType === 'flat') return Number(project.flatAmount) || 0;
  const rate = project.hourlyRate != null && project.hourlyRate !== '' ? Number(project.hourlyRate) : Number(state.settings.hourlyRate);
  // Le sessioni a forfait valgono il loro importo fisso, le altre ore × tariffa.
  return entriesOf(project.id).reduce((sum, e) =>
    sum + (e.billingType === 'flat' ? (Number(e.amount) || 0) : (Number(e.hours) || 0) * rate), 0);
}

// Toggle helper for the "A ore / A forfait" segmented control inside project modals.
function projBilling(btn, bt) {
  const card = btn.closest('.modal-card');
  if (!card) return;
  $$('#f-billing button', card).forEach(b => b.setAttribute('aria-selected', String(b.dataset.bt === bt)));
  const rw = $('#f-rate-wrap', card), fw = $('#f-flat-wrap', card);
  if (rw) rw.classList.toggle('hidden', bt === 'flat');
  if (fw) fw.classList.toggle('hidden', bt !== 'flat');
}
// Date range [start,end] (inclusive, ISO) for the active period filter, or null for "all".
function periodRange() {
  const period = (state.filters && state.filters.period) || 'all';
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  if (period === 'current-month') {
    const mm = String(month + 1).padStart(2, '0');
    const dd = String(new Date(year, month + 1, 0).getDate()).padStart(2, '0');
    return { start: `${year}-${mm}-01`, end: `${year}-${mm}-${dd}` };
  }
  if (period === 'last-month') {
    const pm = month === 0 ? 11 : month - 1;
    const py = month === 0 ? year - 1 : year;
    const mm = String(pm + 1).padStart(2, '0');
    const dd = String(new Date(py, pm + 1, 0).getDate()).padStart(2, '0');
    return { start: `${py}-${mm}-01`, end: `${py}-${mm}-${dd}` };
  }
  if (period === 'current-year') {
    return { start: `${year}-01-01`, end: `${year}-12-31` };
  }
  if (period === 'custom') {
    const start = state.filters.startDate || '';
    const end = state.filters.endDate || '';
    if (!start && !end) return null;
    return { start: start || '0000-01-01', end: end || '9999-12-31' };
  }
  return null;
}

// A flat-fee project is "in scope" when it passes the current client/project filters
// AND its creation date falls within the active period: the forfait is billed once,
// in the month it was contracted.
function flatProjectInScope(p) {
  if (!p || p.billingType !== 'flat') return false;
  const f = state.filters || {};
  const projOk = !f.project || f.project === 'all' || f.project === p.id;
  const cliOk = !f.client || f.client === 'all' || f.client === p.clientId;
  if (!(projOk && cliOk)) return false;
  const range = periodRange();
  if (!range) return true;
  const d = String(p.createdAt || '');
  return d >= range.start && d <= range.end;
}

// Sum of flat-fee amounts for flat projects in the current filter scope.
function flatScopedTotal() {
  return state.projects.reduce((a, p) => a + (flatProjectInScope(p) ? (Number(p.flatAmount) || 0) : 0), 0);
}

function totalHours() {
  return getFilteredEntries().reduce((sum, e) => sum + (Number(e.hours) || 0), 0);
}

function totalCompensation() {
  const extra = Number(state.settings.extra) || 0;
  let baseSum = 0;
  for (const p of state.projects) {
    if (p.billingType === 'flat') {
      if (flatProjectInScope(p)) baseSum += Number(p.flatAmount) || 0;
    } else {
      baseSum += projectCompensation(p);
    }
  }
  return baseSum + (baseSum > 0 ? extra : 0);
}

/* ---------------------------------------------------------------------
   System Toasts & Theme control
--------------------------------------------------------------------- */
function toast(message, kind = 'ok') {
  const root = $('#toast-root');
  if (!root) return;
  const el = document.createElement('div');
  const themeClasses = 'bg-[#1d1d1f] dark:bg-zinc-800 text-white dark:text-zinc-100';
  el.className = `toast pointer-events-auto ${themeClasses} text-[13px] font-semibold px-4 py-2.5 rounded-full shadow-lg flex items-center gap-2 border border-white/5`;
  const dot = kind === 'error' ? '⚠️' : (kind === 'warning' ? '⚙️' : '✓');
  el.innerHTML = `<span>${dot}</span><span>${esc(message)}</span>`;
  root.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s ease, transform .25s ease';
    el.style.opacity = '0'; el.style.transform = 'translateY(8px)';
    setTimeout(() => el.remove(), 280);
  }, 2600);
}

function syncTheme(themeName) {
  const isDark = themeName === 'dark' || (themeName === 'auto' && typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.body.classList.toggle('dark', isDark);
}

// In modalità "auto" segue dal vivo il cambio chiaro/scuro del sistema operativo.
let _themeMql = null;
function bindAutoTheme() {
  if (!window.matchMedia) return;
  _themeMql = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => { if ((state.settings.theme || 'auto') === 'auto') syncTheme('auto'); };
  if (_themeMql.addEventListener) _themeMql.addEventListener('change', onChange);
  else if (_themeMql.addListener) _themeMql.addListener(onChange); // Safari datati
}

// Registra il service worker per PWA/offline. Path relativi: funziona sia sul
// dominio utente (itavix.github.io) sia in una sottocartella di GitHub Pages.
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol === 'file:') return; // niente SW in apertura locale
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW non registrato:', err));
  });
}

/* ---------------------------------------------------------------------
   Modal Manager
--------------------------------------------------------------------- */
function closeModal() {
  const root = $('#modal-root');
  if (root) root.innerHTML = '';
  document.body.style.overflow = '';
}

function openModal(opts) {
  const root = $('#modal-root');
  if (!root) return;
  document.body.style.overflow = 'hidden';
  const danger = opts.danger;
  root.innerHTML = `
    <div class="fixed inset-0 z-40 modal-backdrop flex items-end sm:items-center justify-center p-0 sm:p-4" id="m-backdrop">
      <div class="modal-card bg-white dark:bg-darkCard w-full sm:max-w-md rounded-t-xl2 sm:rounded-xl2 shadow-2xl overflow-hidden border border-black/5 dark:border-darkBorder">
        <div class="px-5 pt-5 pb-1">
          <h2 class="text-[17px] font-semibold tracking-tight dark:text-white">${esc(opts.title || '')}</h2>
        </div>
        <div class="px-5 py-3 dark:text-zinc-200 text-[14px]" id="m-body">${opts.bodyHTML || ''}</div>
        <div class="px-5 py-4 flex gap-2 justify-end border-t border-black/5 dark:border-darkBorder bg-gray-50 dark:bg-zinc-900/50">
          <button id="m-cancel" class="px-4 py-2 rounded-full text-[14px] font-semibold text-ink-soft dark:text-ink-faint hover:bg-black/5 dark:hover:bg-white/5 transition-soft">${esc(opts.cancelText || t('Annulla'))}</button>
          <button id="m-confirm" class="px-4 py-2 rounded-full text-[14px] font-bold text-white transition-soft ${danger ? 'bg-[#ff3b30] hover:bg-[#e0352b]' : 'bg-accent hover:bg-accent-hover'}">${esc(opts.confirmText || t('Salva'))}</button>
        </div>
      </div>
    </div>`;

  const backdrop = $('#m-backdrop');
  if (backdrop) {
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) closeModal(); });
  }
  const cancelBtn = $('#m-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', closeModal);

  const card = $('.modal-card', root);
  if (card && typeof opts.onMount === 'function') opts.onMount(card);
  
  const confirm = async () => {
    const ok = opts.onConfirm ? await opts.onConfirm(card) : true;
    if (ok !== false) closeModal();
  };
  
  const confirmBtn = $('#m-confirm');
  if (confirmBtn) confirmBtn.addEventListener('click', confirm);
  
  if (card) {
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'number' && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); confirm(); }
      if (e.key === 'Escape') closeModal();
      // Focus-trap: il Tab resta dentro al modale.
      if (e.key === 'Tab') {
        const focusables = $$('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])', card)
          .filter(el => !el.disabled && el.offsetParent !== null);
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });
    const first = $('input, textarea, select', card);
    if (first) setTimeout(() => first.focus(), 100);
  }
}

function showError(card, msg) {
  let box = $('#m-error', card);
  if (!box) {
    box = document.createElement('div');
    box.id = 'm-error';
    box.className = 'mt-3 text-[13px] text-[#ff3b30] bg-[#ff3b30]/8 rounded-lg px-3 py-2 font-medium';
    const mBody = $('#m-body', card);
    if (mBody) mBody.appendChild(box);
  }
  box.textContent = msg;
}

/* ---------------------------------------------------------------------
   SISTEMA DI ROUTING E ROUTER (SETVIEW & RENDER)
--------------------------------------------------------------------- */
function navScrollContainer() {
  const n = document.getElementById('nav');
  return n ? n.parentElement : null; // .seg-container
}
function updateNavFade() {
  const c = navScrollContainer();
  const fade = document.querySelector('.nav-fade');
  if (!c || !fade) return;
  const scrollable = c.scrollWidth > c.clientWidth + 2;
  const atEnd = c.scrollLeft + c.clientWidth >= c.scrollWidth - 2;
  fade.classList.toggle('hide', !scrollable || atEnd);
}
function scrollNavActiveIntoView() {
  const c = navScrollContainer();
  const active = document.querySelector('#nav button[aria-selected="true"]');
  if (!c || !active) return;
  const cRect = c.getBoundingClientRect();
  const aRect = active.getBoundingClientRect();
  const delta = (aRect.left - cRect.left) - (c.clientWidth - active.clientWidth) / 2;
  if (Math.abs(delta) > 4) c.scrollBy({ left: delta, behavior: 'smooth' });
}
function syncNavScroll() { scrollNavActiveIntoView(); updateNavFade(); }

// Viste riservate al Proprietario: un account Cliente non deve accedervi né
// vederne il tab (l'anagrafica Clienti contiene dati di altri committenti).
const OWNER_ONLY_VIEWS = ['clients', 'expenses', 'quotes'];

// Nasconde/mostra i tab riservati in base al ruolo corrente.
function applyRoleVisibility() {
  const client = isClient();
  OWNER_ONLY_VIEWS.forEach(v => {
    const tab = $('#nav button[data-view="' + v + '"]');
    if (tab) tab.classList.toggle('hidden', client);
  });
}

// Full app refresh: pull the latest version (update SW, clear caches when online), then reload.
// User data is safe — it lives in IndexedDB and on the cloud, not in the HTTP caches.
function hardRefresh() {
  openModal({
    title: t('Aggiornare l\'app?'),
    bodyHTML: `<p class="text-[14px]">${t('Ricarico HourFlow scaricando l\'ultima versione disponibile. I tuoi dati restano al sicuro: sono salvati in locale e sul cloud, non vengono toccati.')}</p>`,
    confirmText: t('Aggiorna ora'),
    onConfirm: async () => {
      try {
        if ('serviceWorker' in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map(r => r.update()));
        }
        if (window.caches && navigator.onLine !== false) {
          const keys = await caches.keys();
          await Promise.all(keys.map(k => caches.delete(k)));
        }
      } catch (e) { /* best-effort: reload anyway */ }
      location.reload();
    }
  });
}

// Pulizia tecnica della sincronizzazione — NON tocca i dati dell'app.
// Svuota la persistenza/cache di Firestore, le cache HTTP e il service worker,
// poi ricarica. Serve a sbloccare un client Firestore "ingolfato" (tipico iOS/iPadOS)
// senza perdere progetti, ore, clienti ecc. (restano in IndexedDB e sul cloud).
function confirmSyncReset() {
  openModal({
    title: t('Sbloccare la sincronizzazione?'),
    bodyHTML: `<p class="text-[14px]">${t('Svuoto la cache cloud e l\'app shell, poi ricarico l\'app. {b}: progetti, ore e clienti restano in locale e sul cloud. Potrebbe esserti richiesto di accedere di nuovo.', { b: `<span class="font-bold">${t('I tuoi dati non vengono toccati')}</span>` })}</p>`,
    confirmText: t('Sblocca e ricarica'),
    onConfirm: async () => { await runSyncReset(); }
  });
}

async function runSyncReset() {
  const online = navigator.onLine !== false;
  const withDeadline = (p, ms) => Promise.race([
    Promise.resolve(p),
    new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms))
  ]);

  // 1) Persistenza Firestore: termina il client e cancella SOLO il suo IndexedDB
  //    (clearPersistence non tocca il DB dell'app). Se il client e' ingolfato,
  //    terminate() va in timeout: in tal caso non riusciamo a pulire, quindi al
  //    prossimo avvio saltiamo proprio l'apertura della cache (flag hf_skip_persist).
  let persistCleared = false;
  try {
    if (sync.db) {
      await withDeadline(sync.db.terminate(), 4000);
      await withDeadline(sync.db.clearPersistence(), 4000);
      persistCleared = true;
    }
  } catch (_) { persistCleared = false; }

  try {
    if (persistCleared) localStorage.removeItem('hf_skip_persist'); // ripartiamo con cache pulita
    else localStorage.setItem('hf_skip_persist', '1');              // non riaprire la cache ingolfata
    sessionStorage.removeItem('hf_recovered');                      // riarma l'auto-ripristino
  } catch (_) {}

  // 2) Cache HTTP + service worker: solo online, per non lasciare l'app non
  //    avviabile offline (senza SW e senza cache non si caricherebbe).
  if (online) {
    try { const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k))); } catch (_) {}
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister()));
      }
    } catch (_) {}
  }

  try { location.reload(); } catch (_) {}
}

function setView(view) {
  // Blocco di sicurezza: un Cliente non può aprire viste riservate.
  if (isClient() && OWNER_ONLY_VIEWS.indexOf(view) !== -1) view = 'dashboard';
  state.view = view;
  if (view !== 'dashboard') {
    state.selectMode = false;
    state.selected.clear();
    document.body.classList.remove('has-selbar');
  }
  ['dashboard', 'payment', 'report', 'clients', 'expenses', 'quotes', 'settings', 'guide'].forEach(v => {
    const target = $('#view-' + v);
    if (target) target.classList.toggle('hidden', v !== view);
  });
  $$('#nav button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === view)));
  render();
  syncNavScroll();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Banner fisso per account con email non verificata: senza verifica un Cliente
// non può leggere i dati condivisi (regole Firestore) e il solo toast sparisce.
function renderVerifyBanner() {
  const root = $('#verify-banner-root');
  if (!root) return;
  const show = !!(sync.enabled && sync.user && !sync.user.emailVerified);
  if (!show) { root.innerHTML = ''; return; }
  root.innerHTML = `
    <div class="mb-5 rounded-xl2 border border-amber-500/40 bg-amber-500/10 px-4 py-3.5">
      <div class="flex items-start gap-2.5">
        <span class="text-[15px]">⚠️</span>
        <div class="flex-1 min-w-0">
          <div class="text-[13px] font-bold text-amber-700 dark:text-amber-400">${t('Email non verificata')}</div>
          <p class="text-[12px] text-ink-soft dark:text-zinc-400 mt-0.5">${t('Verifica {e} per usare i dati condivisi: invia l\'email, clicca il link che ricevi, poi torna qui e premi "Ho verificato".', { e: `<span class="font-semibold">${esc(sync.user.email || '')}</span>` })}</p>
          <div class="mt-2.5 flex flex-wrap gap-2">
            <button id="vb-send" class="px-3.5 py-1.5 rounded-full bg-amber-500 hover:bg-amber-600 text-white text-[12px] font-bold transition-soft">${t('Invia email di verifica')}</button>
            <button id="vb-recheck" class="px-3.5 py-1.5 rounded-full border border-amber-500/50 text-amber-700 dark:text-amber-400 hover:bg-amber-500/10 text-[12px] font-bold transition-soft">${t('Ho verificato')}</button>
          </div>
        </div>
      </div>
    </div>`;
  const send = $('#vb-send');
  if (send) send.addEventListener('click', doSendVerification);
  const re = $('#vb-recheck');
  if (re) re.addEventListener('click', recheckVerification);
}

// "Ho verificato": rilegge lo stato utente, rinnova il token (claim
// email_verified) e riparte nel ruolo giusto senza logout/login.
async function recheckVerification() {
  if (!sync.user) return;
  try { await sync.user.reload(); } catch (_) {}
  if (!sync.user.emailVerified) {
    toast(t('Email non ancora verificata: clicca il link ricevuto e riprova'), 'warning');
    return;
  }
  try { await sync.user.getIdToken(true); } catch (_) {}
  toast(t('Email verificata ✓'));
  if (isClient()) {
    attachClientStatementByEmail();
  } else if (await probeClientByLinks()) {
    await adoptClientRole(); // account cliente rimasto col ruolo sbagliato
  }
  render();
}

function render() {
  // Se il ruolo Cliente arriva mentre si è su una vista riservata, si reindirizza.
  if (isClient() && OWNER_ONLY_VIEWS.indexOf(state.view) !== -1) { setView('dashboard'); return; }
  applyRoleVisibility();
  updateUserBadge();
  renderVerifyBanner();
  ensureTimerTicking(); // riattiva il ciclo orologio se un timer è stato ripristinato

  try {
    if (state.view === 'dashboard') renderDashboard();
    else if (state.view === 'payment') renderPayment();
    else if (state.view === 'report') renderReports();
    else if (state.view === 'clients') renderClients();
    else if (state.view === 'expenses') renderExpenses();
    else if (state.view === 'quotes') renderQuotes();
    else if (state.view === 'settings') renderSettings();
    else if (state.view === 'guide') renderGuide();
  } catch (err) {
    const msg = (err && err.message ? err.message : String(err)) +
      (err && err.stack ? '\n' + String(err.stack).split('\n').slice(0, 4).join('\n') : '');
    if (window.__hfShowFatal) window.__hfShowFatal(msg); else throw err;
  }
}

/* ---------------------------------------------------------------------
   DASHBOARD / CONTROLLI FILTRI / ANALYTICS
--------------------------------------------------------------------- */
function buildFilterWidgetHTML() {
  const p = state.filters;
  const projectOptions = state.projects.map(proj => 
    `<option value="${proj.id}" ${p.project === proj.id ? 'selected' : ''}>${esc(proj.name)}</option>`
  ).join('');

  // Con il filtro "Stato pagamento" attivo, una riga riassume cosa si sta guardando.
  let payHint = '';
  if (p.payment === 'unpaid' || p.payment === 'paid') {
    const shownIds = new Set(getFilteredEntries().map(e => e.id));
    const rows = allEntriesFlat().filter(e => shownIds.has(e.id));
    const h = rows.reduce((a, e) => a + (Number(e.hours) || 0), 0);
    const v = rows.reduce((a, e) => a + entryValue(e), 0);
    const label = p.payment === 'unpaid'
      ? plural(rows.length, t('sessione ancora da pagare'), t('sessioni ancora da pagare'))
      : plural(rows.length, t('sessione già pagata'), t('sessioni già pagate'));
    const tone = p.payment === 'unpaid' ? 'text-accent' : 'text-emerald-600 dark:text-emerald-400';
    payHint = `<p class="text-[11px] font-semibold ${tone} mt-3">${esc(label)} · ${esc(hrs(h))} · ${esc(eur(v))}</p>`;
  }

  return `
    <div class="bg-white dark:bg-darkCard rounded-xl2 border border-black/5 dark:border-darkBorder p-4 shadow-sm mb-6">
      <div class="flex items-center justify-between mb-3">
        <h3 class="text-[12px] font-bold uppercase tracking-wider text-ink-faint dark:text-zinc-500">${t('Filtri di Visualizzazione')}</h3>
        <button id="btn-reset-filters" class="text-[12px] font-semibold text-accent hover:underline">${t('Svuota filtri')}</button>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <label for="filt-period" class="block text-[11px] font-semibold text-ink-soft dark:text-zinc-400 mb-1">${t('Periodo temporale')}</label>
          <select id="filt-period" class="field py-1.5 px-2.5 text-[13px]">
            <option value="all" ${p.period === 'all' ? 'selected' : ''}>${t('Tutto lo storico')}</option>
            <option value="current-month" ${p.period === 'current-month' ? 'selected' : ''}>${t('Mese corrente')}</option>
            <option value="last-month" ${p.period === 'last-month' ? 'selected' : ''}>${t('Mese precedente')}</option>
            <option value="current-year" ${p.period === 'current-year' ? 'selected' : ''}>${t('Anno corrente')}</option>
            <option value="custom" ${p.period === 'custom' ? 'selected' : ''}>${t('Intervallo personalizzato…')}</option>
          </select>
        </div>
        <div>
          <label for="filt-project" class="block text-[11px] font-semibold text-ink-soft dark:text-zinc-400 mb-1">${t('Filtra Progetto')}</label>
          <select id="filt-project" class="field py-1.5 px-2.5 text-[13px]">
            <option value="all" ${p.project === 'all' ? 'selected' : ''}>${t('Tutti i progetti')}</option>
            ${projectOptions}
          </select>
        </div>
        <div>
          <label for="filt-payment" class="block text-[11px] font-semibold text-ink-soft dark:text-zinc-400 mb-1">${t('Stato pagamento')}</label>
          <select id="filt-payment" class="field py-1.5 px-2.5 text-[13px]">
            <option value="all" ${(p.payment || 'all') === 'all' ? 'selected' : ''}>${t('Tutte le sessioni')}</option>
            <option value="unpaid" ${p.payment === 'unpaid' ? 'selected' : ''}>${t('Solo da pagare')}</option>
            <option value="paid" ${p.payment === 'paid' ? 'selected' : ''}>${t('Solo già pagate')}</option>
          </select>
        </div>
        <div id="custom-date-container" class="${p.period === 'custom' ? '' : 'hidden'} col-span-1 grid grid-cols-2 gap-2">
          <div>
            <label for="filt-start" class="block text-[11px] font-semibold text-ink-soft dark:text-zinc-400 mb-1">${t('Dal')}</label>
            <input id="filt-start" type="date" class="field py-1.5 px-2 text-[12px]" value="${p.startDate}" />
          </div>
          <div>
            <label for="filt-end" class="block text-[11px] font-semibold text-ink-soft dark:text-zinc-400 mb-1">${t('Al')}</label>
            <input id="filt-end" type="date" class="field py-1.5 px-2 text-[12px]" value="${p.endDate}" />
          </div>
        </div>
      </div>
      ${payHint}
    </div>`;
}

function renderDashboard() {
  const root = $('#view-dashboard');
  if (!root) return;

  // I KPI usano lo stesso modello della Nota: ore e residuo escludono le
  // sessioni "già pagata" e scalano gli acconti registrati, così dashboard
  // e Nota di Pagamento mostrano sempre gli stessi numeri.
  const m = buildNoteModel();

  const filterWidget = buildFilterWidgetHTML();
  const chartHtml = buildVisualAnalyticsChart();

  // Stesse cifre, prospettiva diversa: il Proprietario incassa, il Cliente paga.
  const client = isClient();
  const summary = `
    <div class="grid grid-cols-3 gap-3 mb-6">
      ${summaryCard(client ? t('Ore da pagare') : t('Ore da incassare'), hrs(m.tH), 'text-ink dark:text-white')}
      ${summaryCard(t('Ore totali'), hrs(totalHours()), 'text-ink dark:text-white')}
      ${summaryCard(t('Residuo'), eur(Math.max(0, m.residual)), 'text-accent', m.paid > 0 ? `${client ? t('già pagato') : t('già incassato')} ${eur(m.paid)}` : '')}
    </div>
    ${filterWidget}
    ${buildStopwatchWidgetHTML()}
    ${chartHtml}`;

  let projectsHTML;
  const editable = canEdit();
  const q = (state.search || '').trim().toLowerCase();
  const visibleProjects = dashboardVisibleProjects();

  // La selezione vale solo per le sessioni a schermo: cambiando filtri o ricerca
  // non si possono segnare per errore sessioni che non si stanno guardando.
  if (!editable) state.selectMode = false;
  const selecting = state.selectMode;
  const selectable = selectableEntryIds(visibleProjects);
  if (!selecting) state.selected.clear();
  for (const id of [...state.selected]) if (!selectable.has(id)) state.selected.delete(id);
  document.body.classList.toggle('has-selbar', selecting);

  if (!visibleProjects.length) {
    projectsHTML = `
      <div class="bg-white dark:bg-darkCard rounded-xl2 border border-black/5 dark:border-darkBorder px-6 py-12 text-center shadow-sm">
        <div class="text-3xl mb-3">🗂️</div>
        <p class="text-ink-soft dark:text-ink-faint text-[15px] font-medium">${q ? t('Nessun risultato per la ricerca.') : (state.filters.payment === 'unpaid' ? t('Nessuna attività ancora da pagare con questi filtri.') : (state.filters.payment === 'paid' ? t('Nessuna attività già pagata con questi filtri.') : t('Nessun progetto corrispondente.')))}</p>
      </div>`;
  } else {
    projectsHTML = `<div class="space-y-3" id="projects-list-container">${visibleProjects.map(projectCard).join('')}</div>`;
  }

  const searchHTML = state.projects.length ? `
    <div class="relative mb-3">
      <svg class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
      <input id="dash-search" type="text" value="${esc(state.search || '')}" placeholder="${esc(t('Cerca progetti o attività…'))}" autocomplete="off" class="field py-2 text-[13px]" style="padding-left:2.5rem" />
    </div>` : '';

  root.innerHTML = `
    ${summary}
    <div class="flex items-center justify-between mb-3 mt-6">
      <h2 class="text-[13px] font-bold uppercase tracking-wider text-ink-faint dark:text-zinc-500">${t('I tuoi Progetti')}</h2>
      <div class="flex items-center gap-2">
        ${editable && state.projects.length ? `<button id="dash-select" type="button" aria-pressed="${selecting}" title="${esc(t('Seleziona più sessioni per segnarle come pagate'))}" class="text-[13px] font-bold rounded-full px-3 py-1 transition-soft ${selecting ? 'bg-accent text-white hover:bg-accent-hover' : 'text-ink-soft dark:text-zinc-300 hover:bg-black/5 dark:hover:bg-white/5'}">${selecting ? t('Fine') : t('Seleziona')}</button>` : ''}
        <button id="dash-refresh" title="${esc(t('Aggiorna i dati'))}" aria-label="${esc(t('Aggiorna i dati'))}" class="w-8 h-8 rounded-full hover:bg-black/5 dark:hover:bg-white/5 flex items-center justify-center text-ink-soft dark:text-ink-faint transition-soft">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v5h-5"/></svg>
        </button>
        ${editable ? `<button id="add-project" class="text-[14px] font-bold text-accent hover:text-accent-hover transition-soft flex items-center gap-1">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15"/></svg>
          ${t('Nuovo progetto')}
        </button>` : ''}
      </div>
    </div>
    ${searchHTML}
    ${projectsHTML}
    ${selecting ? selectionBarHTML(selectable) : ''}`;

  // Lo stato "misto" di una checkbox non si esprime in HTML: va impostato via JS.
  $$('input[data-indeterminate="1"]', root).forEach(el => { el.indeterminate = true; });

  bindDashboardEvents(root);

  const selBtn = $('#dash-select', root);
  if (selBtn) selBtn.addEventListener('click', () => {
    state.selectMode = !state.selectMode;
    state.selected.clear();
    renderDashboard();
  });

  const refreshBtn = $('#dash-refresh', root);
  if (refreshBtn) refreshBtn.addEventListener('click', async () => {
    const ic = refreshBtn.querySelector('svg');
    if (ic) ic.classList.add('animate-spin');
    try { await forceRefresh(); } finally { if (ic) setTimeout(() => ic.classList.remove('animate-spin'), 500); }
  });

  const searchEl = $('#dash-search', root);
  if (searchEl) {
    // Debounce the expensive re-render: the input updates natively while typing,
    // and the (heavy) list/results rebuild only once the user pauses.
    const runSearch = debounce(() => {
      const live = document.getElementById('dash-search');
      const pos = live ? live.selectionStart : null;
      renderDashboard();
      const again = document.getElementById('dash-search');
      if (again) { again.focus(); try { if (pos != null) again.setSelectionRange(pos, pos); } catch (_) {} }
    }, 180);
    searchEl.addEventListener('input', () => { state.search = searchEl.value; runSearch(); });
  }
}

// Progetti mostrati in Dashboard: filtro progetto, "Stato pagamento" e ricerca.
function dashboardVisibleProjects() {
  const q = (state.search || '').trim().toLowerCase();
  let visible = state.filters.project === 'all'
    ? state.projects
    : state.projects.filter(p => p.id === state.filters.project);
  // Con "Stato pagamento" attivo restano solo i progetti che hanno davvero
  // qualcosa da mostrare. Eccezione sotto "Solo da pagare": i progetti a forfait
  // restano in elenco perché il loro importo non ha il flag "pagata" ed è dovuto.
  if (state.filters.payment === 'unpaid' || state.filters.payment === 'paid') {
    const keepFlat = state.filters.payment === 'unpaid';
    visible = visible.filter(p =>
      entriesOf(p.id).length > 0 || (keepFlat && flatProjectInScope(p)));
  }
  if (q) {
    visible = visible.filter(p =>
      String(p.name || '').toLowerCase().includes(q) ||
      state.entries.some(e => e.projectId === p.id && String(e.spec || '').toLowerCase().includes(q))
    );
  }
  return visible;
}

// Id delle sessioni selezionabili: quelle elencate nei progetti visibili.
function selectableEntryIds(visibleProjects) {
  const ids = new Set();
  for (const p of visibleProjects || dashboardVisibleProjects()) {
    for (const e of entriesOf(p.id)) ids.add(e.id);
  }
  return ids;
}

// Barra fissa in basso con il riepilogo della selezione e le azioni di massa.
function selectionBarHTML(selectable) {
  const rows = allEntriesFlat().filter(e => state.selected.has(e.id));
  const n = rows.length;
  const h = rows.reduce((a, e) => a + (Number(e.hours) || 0), 0);
  const v = rows.reduce((a, e) => a + entryValue(e), 0);
  const all = selectable.size > 0 && n === selectable.size;
  const summary = n
    ? `${esc(plural(n, t('sessione selezionata'), t('sessioni selezionate')))} <span class="font-medium text-zinc-400">· ${esc(hrs(h))} · ${esc(eur(v))}</span>`
    : esc(t('Tocca le sessioni da selezionare'));
  return `
    <div style="height:7.5rem" aria-hidden="true"></div>
    <div id="sel-bar" class="sel-bar no-print" role="region" aria-label="${esc(t('Azioni sulle sessioni selezionate'))}">
      <div class="sel-bar-card">
        <div class="flex items-center justify-between gap-3">
          <div class="text-[13px] font-bold tabular-nums min-w-0 truncate" aria-live="polite">${summary}</div>
          <button type="button" data-action="select-all" ${selectable.size ? '' : 'disabled'} class="sel-link shrink-0 text-[12px] font-bold text-accent">${all ? t('Deseleziona tutte') : t('Seleziona tutte ({n})', { n: selectable.size })}</button>
        </div>
        <div class="mt-2.5 flex items-center gap-2">
          <button type="button" data-action="bulk-paid" ${n ? '' : 'disabled'} class="sel-btn sel-btn-paid flex-1">✓ ${t('Segna come pagate')}</button>
          <button type="button" data-action="bulk-unpaid" ${n ? '' : 'disabled'} class="sel-btn sel-btn-ghost flex-1">${t('Segna da pagare')}</button>
        </div>
      </div>
    </div>`;
}

function summaryCard(label, value, valueClass, sub) {
  return `
    <div class="bg-white dark:bg-darkCard rounded-xl2 border border-black/5 dark:border-darkBorder px-3 py-3.5 sm:px-4 sm:py-4 shadow-sm flex flex-col justify-between overflow-hidden">
      <div class="text-[9px] sm:text-[10px] font-bold uppercase tracking-wider text-ink-faint dark:text-zinc-500 truncate">${esc(label)}</div>
      <div class="mt-1.5 text-[16px] sm:text-[20px] font-extrabold tracking-tight ${valueClass} leading-tight tabular-nums truncate">${esc(value)}</div>
      ${sub ? `<div class="text-[9px] font-medium text-ink-faint dark:text-zinc-500 mt-1 truncate">${esc(sub)}</div>` : ''}
    </div>`;
}

function buildVisualAnalyticsChart() {
  const filtered = getFilteredEntries();
  if (state.projects.length === 0 || filtered.length === 0 || totalHours() === 0) return '';
  
  const maxCompensation = Math.max(...state.projects.map(p => projectCompensation(p)), 1);
  
  const bars = state.projects.map((p, index) => {
    const comp = projectCompensation(p);
    const hr = projectHours(p.id);
    if (hr === 0 && comp === 0) return ''; // un progetto di soli forfait ha 0 ore ma un valore

    const percentage = (comp / maxCompensation) * 100;
    const colors = ['bg-accent', 'bg-blue-500', 'bg-emerald-500', 'bg-purple-500', 'bg-indigo-500'];
    const activeColor = colors[index % colors.length];
    
    return `
      <div class="flex flex-col items-center flex-1 min-w-[60px]">
        <div class="relative w-8 bg-gray-100 dark:bg-zinc-800 rounded-lg h-24 flex items-end overflow-hidden group">
          <div class="${activeColor} w-full transition-all duration-500 rounded-b-lg" style="height: ${percentage}%">
            <div class="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 bg-zinc-900 text-white text-[10px] font-semibold py-1 px-2 rounded opacity-0 group-hover:opacity-100 pointer-events-none transition-soft whitespace-nowrap z-10 shadow-md">
              ${esc(p.name)}: ${hrs(hr)} (${eur(comp)})
            </div>
          </div>
        </div>
        <div class="text-[10px] font-semibold text-ink-soft dark:text-zinc-400 mt-2 truncate w-full text-center" title="${esc(p.name)}">${esc(p.name)}</div>
        <div class="text-[9px] font-bold text-ink-faint tabular-nums">${eur(comp)}</div>
      </div>
    `;
  }).join('');

  return `
    <div class="bg-white dark:bg-darkCard p-5 rounded-xl2 border border-black/5 dark:border-darkBorder shadow-sm mb-6">
      <h3 class="text-[11px] font-bold uppercase tracking-wider text-ink-faint dark:text-zinc-500 mb-4">${t('Ripartizione Finanziaria Periodo')}</h3>
      <div class="flex items-end justify-between gap-4 overflow-x-auto py-2">
        ${bars || `<div class="text-center w-full py-4 text-ink-faint text-[12px]">${t('Nessun dato finanziario per il filtro selezionato.')}</div>`}
      </div>
    </div>`;
}

function projectCard(p) {
  const open = state.expanded.has(p.id);
  const items = entriesOf(p.id);
  const pHours = projectHours(p.id);
  const isFlat = p.billingType === 'flat';
  const pRate = p.hourlyRate != null && p.hourlyRate !== '' ? Number(p.hourlyRate) : Number(state.settings.hourlyRate);
  const pComp = projectCompensation(p);
  const editable = canEdit();

  const client = state.clients.find(c => c.id === p.clientId);
  const clientName = client ? client.name : '';

  // Modalità selezione: ogni riga diventa un'etichetta con checkbox (tap ovunque
  // sulla riga) e le azioni singole spariscono, per non mescolare i due gesti.
  const selecting = editable && state.selectMode;
  const selCount = selecting ? items.filter(e => state.selected.has(e.id)).length : 0;
  const rowTag = selecting ? 'label' : 'div';

  const itemsHTML = items.length
    ? items.map(e => `
        <${rowTag} class="group flex items-center gap-3 px-4 py-3 border-t border-black/5 dark:border-white/5 ${selecting ? `cursor-pointer select-none ${state.selected.has(e.id) ? 'sel-row-on' : 'hover:bg-black/[.015] dark:hover:bg-white/[0.01]'}` : 'hover:bg-black/[0.01] dark:hover:bg-white/[0.005]'}">
          ${selecting ? `<input type="checkbox" data-action="select-entry" data-id="${e.id}" ${state.selected.has(e.id) ? 'checked' : ''} aria-label="${esc(t('Seleziona {s}', { s: e.spec || '' }))}" class="w-[18px] h-[18px] shrink-0 cursor-pointer" style="accent-color:#FF9500" />` : ''}
          <div class="flex-1 min-w-0">
            <div class="text-[14px] text-ink dark:text-zinc-200 truncate font-semibold">${esc(e.spec)}</div>
            <div class="text-[11px] text-ink-faint dark:text-zinc-500 mt-0.5 font-medium">${esc(dateIt(e.date))}${e.billingType === 'flat' ? ` · <span class="inline-block text-[10px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/30">${t('Forfait')}</span>` : ''}${e.paid ? ` · <span class="inline-block text-[10px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30">${t('✓ Pagata')}</span>` : ''}</div>
          </div>
          <div class="text-[13px] font-bold tabular-nums text-ink-soft dark:text-zinc-400 shrink-0 mr-1">${e.billingType === 'flat' ? esc(eur(e.amount)) : esc(hrs(e.hours))}</div>
          ${editable && !selecting ? `          <div class="flex items-center gap-1 shrink-0">
            <button data-action="toggle-paid" data-id="${e.id}" title="${e.paid ? t('Segna come da pagare') : t('Segna come pagata')}" aria-pressed="${e.paid ? 'true' : 'false'}" class="w-8 h-8 rounded-full hover:bg-emerald-500/10 transition-soft ${e.paid ? 'text-emerald-600 dark:text-emerald-400' : 'text-ink-faint'} flex items-center justify-center">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75l2.25 2.25 4.5-4.5M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
            </button>
            <button data-action="edit-entry" data-id="${e.id}" title="${esc(t('Modifica'))}" class="w-8 h-8 rounded-full hover:bg-black/5 dark:hover:bg-white/5 transition-soft text-ink-faint hover:text-ink dark:hover:text-white flex items-center justify-center">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10"/></svg>
            </button>
            <button data-action="del-entry" data-id="${e.id}" title="${esc(t('Elimina'))}" class="w-8 h-8 rounded-full hover:bg-red-500/10 transition-soft text-ink-faint hover:text-red-500 flex items-center justify-center">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"/></svg>
            </button>
          </div>` : ''}
        </${rowTag}>`).join('')
    : `<div class="px-4 py-5 border-t border-black/5 dark:border-white/5 text-center text-[13px] text-ink-faint font-medium">${editable ? t('Nessuna voce per questo filtro. Premi "+" per iniziare.') : t('Nessuna voce registrata.')}</div>`;

  return `
    <div class="bg-white dark:bg-darkCard rounded-xl2 border border-black/5 dark:border-darkBorder overflow-hidden shadow-sm">
      <div data-proj-id="${p.id}" role="button" tabindex="0" aria-expanded="${open}" aria-label="${esc(t('{p} — espandi o comprimi le sessioni', { p: p.name }))}" class="project-header-row flex items-center gap-3 px-4 py-3.5 cursor-pointer select-none hover:bg-black/[.015] dark:hover:bg-white/[0.01] transition-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent">
        ${selecting && items.length ? `<input type="checkbox" data-action="select-project" data-id="${p.id}" ${selCount === items.length ? 'checked' : ''} ${selCount > 0 && selCount < items.length ? 'data-indeterminate="1"' : ''} aria-label="${esc(t('Seleziona tutte le sessioni di {p}', { p: p.name }))}" class="w-[18px] h-[18px] shrink-0 cursor-pointer" style="accent-color:#FF9500" />` : ''}
        <span class="chev ${open ? 'open' : ''} text-ink-faint dark:text-zinc-600 text-[11px]">▶</span>
        <div class="flex-1 min-w-0">
          <div class="text-[15px] font-bold tracking-tight truncate dark:text-white">${esc(p.name)}</div>
          <div class="text-[11px] text-ink-faint dark:text-zinc-500 flex items-center gap-2 flex-wrap mt-0.5 font-medium">
            <span>${plural(items.length, t('sessione'), t('sessioni'))}</span>
            <span>·</span>
            <span class="font-bold text-accent">${esc(hrs(pHours))}</span>
            <span>·</span>
            <span>${isFlat ? `<span class="text-cyan-600 dark:text-cyan-400 font-bold">${t('Forfait')}</span>` : eur(pRate) + '/h'}</span>
            <span>·</span>
            <span class="font-semibold text-ink-soft dark:text-zinc-400">${eur(pComp)}</span>
            ${clientName ? `<span class="bg-black/5 dark:bg-white/5 px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider font-extrabold text-ink-soft dark:text-zinc-400">${esc(clientName)}</span>` : ''}
            ${selCount ? `<span class="text-accent font-bold">✓ ${esc(t('{n} selezionate', { n: selCount }))}</span>` : ''}
          </div>
        </div>
        ${editable && !selecting ? `        <div class="flex items-center gap-1">
          <button data-action="start-timer" data-id="${p.id}" title="${esc(t('Avvia sessione live'))}" class="w-8 h-8 rounded-full bg-accent/10 hover:bg-accent/20 text-accent transition-soft flex items-center justify-center">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
          </button>
          <button data-action="rename-project" data-id="${p.id}" title="${esc(t('Modifica dettagli'))}" class="w-8 h-8 rounded-full hover:bg-black/5 dark:hover:bg-white/5 transition-soft text-ink-faint hover:text-ink dark:hover:text-white flex items-center justify-center">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10"/></svg>
          </button>
          <button data-action="del-project" data-id="${p.id}" title="${esc(t('Elimina'))}" class="w-8 h-8 rounded-full hover:bg-red-500/10 transition-soft text-ink-faint hover:text-red-500 flex items-center justify-center">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
          </button>
        </div>` : ''}
      </div>
      ${open ? `
        <div>${itemsHTML}</div>
        ${editable && !selecting ? `<div class="px-4 py-3 border-t border-black/5 dark:border-white/5 flex items-center gap-3 bg-gray-50/50 dark:bg-zinc-900/10">
          <button data-action="add-entry-trigger" data-id="${p.id}" class="text-[13px] font-bold text-accent hover:text-accent-hover transition-soft flex items-center gap-1">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15"/></svg>
            ${t('Aggiungi voce manuale')}
          </button>
        </div>` : ''}` : ''}
    </div>`;
}

/* ---------------------------------------------------------------------
   GESTIONE EVENTI VELOCE (Event Delegation)
--------------------------------------------------------------------- */
function bindDashboardEvents(root) {
  const filtPeriod = $('#filt-period', root);
  const filtProject = $('#filt-project', root);
  const filtPayment = $('#filt-payment', root);
  const filtStart = $('#filt-start', root);
  const filtEnd = $('#filt-end', root);
  const btnReset = $('#btn-reset-filters', root);

  if (filtPeriod) filtPeriod.addEventListener('change', () => {
    state.filters.period = filtPeriod.value;
    $('#custom-date-container', root).classList.toggle('hidden', filtPeriod.value !== 'custom');
    renderDashboard();
  });

  if (filtProject) filtProject.addEventListener('change', () => {
    state.filters.project = filtProject.value;
    renderDashboard();
  });

  if (filtPayment) filtPayment.addEventListener('change', () => {
    state.filters.payment = filtPayment.value;
    renderDashboard();
  });

  if (filtStart) filtStart.addEventListener('change', () => {
    state.filters.startDate = filtStart.value;
    renderDashboard();
  });

  if (filtEnd) filtEnd.addEventListener('change', () => {
    state.filters.endDate = filtEnd.value;
    renderDashboard();
  });

  if (btnReset) btnReset.addEventListener('click', () => {
    state.filters = { period: 'all', startDate: '', endDate: '', project: 'all', payment: 'all' };
    state.expanded.clear(); // "svuota" riporta anche i progetti allo stato compresso
    renderDashboard();
  });

  const addProjBtn = $('#add-project', root);
  if (addProjBtn) addProjBtn.addEventListener('click', addProject);

  // La delega va agganciata UNA SOLA VOLTA al nodo persistente #view-dashboard:
  // renderDashboard() ne sostituisce solo l'innerHTML, quindi senza questa guardia
  // ogni render aggiungerebbe un nuovo listener (azioni eseguite più volte / toggle "bloccato").
  if (!root.dataset.delegated) {
    root.dataset.delegated = '1';

    const toggleProject = (id) => {
      if (!id) return;
      if (state.expanded.has(id)) state.expanded.delete(id);
      else state.expanded.add(id);
      renderDashboard();
    };

    root.addEventListener('click', (e) => {
      const actionBtn = e.target.closest('[data-action]');
      if (actionBtn) {
        e.stopPropagation();
        handleDashboardAction(actionBtn.dataset.action, actionBtn.dataset.id);
        return;
      }
      const headerRow = e.target.closest('.project-header-row');
      if (headerRow) toggleProject(headerRow.dataset.projId);
    });

    // Accessibilità da tastiera: Invio/Spazio sulle intestazioni progetto
    root.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      if (e.target.closest('[data-action]')) return;
      const headerRow = e.target.closest('.project-header-row');
      if (headerRow) { e.preventDefault(); toggleProject(headerRow.dataset.projId); }
    });
  }
}

function handleDashboardAction(action, id) {
  switch (action) {
    case 'start-timer':
      startProjectTimer(id);
      break;
    case 'rename-project':
      renameProject(id);
      break;
    case 'del-project':
      deleteProject(id);
      break;
    case 'add-entry-trigger':
      addEntry(id);
      break;
    case 'toggle-paid':
      togglePaidEntry(id);
      break;
    case 'select-entry':
      if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
      renderDashboard();
      refocusSelection('select-entry', id);
      break;
    case 'select-project': {
      const ids = entriesOf(id).map(e => e.id);
      const allOn = ids.length > 0 && ids.every(x => state.selected.has(x));
      ids.forEach(x => { if (allOn) state.selected.delete(x); else state.selected.add(x); });
      renderDashboard();
      refocusSelection('select-project', id);
      break;
    }
    case 'select-all': {
      const ids = selectableEntryIds();
      const allOn = ids.size > 0 && [...ids].every(x => state.selected.has(x));
      if (allOn) state.selected.clear(); else ids.forEach(x => state.selected.add(x));
      renderDashboard();
      break;
    }
    case 'bulk-paid':
      bulkSetPaid(true);
      break;
    case 'bulk-unpaid':
      bulkSetPaid(false);
      break;
    case 'edit-entry':
      editEntry(id);
      break;
    case 'del-entry':
      deleteEntry(id);
      break;
    case 'timer-pause':
      toggleTimerPause();
      break;
    case 'timer-stop':
      stopAndSaveTimer();
      break;
    case 'timer-discard':
      discardTimer();
      break;
  }
}

/* ---------------------------------------------------------------------
   CRONOMETRO / WORK MONITORING (Precision Updates)
--------------------------------------------------------------------- */
function buildStopwatchWidgetHTML() {
  if (!state.activeTimer) return '';
  const p = state.projects.find(x => x.id === state.activeTimer.projectId);
  const pName = p ? p.name : t('Progetto rimosso');
  const paused = state.activeTimer.paused;
  
  return `
    <div class="bg-red-500/10 dark:bg-red-500/20 rounded-xl2 border border-red-500/20 p-4 shadow-sm mb-6 flex flex-col md:flex-row items-center gap-4 justify-between">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-full bg-red-500/20 text-red-600 dark:text-red-400 flex items-center justify-center">
          <span class="w-2.5 h-2.5 rounded-full bg-red-600 dark:bg-red-400 pulse-dot"></span>
        </div>
        <div class="text-left">
          <div class="text-[10px] font-bold uppercase tracking-wider text-red-600 dark:text-red-400">${t('Cronometro Attivo')}</div>
          <div class="text-[15px] font-bold text-ink dark:text-white leading-tight">${esc(pName)}</div>
          <div class="text-[12px] text-ink-soft dark:text-zinc-400 mt-0.5">${esc(state.activeTimer.spec || t('(nessuna descrizione)'))}</div>
        </div>
      </div>
      <div class="flex items-center gap-3 w-full md:w-auto justify-end">
        <div class="text-[24px] font-bold font-mono tracking-wider tabular-nums text-red-600 dark:text-red-400 mr-2" id="widget-timer-clock">
          00:00:00
        </div>
        <button id="btn-timer-pause" data-action="timer-pause" class="px-4 py-2 rounded-full bg-white dark:bg-zinc-800 text-ink dark:text-white border border-black/10 dark:border-white/10 text-[13px] font-bold hover:bg-gray-50 dark:hover:bg-zinc-700 transition-soft">
          ${paused ? t('Riprendi') : t('Pausa')}
        </button>
        <button id="btn-timer-stop" data-action="timer-stop" class="px-4 py-2 rounded-full bg-red-600 hover:bg-red-700 text-white text-[13px] font-bold transition-soft shadow-sm">
          ${t('Salva ore')}
        </button>
        <button id="btn-timer-discard" data-action="timer-discard" class="p-2 rounded-full hover:bg-black/5 dark:hover:bg-white/5 text-ink-faint hover:text-red-500 transition-soft" title="${esc(t('Scarta'))}">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
        </button>
      </div>
    </div>`;
}

async function startProjectTimer(projectId) {
  if (!canEdit()) { toast(t('Account autorizzato in sola lettura'), 'error'); return; }
  if (state.activeTimer) {
    toast(t('Un altro timer è già attivo. Completa o scarta la sessione corrente.'), 'error');
    return;
  }
  const p = state.projects.find(x => x.id === projectId);
  if (!p) return;

  openModal({
    title: t('Inizia Sessione di Lavoro'),
    bodyHTML: `
      <p class="text-[13px] text-ink-soft dark:text-zinc-400 mb-3">${t('Verrà registrato il tempo effettivo per il progetto: {p}.', { p: `<span class="font-bold text-ink dark:text-white">${esc(p.name)}</span>` })}</p>
      <label for="f-timer-spec" class="block text-[13px] font-semibold text-ink-soft mb-1.5">${t('Cosa stai facendo? (Descrizione attività)')}</label>
      <input id="f-timer-spec" class="field" placeholder="${esc(t('Es. Refactoring API, stesura documentazione'))}" />
    `,
    confirmText: t('Avvia Cronometro'),
    onConfirm: async (card) => {
      const spec = $('#f-timer-spec', card).value.trim();
      const timerObj = {
        id: 'current',
        projectId,
        spec: spec || t('Attività generica'),
        startTime: Date.now(),
        paused: false,
        elapsedBeforePause: 0
      };
      state.activeTimer = timerObj;
      await dbPut('timer', timerObj);
      ensureTimerTicking();
      renderDashboard();
      toast(t('Timer avviato correttamente'));
    }
  });
}

async function toggleTimerPause() {
  if (!state.activeTimer) return;
  if (state.activeTimer.paused) {
    state.activeTimer.paused = false;
    state.activeTimer.startTime = Date.now();
  } else {
    state.activeTimer.paused = true;
    state.activeTimer.elapsedBeforePause += Date.now() - state.activeTimer.startTime;
  }
  await dbPut('timer', state.activeTimer);
  renderDashboard();
}

// Round billable hours UP to the nearest increment (minutes). 0 = no rounding.
// L'epsilon evita che un multiplo esatto dello step venga gonfiato di uno scatto
// dai float (es. 0.2/0.1 → 2.0000000000000004 → ceil 3: 12 minuti fatturati 18).
function roundUpHours(h, incMinutes) {
  const inc = Number(incMinutes) || 0;
  if (inc <= 0) return h;
  const step = inc / 60;
  return Math.round(Math.ceil(h / step - 1e-9) * step * 100) / 100;
}

async function stopAndSaveTimer() {
  if (!state.activeTimer) return;
  
  let totalElapsedMs = state.activeTimer.elapsedBeforePause;
  if (!state.activeTimer.paused) {
    totalElapsedMs += Date.now() - state.activeTimer.startTime;
  }
  
  const rawHours = Math.max(0.1, Math.round((totalElapsedMs / 3600000) * 100) / 100);
  const calculatedHours = roundUpHours(rawHours, Number(state.settings.roundingMinutes) || 0);
  const projectId = state.activeTimer.projectId;
  const spec = state.activeTimer.spec;

  openModal({
    title: t('Termina e Salva Sessione'),
    bodyHTML: `
      <p class="text-[14px] mb-3">${t('Tempo rilevato: {h}', { h: `<span class="font-bold">${rawHours} h</span>` })}${calculatedHours !== rawHours ? ` · ${t('arrotondato a {h}', { h: `<span class="font-bold text-accent">${calculatedHours} h</span>` })}` : ''}. ${t('Registrare questa riga sul progetto?')}</p>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label for="f-final-date" class="block text-[13px] font-semibold text-ink-soft mb-1.5">${t('Data')}</label>
          <input id="f-final-date" type="date" class="field" value="${todayIso()}" />
        </div>
        <div>
          <label for="f-final-hours" class="block text-[13px] font-semibold text-ink-soft mb-1.5">${t('Ore da registrare')}</label>
          <input id="f-final-hours" type="number" min="0" step="0.05" class="field" value="${calculatedHours}" />
        </div>
      </div>
    `,
    confirmText: t('Registra Sessione'),
    onConfirm: async (card) => {
      const date = $('#f-final-date', card).value;
      const hours = Number($('#f-final-hours', card).value);
      if (hours <= 0 || isNaN(hours)) { showError(card, t('Specificare un valore di ore maggiore di 0.')); return false; }
      
      const newEntry = {
        id: genId(),
        projectId,
        spec,
        date: date || todayIso(),
        hours
      };
      
      await dbPut('entries', newEntry);
      await dbDel('timer', 'current');
      
      state.entries.push(newEntry);
      state.entries.sort((a, b) => String(a.date).localeCompare(String(b.date)));
      state.activeTimer = null;
      
      renderDashboard();
      cloudPush();
      toast(t('Sessione registrata correttamente'));
    }
  });
}

async function discardTimer() {
  openModal({
    title: t('Annullare la sessione?'),
    danger: true,
    bodyHTML: `<p class="text-[14px] text-ink-soft dark:text-zinc-400">${t('Tutti i progressi temporali accumulati in questa sessione verranno cancellati.')}</p>`,
    confirmText: t('Elimina sessione'),
    onConfirm: async () => {
      await dbDel('timer', 'current');
      state.activeTimer = null;
      renderDashboard();
      toast(t('Timer rimosso'));
    }
  });
}

/* ---------------------------------------------------------------------
   HIGH-PERFORMANCE TARGETED TIMER WRITER
   Aggiorna direttamente i nodi interessati senza toccare il DOM circostante.
--------------------------------------------------------------------- */
let _lastTickTime = 0;
let _timerInterval = null;

// Il ciclo a 500ms gira SOLO con un timer attivo: senza timer l'interval si
// auto-spegne (batteria/CPU su mobile) e riparte da ensureTimerTicking().
function ensureTimerTicking() {
  if (state.activeTimer && !_timerInterval) {
    _timerInterval = setInterval(updateTimerUI, 500);
  }
}

function updateTimerUI() {
  if (!state.activeTimer) {
    const navWidget = $('#nav-timer-widget');
    if (navWidget) navWidget.classList.add('hidden');
    document.title = "HourFlow";
    if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
    return;
  }
  
  let elapsedMs = state.activeTimer.elapsedBeforePause;
  if (!state.activeTimer.paused) {
    elapsedMs += Date.now() - state.activeTimer.startTime;
  }
  
  const totalSecs = Math.floor(elapsedMs / 1000);
  const hrsNum = Math.floor(totalSecs / 3600);
  const minsNum = Math.floor((totalSecs % 3600) / 60);
  const secsNum = totalSecs % 60;
  
  const pad = (x) => String(x).padStart(2, '0');
  const clockString = `${pad(hrsNum)}:${pad(minsNum)}:${pad(secsNum)}`;
  
  if (totalSecs !== _lastTickTime) {
    document.title = `⏱️ [${clockString}] HourFlow`;
    _lastTickTime = totalSecs;
  }
  
  const navWidget = $('#nav-timer-widget');
  const navClock = $('#nav-timer-clock');
  if (navWidget && navClock) {
    navWidget.classList.remove('hidden');
    navClock.innerText = clockString;
  }
  
  const widgetClock = $('#widget-timer-clock');
  if (widgetClock) {
    widgetClock.innerText = clockString;
  }
}

/* Gestione risparmio energetico se la pagina non è visibile */
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === 'visible') {
    ensureTimerTicking();
    updateTimerUI();
  }
});

/* ---------------------------------------------------------------------
   PROJECTS & CRUD DELLE SESSIONI
--------------------------------------------------------------------- */
function addProject(preClientId) {
  if (!canEdit()) { toast(t('Account autorizzato in sola lettura'), 'error'); return; }
  
  const clientOptions = state.clients.map(c => 
    `<option value="${c.id}" ${preClientId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`
  ).join('');

  openModal({
    title: t('Aggiungi Nuovo Progetto'),
    bodyHTML: `
      <label for="f-name" class="block text-[13px] font-semibold text-ink-soft mb-1.5">${t('Nome identificativo')}</label>
      <input id="f-name" class="field mb-3" placeholder="${esc(t('Es. App Mobile BrickBoy'))}" />
      
      <label class="block text-[13px] font-semibold text-ink-soft mb-1.5">${t('Tipo di compenso')}</label>
      <div class="seg gap-0 text-[13px] font-semibold mb-3" id="f-billing">
        <button type="button" data-bt="hourly" aria-selected="true" onclick="projBilling(this,'hourly')" class="flex-1 py-2">${t('A ore')}</button>
        <button type="button" data-bt="flat" aria-selected="false" onclick="projBilling(this,'flat')" class="flex-1 py-2">${t('A forfait')}</button>
      </div>
      <div id="f-rate-wrap">
        <label for="f-rate" class="block text-[13px] font-semibold text-ink-soft mb-1.5">${t('Tariffa oraria dedicata (€/h)')} <span class="text-ink-faint">${t('(lascia vuoto per usare la globale)')}</span></label>
        <input id="f-rate" type="number" min="0" step="0.5" class="field mb-3" placeholder="${esc(t('Es. 35'))}" />
      </div>
      <div id="f-flat-wrap" class="hidden">
        <label for="f-flat" class="block text-[13px] font-semibold text-ink-soft mb-1.5">${t('Importo a forfait (€)')}</label>
        <input id="f-flat" type="number" min="0" step="1" class="field mb-1.5" placeholder="${esc(t('Es. 1500'))}" />
        <p class="text-[11px] text-ink-faint mb-3">${t('Le ore vengono comunque tracciate, ma la fatturazione usa l\'importo fisso.')}</p>
      </div>

      <label for="f-client-select" class="block text-[13px] font-semibold text-ink-soft mb-1.5">${t('Associa Cliente')}</label>
      <select id="f-client-select" class="field mb-3">
        <option value="">${t('-- Nessun Cliente Associato --')}</option>
        ${clientOptions}
        <option value="__NEW__" class="text-accent font-bold">${t('+ Crea Nuovo Cliente…')}</option>
      </select>

      <div id="new-client-inline-form" class="hidden border border-black/5 dark:border-white/5 rounded-xl p-3 bg-black/[0.01] dark:bg-white/[0.01] mb-3">
        <h4 class="text-[12px] font-bold uppercase tracking-wider text-accent mb-2">${t('Nuova Anagrafica Rapida')}</h4>
        <input id="f-new-client-name" class="field text-[13px] py-1.5 mb-2" placeholder="${esc(t('Nome / Denominazione Cliente'))}" />
        <input id="f-new-client-vat" class="field text-[13px] py-1.5 mb-2" placeholder="${esc(t('P.IVA / CF (opzionale)'))}" />
        <textarea id="f-new-client-address" class="field text-[13px] py-1.5 h-12 resize-none" placeholder="${esc(t('Indirizzo Sede (opzionale)'))}"></textarea>
      </div>
    `,
    onMount: (card) => {
      const select = $('#f-client-select', card);
      const inlineForm = $('#new-client-inline-form', card);
      if (select && inlineForm) {
        select.addEventListener('change', () => {
          inlineForm.classList.toggle('hidden', select.value !== '__NEW__');
        });
      }
    },
    confirmText: t('Crea Progetto'),
    onConfirm: async (card) => {
      const name = $('#f-name', card).value.trim();
      if (!name) { showError(card, t('Nome progetto obbligatorio.')); return false; }
      const customRate = $('#f-rate', card).value;
      const selectVal = $('#f-client-select', card).value;

      let clientId = null;
      if (selectVal === '__NEW__') {
        const inlineName = $('#f-new-client-name', card).value.trim();
        if (!inlineName) { showError(card, t('Specificare la denominazione per il nuovo cliente.')); return false; }
        
        const newClientObj = {
          id: genId(),
          name: inlineName,
          vatCode: $('#f-new-client-vat', card).value.trim(),
          address: $('#f-new-client-address', card).value.trim(),
          email: '',
          phone: ''
        };
        await dbPut('clients', newClientObj);
        state.clients.push(newClientObj);
        state.clients.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        clientId = newClientObj.id;
      } else if (selectVal) {
        clientId = selectVal;
      }
      
      const btSel = $('#f-billing button[aria-selected="true"]', card);
      const billingType = btSel ? btSel.dataset.bt : 'hourly';
      const flatAmount = Number($('#f-flat', card).value) || 0;
      if (billingType === 'flat' && flatAmount <= 0) { showError(card, t('Indica l\'importo a forfait.')); return false; }
      const p = { 
        id: genId(), 
        name, 
        createdAt: todayIso(),
        hourlyRate: customRate !== '' ? Number(customRate) : null,
        clientId,
        billingType,
        flatAmount: billingType === 'flat' ? flatAmount : 0
      };
      
      await dbPut('projects', p);
      state.projects.push(p);
      state.expanded.add(p.id);
      render();
      cloudPush();
      toast(t('Progetto configurato con successo'));
    }
  });
}

function renameProject(id) {
  if (!canEdit()) { toast(t('Account autorizzato in sola lettura'), 'error'); return; }
  const p = state.projects.find(x => x.id === id);
  if (!p) return;

  const clientOptions = state.clients.map(c => 
    `<option value="${c.id}" ${p.clientId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`
  ).join('');

  openModal({
    title: t('Modifica Dettagli Progetto'),
    bodyHTML: `
      <label for="f-name" class="block text-[13px] font-semibold text-ink-soft mb-1.5">${t('Nome identificativo')}</label>
      <input id="f-name" class="field mb-3" value="${esc(p.name)}" />

      <label class="block text-[13px] font-semibold text-ink-soft mb-1.5">${t('Tipo di compenso')}</label>
      <div class="seg gap-0 text-[13px] font-semibold mb-3" id="f-billing">
        <button type="button" data-bt="hourly" aria-selected="${(p.billingType||'hourly')!=='flat'}" onclick="projBilling(this,'hourly')" class="flex-1 py-2">${t('A ore')}</button>
        <button type="button" data-bt="flat" aria-selected="${(p.billingType||'hourly')==='flat'}" onclick="projBilling(this,'flat')" class="flex-1 py-2">${t('A forfait')}</button>
      </div>
      <div id="f-rate-wrap" class="${(p.billingType||'hourly')==='flat'?'hidden':''}">
        <label for="f-rate" class="block text-[13px] font-semibold text-ink-soft mb-1.5">${t('Tariffa oraria dedicata (€/h)')}</label>
        <input id="f-rate" type="number" min="0" step="0.5" class="field mb-3" value="${p.hourlyRate != null ? p.hourlyRate : ''}" />
      </div>
      <div id="f-flat-wrap" class="${(p.billingType||'hourly')==='flat'?'':'hidden'}">
        <label for="f-flat" class="block text-[13px] font-semibold text-ink-soft mb-1.5">${t('Importo a forfait (€)')}</label>
        <input id="f-flat" type="number" min="0" step="1" class="field mb-1.5" placeholder="${esc(t('Es. 1500'))}" value="${p.flatAmount != null ? p.flatAmount : ''}" />
        <p class="text-[11px] text-ink-faint mb-3">${t('Le ore vengono comunque tracciate, ma la fatturazione usa l\'importo fisso.')}</p>
      </div>

      <label for="f-client-select" class="block text-[13px] font-semibold text-ink-soft mb-1.5">${t('Associa Cliente')}</label>
      <select id="f-client-select" class="field mb-3">
        <option value="">${t('-- Nessun Cliente Associato --')}</option>
        ${clientOptions}
        <option value="__NEW__" class="text-accent font-bold">${t('+ Crea Nuovo Cliente…')}</option>
      </select>

      <div id="new-client-inline-form" class="hidden border border-black/5 dark:border-white/5 rounded-xl p-3 bg-black/[0.01] dark:bg-white/[0.01] mb-3">
        <h4 class="text-[12px] font-bold uppercase tracking-wider text-accent mb-2">${t('Nuova Anagrafica Rapida')}</h4>
        <input id="f-new-client-name" class="field text-[13px] py-1.5 mb-2" placeholder="${esc(t('Nome / Denominazione Cliente'))}" />
        <input id="f-new-client-vat" class="field text-[13px] py-1.5 mb-2" placeholder="${esc(t('P.IVA / CF (opzionale)'))}" />
        <textarea id="f-new-client-address" class="field text-[13px] py-1.5 h-12 resize-none" placeholder="${esc(t('Indirizzo Sede (opzionale)'))}"></textarea>
      </div>
    `,
    onMount: (card) => {
      const select = $('#f-client-select', card);
      const inlineForm = $('#new-client-inline-form', card);
      if (select && inlineForm) {
        select.addEventListener('change', () => {
          inlineForm.classList.toggle('hidden', select.value !== '__NEW__');
        });
      }
    },
    confirmText: t('Salva Modifiche'),
    onConfirm: async (card) => {
      const name = $('#f-name', card).value.trim();
      if (!name) { showError(card, t('Il nome non può essere vuoto.')); return false; }
      const customRate = $('#f-rate', card).value;
      const selectVal = $('#f-client-select', card).value;

      let clientId = null;
      if (selectVal === '__NEW__') {
        const inlineName = $('#f-new-client-name', card).value.trim();
        if (!inlineName) { showError(card, t('Specificare la denominazione per il nuovo cliente.')); return false; }
        
        const newClientObj = {
          id: genId(),
          name: inlineName,
          vatCode: $('#f-new-client-vat', card).value.trim(),
          address: $('#f-new-client-address', card).value.trim(),
          email: '',
          phone: ''
        };
        await dbPut('clients', newClientObj);
        state.clients.push(newClientObj);
        state.clients.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        clientId = newClientObj.id;
      } else if (selectVal) {
        clientId = selectVal;
      }

      p.name = name;
      p.hourlyRate = customRate !== '' ? Number(customRate) : null;
      p.clientId = clientId;
      const btSel = $('#f-billing button[aria-selected="true"]', card);
      const billingType = btSel ? btSel.dataset.bt : 'hourly';
      const flatAmount = Number($('#f-flat', card).value) || 0;
      if (billingType === 'flat' && flatAmount <= 0) { showError(card, t('Indica l\'importo a forfait.')); return false; }
      p.billingType = billingType;
      p.flatAmount = billingType === 'flat' ? flatAmount : 0;
      
      await dbPut('projects', p);
      renderDashboard();
      cloudPush();
      toast(t('Dati del progetto aggiornati'));
    }
  });
}

/* ---------------------------------------------------------------------
   SESSIONI: aggiunta manuale, modifica, eliminazione
--------------------------------------------------------------------- */
// Toggle "A ore / A forfait" nel modale sessione (stesso pattern di projBilling).
function entryBilling(btn, bt) {
  const card = btn.closest('.modal-card');
  if (!card) return;
  $$('#f-ebilling button', card).forEach(b => b.setAttribute('aria-selected', String(b.dataset.bt === bt)));
  const hw = $('#f-hours-wrap', card), aw = $('#f-amount-wrap', card);
  if (hw) hw.classList.toggle('hidden', bt === 'flat');
  if (aw) aw.classList.toggle('hidden', bt !== 'flat');
}

const entryFieldsHTML = (e) => {
  const isFlat = !!(e && e.billingType === 'flat');
  return `
  <label for="f-spec" class="block text-[13px] font-semibold text-ink-soft mb-1.5">${t('Descrizione attività')}</label>
  <input id="f-spec" class="field mb-3" placeholder="${esc(t('Es. Sviluppo modulo pagamenti'))}" value="${e ? esc(e.spec || '') : ''}" />
  <label for="f-date" class="block text-[13px] font-semibold text-ink-soft mb-1.5">${t('Data')}</label>
  <input id="f-date" type="date" class="field mb-3" value="${e && e.date ? esc(e.date) : todayIso()}" />
  <label class="block text-[13px] font-semibold text-ink-soft mb-1.5">${t('Tipo di compenso')}</label>
  <div class="seg gap-0 text-[13px] font-semibold mb-3" id="f-ebilling">
    <button type="button" data-bt="hourly" aria-selected="${!isFlat}" onclick="entryBilling(this,'hourly')" class="flex-1 py-2">${t('A ore')}</button>
    <button type="button" data-bt="flat" aria-selected="${isFlat}" onclick="entryBilling(this,'flat')" class="flex-1 py-2">${t('A forfait')}</button>
  </div>
  <div id="f-hours-wrap" class="${isFlat ? 'hidden' : ''}">
    <label for="f-hours" class="block text-[13px] font-semibold text-ink-soft mb-1.5">${t('Ore lavorate')}</label>
    <input id="f-hours" type="number" min="0" step="0.25" class="field" placeholder="${esc(t('Es. 2.5'))}" value="${e && e.hours != null ? e.hours : ''}" />
  </div>
  <div id="f-amount-wrap" class="${isFlat ? '' : 'hidden'}">
    <label for="f-amount" class="block text-[13px] font-semibold text-ink-soft mb-1.5">${t('Importo forfait (€)')}</label>
    <input id="f-amount" type="number" min="0" step="0.01" class="field" placeholder="${esc(t('Es. 150'))}" value="${e && e.amount != null ? e.amount : ''}" />
  </div>
  <label for="f-paid" class="mt-3 flex items-start gap-2.5 cursor-pointer select-none">
    <input id="f-paid" type="checkbox" class="w-4 h-4 mt-0.5 shrink-0" style="accent-color:#FF9500" ${e && e.paid ? 'checked' : ''} />
    <span class="text-[13px] font-semibold text-ink-soft dark:text-zinc-400">${t('Già pagata')}
      <span class="block text-[11px] font-medium text-ink-faint dark:text-zinc-500 mt-0.5">${t('Sessione passata già saldata: conta nelle ore e nei report, ma non entra nella Nota di Pagamento.')}</span>
    </span>
  </label>`;
};

function addEntry(projectId) {
  if (!canEdit()) { toast(t('Account autorizzato in sola lettura'), 'error'); return; }
  const p = state.projects.find(x => x.id === projectId);
  if (!p) return;
  openModal({
    title: t('Aggiungi Sessione'),
    bodyHTML: `<p class="text-[12px] text-ink-faint mb-3">${t('Progetto:')} <span class="font-bold text-ink dark:text-zinc-200">${esc(p.name)}</span></p>${entryFieldsHTML(null)}`,
    confirmText: t('Aggiungi Sessione'),
    onConfirm: async (card) => {
      const isFlat = $('#f-ebilling button[data-bt="flat"]', card).getAttribute('aria-selected') === 'true';
      const hours = Number($('#f-hours', card).value);
      const amount = Number($('#f-amount', card).value);
      if (isFlat && (!(amount > 0))) { showError(card, t('Specificare un importo forfait maggiore di 0.')); return false; }
      if (!isFlat && (hours <= 0 || isNaN(hours))) { showError(card, t('Specificare un valore di ore maggiore di 0.')); return false; }
      const entry = {
        id: genId(),
        projectId,
        spec: $('#f-spec', card).value.trim() || t('Attività generica'),
        date: $('#f-date', card).value || todayIso(),
        hours: isFlat ? 0 : hours,
        billingType: isFlat ? 'flat' : 'hourly',
        amount: isFlat ? round2(amount) : 0,
        paid: $('#f-paid', card).checked
      };
      await dbPut('entries', entry);
      state.entries.push(entry);
      state.entries.sort((a, b) => String(a.date).localeCompare(String(b.date)));
      state.expanded.add(projectId);
      renderDashboard();
      cloudPush();
      toast(t('Sessione aggiunta'));
    }
  });
}

function editEntry(id) {
  if (!canEdit()) { toast(t('Account autorizzato in sola lettura'), 'error'); return; }
  const e = state.entries.find(x => x.id === id);
  if (!e) return;
  const p = state.projects.find(x => x.id === e.projectId);
  openModal({
    title: t('Modifica Sessione'),
    bodyHTML: `${p ? `<p class="text-[12px] text-ink-faint mb-3">${t('Progetto:')} <span class="font-bold text-ink dark:text-zinc-200">${esc(p.name)}</span></p>` : ''}${entryFieldsHTML(e)}`,
    confirmText: t('Salva Modifiche'),
    onConfirm: async (card) => {
      const isFlat = $('#f-ebilling button[data-bt="flat"]', card).getAttribute('aria-selected') === 'true';
      const hours = Number($('#f-hours', card).value);
      const amount = Number($('#f-amount', card).value);
      if (isFlat && (!(amount > 0))) { showError(card, t('Specificare un importo forfait maggiore di 0.')); return false; }
      if (!isFlat && (hours <= 0 || isNaN(hours))) { showError(card, t('Specificare un valore di ore maggiore di 0.')); return false; }
      e.spec = $('#f-spec', card).value.trim() || t('Attività generica');
      e.date = $('#f-date', card).value || todayIso();
      e.hours = isFlat ? 0 : hours;
      e.billingType = isFlat ? 'flat' : 'hourly';
      e.amount = isFlat ? round2(amount) : 0;
      e.paid = $('#f-paid', card).checked;
      await dbPut('entries', e); // updatedAt ritimbrato automaticamente
      state.entries.sort((a, b) => String(a.date).localeCompare(String(b.date)));
      renderDashboard();
      cloudPush();
      toast(t('Sessione aggiornata'));
    }
  });
}

// Dopo il re-render il nodo cliccato è nuovo: riporta il focus sulla stessa
// checkbox, così da tastiera si continua a selezionare senza perdere il punto.
function refocusSelection(action, id) {
  const el = document.querySelector(`#view-dashboard [data-action="${action}"][data-id="${CSS.escape(String(id))}"]`);
  if (el) try { el.focus({ preventScroll: true }); } catch (_) { el.focus(); }
}

// Azione di massa dalla barra di selezione: segna come pagate (o di nuovo da
// pagare) tutte le sessioni selezionate, poi esce dalla modalità selezione.
async function bulkSetPaid(paid) {
  if (!canEdit()) { toast(t('Account autorizzato in sola lettura'), 'error'); return; }
  if (!state.selected.size) { toast(t('Seleziona almeno una sessione'), 'warning'); return; }
  const targets = state.entries.filter(e => state.selected.has(e.id) && !!e.paid !== paid);
  for (const e of targets) {
    e.paid = paid;
    await dbPut('entries', e); // updatedAt ritimbrato automaticamente
  }
  state.selected.clear();
  state.selectMode = false;
  renderDashboard();
  if (targets.length) cloudPush();
  if (!targets.length) toast(paid ? t('Le sessioni selezionate erano già pagate') : t('Le sessioni selezionate erano già da pagare'), 'warning');
  else toast(paid
    ? plural(targets.length, t('sessione segnata come pagata'), t('sessioni segnate come pagate'))
    : plural(targets.length, t('sessione di nuovo da pagare'), t('sessioni di nuovo da pagare')));
}

// Segna/desegna al volo una sessione come "già pagata", senza aprire la modale.
async function togglePaidEntry(id) {
  if (!canEdit()) { toast(t('Account autorizzato in sola lettura'), 'error'); return; }
  const e = state.entries.find(x => x.id === id);
  if (!e) return;
  e.paid = !e.paid;
  await dbPut('entries', e); // updatedAt ritimbrato automaticamente
  renderDashboard();
  cloudPush();
  toast(e.paid ? t('Sessione segnata come pagata') : t('Sessione di nuovo da pagare'));
}

function deleteEntry(id) {
  if (!canEdit()) { toast(t('Account autorizzato in sola lettura'), 'error'); return; }
  const e = state.entries.find(x => x.id === id);
  if (!e) return;
  openModal({
    title: t('Eliminare la sessione?'),
    danger: true,
    bodyHTML: `<p class="text-[14px]">${t('Rimuovere la sessione {s} del {d} ({v})? L\'operazione non è reversibile.', {
      s: `<span class="font-bold">${esc(e.spec || t('senza descrizione'))}</span>`,
      d: esc(dateIt(e.date)),
      v: e.billingType === 'flat' ? t('{a} a forfait', { a: esc(eur(e.amount)) }) : esc(hrs(e.hours))
    })}</p>`,
    confirmText: t('Elimina Sessione'),
    onConfirm: async () => {
      await dbDel('entries', id);
      state.entries = state.entries.filter(x => x.id !== id);
      renderDashboard();
      cloudPush(); // il push diff propaga l'eliminazione al cloud
      toast(t('Sessione eliminata'));
    }
  });
}

/* ---------------------------------------------------------------------
   PROGETTI: eliminazione (con relative sessioni)
--------------------------------------------------------------------- */
function deleteProject(id) {
  if (!canEdit()) { toast(t('Account autorizzato in sola lettura'), 'error'); return; }
  const p = state.projects.find(x => x.id === id);
  if (!p) return;
  const related = state.entries.filter(e => e.projectId === id);
  openModal({
    title: t('Eliminare il progetto?'),
    danger: true,
    bodyHTML: `<p class="text-[14px]">${related.length
      ? t(related.length === 1 ? 'Eliminare {p} insieme alla sua {s}? L\'operazione non è reversibile.' : 'Eliminare {p} insieme alle sue {s}? L\'operazione non è reversibile.', {
          p: `<span class="font-bold">${esc(p.name)}</span>`,
          s: `<span class="font-bold text-[#ff3b30]">${esc(plural(related.length, t('sessione'), t('sessioni')))}</span>` })
      : t('Eliminare {p}? L\'operazione non è reversibile.', { p: `<span class="font-bold">${esc(p.name)}</span>` })}</p>`,
    confirmText: t('Elimina Progetto'),
    onConfirm: async () => {
      for (const e of related) await dbDel('entries', e.id);
      await dbDel('projects', id);
      state.entries = state.entries.filter(e => e.projectId !== id);
      state.projects = state.projects.filter(x => x.id !== id);
      state.expanded.delete(id);
      // Se il cronometro attivo apparteneva a questo progetto, fermalo.
      if (state.activeTimer && state.activeTimer.projectId === id) {
        await dbDel('timer', 'current');
        state.activeTimer = null;
      }
      renderDashboard();
      cloudPush();
      toast(t('Progetto eliminato'));
    }
  });
}

/* ---------------------------------------------------------------------
   GESTIONE COMPONENTI ANAGRAFICA CLIENTI
--------------------------------------------------------------------- */
function renderClients() {
  const root = $('#view-clients');
  if (!root) return;
  const editable = canEdit();

  let listHTML = '';
  if (state.clients.length === 0) {
    listHTML = `
      <div class="bg-white dark:bg-darkCard rounded-xl2 border border-black/5 dark:border-darkBorder px-6 py-12 text-center shadow-sm">
        <div class="text-3xl mb-3">👥</div>
        <p class="text-ink-soft dark:text-ink-faint text-[15px] font-medium">${t('Nessun cliente registrato.')}</p>
        <p class="text-ink-faint dark:text-zinc-600 text-[13px] mt-1">${editable ? t('Crea un cliente per associarlo ai tuoi progetti e fatturare con facilità.') : t('Nessuna informazione presente.')}</p>
      </div>`;
  } else {
    listHTML = `
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        ${state.clients.map(clientCardHTML).join('')}
      </div>`;
  }

  root.innerHTML = `
    <div class="flex items-center justify-between mb-4">
      <h2 class="text-[13px] font-bold uppercase tracking-wider text-ink-faint dark:text-zinc-500">${t('Rubrica Clienti')}</h2>
      ${editable ? `
        <button id="btn-add-client" class="text-[14px] font-bold text-accent hover:text-accent-hover transition-soft flex items-center gap-1">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15"/></svg>
          ${t('Nuovo Cliente')}
        </button>
      ` : ''}
    </div>
    ${listHTML}`;

  const addBtn = $('#btn-add-client');
  if (addBtn) addBtn.addEventListener('click', () => editClientModal(null));

  root.removeEventListener('click', handleClientAction);
  root.addEventListener('click', handleClientAction);
}

function clientCardHTML(c) {
  const editable = canEdit();
  const associatedProjects = state.projects.filter(p => p.clientId === c.id);
  const totalClientHours = associatedProjects.reduce((acc, p) => acc + projectHours(p.id), 0);
  const totalBilled = associatedProjects.reduce((acc, p) => acc + projectCompensation(p), 0);
  const linked = !!(c.accountEmail && String(c.accountEmail).trim());

  return `
    <div class="bg-white dark:bg-darkCard rounded-xl2 border border-black/5 dark:border-darkBorder p-5 shadow-sm flex flex-col justify-between hover:border-black/10 dark:hover:border-white/10 transition-soft">
      <div>
        <div class="flex items-start justify-between gap-2">
          <h3 class="text-[16px] font-bold text-ink dark:text-white leading-tight">${esc(c.name)}</h3>
          ${editable ? `
            <div class="flex items-center gap-1 shrink-0 no-print">
              <button data-client-action="edit" data-id="${c.id}" class="w-8 h-8 rounded-full hover:bg-black/5 dark:hover:bg-white/5 flex items-center justify-center text-ink-faint hover:text-ink dark:hover:text-white transition-soft" title="${esc(t('Modifica'))}">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10"/></svg>
              </button>
              <button data-client-action="delete" data-id="${c.id}" class="w-8 h-8 rounded-full hover:bg-red-500/10 flex items-center justify-center text-ink-faint hover:text-red-500 transition-soft" title="${esc(t('Elimina'))}">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
              </button>
            </div>
          ` : ''}
        </div>
        <div class="mt-2 space-y-1 text-[12px] text-ink-soft dark:text-zinc-400 font-medium">
          ${c.vatCode ? `<div><span class="text-ink-faint">${t('P.IVA / CF:')}</span> ${esc(c.vatCode)}</div>` : ''}
          ${c.foreignVat ? `<div><span class="text-ink-faint">${t('IVA estera:')}</span> ${esc(c.foreignVat)}</div>` : ''}
          ${c.email ? `<div><span class="text-ink-faint">${t('Email:')}</span> ${esc(c.email)}</div>` : ''}
          ${c.address ? `<div><span class="text-ink-faint">${t('Sede:')}</span> ${esc(c.address)}</div>` : ''}
        </div>
      </div>
      <div class="mt-4 pt-3 border-t border-black/5 dark:border-white/5 flex items-center justify-between text-[11px] text-ink-faint font-semibold uppercase tracking-wider">
        <div>${t('Progetti:')} <span class="text-ink dark:text-white font-extrabold">${associatedProjects.length}</span></div>
        <div>${t('Totale:')} <span class="text-accent font-extrabold">${eur(totalBilled)} (${hrs(totalClientHours)})</span></div>
      </div>
      ${editable ? `
      <button data-client-action="new-project" data-id="${c.id}" class="no-print mt-3 w-full text-[12px] font-bold text-accent hover:text-white border border-accent/30 hover:bg-accent rounded-full py-1.5 transition-soft flex items-center justify-center gap-1.5">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15"/></svg>
        ${t('Nuovo progetto per questo cliente')}
      </button>
      <div class="no-print mt-2 flex items-center justify-between gap-2">
        <button data-client-action="associate" data-id="${c.id}" class="text-[12px] font-bold text-ink-soft dark:text-zinc-300 hover:text-accent transition-soft flex items-center gap-1.5">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/></svg>
          ${linked ? t('Modifica account') : t('Associa account cliente')}
        </button>
        ${linked ? `<button data-client-action="dissociate" data-id="${c.id}" class="text-[11px] font-bold text-emerald-600 dark:text-emerald-400 hover:text-[#ff3b30] transition-soft flex items-center gap-1" title="${esc(c.accountEmail)} — clicca per rimuovere"><span>●</span> ${t('Collegato')}</button>` : ''}
      </div>` : ''}
    </div>`;
}

function handleClientAction(e) {
  const btn = e.target.closest('[data-client-action]');
  if (!btn) return;
  const action = btn.dataset.clientAction;
  const id = btn.dataset.id;

  if (action === 'edit') {
    editClientModal(id);
  } else if (action === 'delete') {
    deleteClient(id);
  } else if (action === 'new-project') {
    addProject(id);
  } else if (action === 'associate') {
    associateClientAccount(id);
  } else if (action === 'dissociate') {
    removeClientAssociation(id);
  }
}

function editClientModal(id) {
  const c = id ? state.clients.find(x => x.id === id) : null;
  openModal({
    title: c ? t('Modifica Scheda Cliente') : t('Crea Anagrafica Cliente'),
    bodyHTML: `
      <label for="fc-name" class="block text-[13px] font-semibold text-ink-soft mb-1.5">${t('Denominazione / Nome Completo')}</label>
      <input id="fc-name" class="field mb-3" placeholder="${esc(t('Es. Retrogames SRL'))}" value="${c ? esc(c.name) : ''}" />
      
      <label for="fc-vat" class="block text-[13px] font-semibold text-ink-soft mb-1.5">${t('Partita IVA o Codice Fiscale')}</label>
      <input id="fc-vat" class="field mb-3" placeholder="${esc(t('Es. IT01234567890'))}" value="${c ? esc(c.vatCode || '') : ''}" />

      <label for="fc-foreignvat" class="block text-[13px] font-semibold text-ink-soft mb-1.5">${t('IVA estera')} <span class="text-ink-faint">${t('(cliente extra-UE, es. Svizzera)')}</span></label>
      <input id="fc-foreignvat" class="field mb-3" placeholder="${esc(t('Es. CHE-123.456.789 MWST'))}" value="${c ? esc(c.foreignVat || '') : ''}" />

      <label for="fc-email" class="block text-[13px] font-semibold text-ink-soft mb-1.5">${t('Email di Fatturazione')}</label>
      <input id="fc-email" type="email" class="field mb-3" placeholder="${esc(t('Es. amministrazione@retrogames.it'))}" value="${c ? esc(c.email || '') : ''}" />

      <label for="fc-address" class="block text-[13px] font-semibold text-ink-soft mb-1.5">${t('Sede Fiscale o Residenza')}</label>
      <textarea id="fc-address" class="field h-16 resize-none" placeholder="${esc(t('Es. Via Roma 12, 20121 Milano (MI)'))}">${c ? esc(c.address || '') : ''}</textarea>
    `,
    confirmText: c ? t('Salva Cliente') : t('Crea Cliente'),
    onConfirm: async (card) => {
      const name = $('#fc-name', card).value.trim();
      if (!name) { showError(card, t('La denominazione del cliente è obbligatoria.')); return false; }

      const clientData = {
        id: c ? c.id : genId(),
        name,
        vatCode: $('#fc-vat', card).value.trim(),
        foreignVat: $('#fc-foreignvat', card).value.trim(),
        email: $('#fc-email', card).value.trim(),
        address: $('#fc-address', card).value.trim(),
        phone: c ? (c.phone || '') : ''
      };

      await dbPut('clients', clientData);
      if (c) {
        Object.assign(c, clientData);
      } else {
        state.clients.push(clientData);
      }
      state.clients.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      renderClients();
      cloudPush();
      toast(t('Scheda cliente archiviata con successo'));
    }
  });
}

function deleteClient(id) {
  const c = state.clients.find(x => x.id === id);
  if (!c) return;
  const associated = state.projects.filter(p => p.clientId === id);
  if (associated.length > 0) {
    openModal({
      title: t('Impossibile eliminare cliente'),
      bodyHTML: `<p class="text-[14px]">${t('Il cliente {c} è associato a {n} attivi. Scollega o elimina prima i progetti associati per procedere.', {
        c: `<span class="font-bold">${esc(c.name)}</span>`,
        n: `<span class="font-bold text-accent">${esc(plural(associated.length, t('progetto'), t('progetti')))}</span>` })}</p>`,
      confirmText: t('Ho capito'),
      cancelText: t('Chiudi')
    });
    return;
  }

  openModal({
    title: t('Cancellare anagrafica cliente?'),
    danger: true,
    bodyHTML: `<p class="text-[14px]">${t('Rimuovere definitivamente {c} dalla rubrica? I dati inseriti non saranno più recuperabili.', { c: `<span class="font-bold">${esc(c.name)}</span>` })}</p>`,
    confirmText: t('Elimina Cliente'),
    onConfirm: async () => {
      await dbDel('clients', id);
      state.clients = state.clients.filter(x => x.id !== id);
      renderClients();
      cloudPush();
      toast(t('Scheda cliente rimossa'));
    }
  });
}

/* ---------------------------------------------------------------------
   AGGIORNAMENTO NOTA DI PAGAMENTO RELAZIONALE
--------------------------------------------------------------------- */
function allEntriesFlat() {
  const projectMap = new Map(state.projects.map(p => [p.id, p]));
  const clientMap = new Map(state.clients.map(c => [c.id, c]));

  return state.entries
    .map(e => {
      const p = projectMap.get(e.projectId);
      const c = p ? clientMap.get(p.clientId) : null;
      return { 
        ...e, 
        project: p ? p.name : '—',
        rate: (p && p.billingType === 'flat') ? 0 : (p && p.hourlyRate != null ? p.hourlyRate : state.settings.hourlyRate),
        clientName: c ? c.name : '',
        clientAddress: c ? c.address : '',
        clientVat: c ? c.vatCode : '',
        clientForeignVat: c ? (c.foreignVat || '') : ''
      };
    })
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.project.localeCompare(b.project));
}

/* ---------------------------------------------------------------------
   PAGAMENTI: registro acconti/saldi agganciato al contesto di fatturazione
--------------------------------------------------------------------- */
// Il contesto è ricavato dai filtri attivi (progetto + finestra temporale).
// "Mese corrente" viene risolto al mese concreto, così l'associazione dei
// pagamenti resta stabile anche cambiando mese.
function paymentContext() {
  const f = state.filters;
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const monthRange = (y, m) => {
    const mm = String(m + 1).padStart(2, '0');
    const last = String(new Date(y, m + 1, 0).getDate()).padStart(2, '0');
    return { start: `${y}-${mm}-01`, end: `${y}-${mm}-${last}`, label: t('Mese {m}', { m: `${mm}/${y}` }) };
  };

  let start = '', end = '', label = t('Tutto lo storico');
  if (f.period === 'current-month') {
    const r = monthRange(year, month); start = r.start; end = r.end; label = r.label;
  } else if (f.period === 'last-month') {
    const pm = month === 0 ? 11 : month - 1;
    const py = month === 0 ? year - 1 : year;
    const r = monthRange(py, pm); start = r.start; end = r.end; label = r.label;
  } else if (f.period === 'current-year') {
    start = `${year}-01-01`; end = `${year}-12-31`; label = t('Anno {y}', { y: year });
  } else if (f.period === 'custom') {
    start = f.startDate || ''; end = f.endDate || '';
    label = (start || end) ? `${start ? dateIt(start) : '…'} – ${end ? dateIt(end) : '…'}` : t('Intervallo personalizzato');
  }
  const projPart = f.project === 'all' ? 'all' : f.project;
  const projLabel = f.project === 'all' ? t('Tutti i progetti') : ((state.projects.find(p => p.id === f.project) || {}).name || t('Progetto'));
  return { key: `proj:${projPart}|range:${start || '*'}..${end || '*'}`, label, projLabel };
}

// Numerazione progressiva delle note: registro per contesto salvato nelle
// impostazioni (sincronizzate). Ogni numero è progressivo per anno.
function noteRegistry() {
  if (!state.settings.noteRegistry || typeof state.settings.noteRegistry !== 'object') {
    state.settings.noteRegistry = {};
  }
  return state.settings.noteRegistry;
}
function noteNumFmt(n, year) { return `${String(n).padStart(4, '0')}/${year}`; }
function getNote(ctxKey) { return noteRegistry()[ctxKey] || null; }
function nextNoteSeq(year) {
  const reg = noteRegistry();
  let max = 0;
  for (const k in reg) { if (reg[k] && reg[k].year === year && reg[k].n > max) max = reg[k].n; }
  return max + 1;
}
// Add N days to an ISO date (yyyy-mm-dd). Aritmetica in UTC: il risultato non
// dipende dal fuso locale né dai cambi di ora legale.
function addDaysIso(iso, n) {
  const base = isValidIsoDate(iso) ? iso : todayIso();
  const [y, m, d] = base.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  const p = (x) => String(x).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

// Due status of a note given its residual: 'overdue' | 'soon' (<=7 days) | 'ok' | null.
function dueStatus(due, residual) {
  if (!isValidIsoDate(due)) return null;
  if ((Number(residual) || 0) <= 0.005) return null; // saldata: nessuna scadenza attiva
  const t = todayIso();
  if (due < t) return 'overdue';
  return daysBetweenIso(t, due) <= 7 ? 'soon' : 'ok';
}

// On launch, surface notes still to be collected (uses payableSnapshot, set when a
// note is viewed, so status is known without recomputing entries).
function checkDueReminders() {
  if (isClient()) return;
  try {
    const reg = noteRegistry();
    const today = todayIso();
    let overdue = 0, soon = 0;
    for (const k in reg) {
      const note = reg[k];
      if (!note || !isValidIsoDate(note.dueDate) || note.payableSnapshot == null) continue;
      const paid = paymentsForContext(k).reduce((a, p) => a + (Number(p.amount) || 0), 0);
      if (paid >= note.payableSnapshot - 0.005) continue; // saldata
      if (note.dueDate < today) overdue++;
      else if (daysBetweenIso(today, note.dueDate) <= 7) soon++;
    }
    if (overdue > 0) toast(overdue > 1 ? t('{n} note scadute da incassare', { n: overdue }) : t('1 nota scaduta da incassare'), 'warning');
    else if (soon > 0) toast(soon > 1 ? t('{n} note in scadenza', { n: soon }) : t('1 nota in scadenza'), 'warning');
  } catch (_) {}
}

async function assignNoteNumber(ctx) {
  if (!canManagePayment()) { toast(t('Account autorizzato in sola lettura'), 'error'); return; }
  const reg = noteRegistry();
  if (reg[ctx.key]) return; // già emessa
  const year = Number(todayIso().slice(0, 4));
  reg[ctx.key] = { n: nextNoteSeq(year), year, issuedAt: todayIso(), dueDate: addDaysIso(todayIso(), 30), label: `${ctx.projLabel} · ${ctx.label}` };
  await dbPut('settings', state.settings);
  renderPayment();
  cloudPush();
  toast(t('Nota N. {n} emessa', { n: noteNumFmt(reg[ctx.key].n, year) }));
}
function revokeNoteNumber(ctxKey) {
  if (!canManagePayment()) { toast(t('Account autorizzato in sola lettura'), 'error'); return; }
  const reg = noteRegistry();
  const note = reg[ctxKey];
  if (!note) return;
  openModal({
    title: t('Annullare la numerazione?'),
    danger: true,
    bodyHTML: `<p class="text-[14px]">${t('Revocare il numero {n} da questa nota? Il numero non verrà riassegnato automaticamente e potrebbe creare un buco nella sequenza.', { n: `<span class="font-bold">${esc(noteNumFmt(note.n, note.year))}</span>` })}</p>`,
    confirmText: t('Annulla numero'),
    onConfirm: async () => {
      delete reg[ctxKey];
      await dbPut('settings', state.settings);
      renderPayment();
      cloudPush();
      toast(t('Numerazione annullata'));
    }
  });
}

function paymentsForContext(key) {
  return state.payments
    .filter(p => p.ctx === key)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function openPaymentModal(ctx, residual, total) {
  if (!canManagePayment()) { toast(t('Account autorizzato in sola lettura'), 'error'); return; }
  const suggested = residual > 0 ? residual : total;
  openModal({
    title: t('Registra Pagamento'),
    bodyHTML: `
      <p class="text-[12px] text-ink-faint mb-3">${esc(ctx.projLabel)} · ${esc(ctx.label)}</p>
      <label for="fp-amount" class="block text-[13px] font-semibold text-ink-soft mb-1.5">${t('Importo ricevuto (€)')}</label>
      <input id="fp-amount" type="number" min="0" step="0.01" class="field mb-1" value="${suggested > 0 ? suggested.toFixed(2) : ''}" />
      <p class="text-[11px] text-ink-faint mb-3">${t('Residuo attuale: {r} su {t}', { r: `<span class="font-bold">${esc(eur(Math.max(0, residual)))}</span>`, t: esc(eur(total)) })}</p>
      <label class="block text-[13px] font-semibold text-ink-soft mb-1.5">${t('Tipo di versamento')}</label>
      <div class="seg gap-0 text-[13px] font-semibold mb-3" id="fp-type">
        <button type="button" data-type="acconto" aria-selected="true" class="py-2">${t('Acconto')}</button>
        <button type="button" data-type="saldo" aria-selected="false" class="py-2">${t('Saldo')}</button>
      </div>
      <label for="fp-date" class="block text-[13px] font-semibold text-ink-soft mb-1.5">${t('Data versamento')}</label>
      <input id="fp-date" type="date" class="field mb-3" value="${todayIso()}" />
      <label for="fp-note" class="block text-[13px] font-semibold text-ink-soft mb-1.5">${t('Nota (opzionale)')}</label>
      <input id="fp-note" class="field" placeholder="${esc(t('Es. Bonifico, acconto 30%'))}" />
    `,
    onMount: (card) => {
      const seg = $('#fp-type', card);
      const amount = $('#fp-amount', card);
      const setType = (t) => $$('button[data-type]', seg).forEach(x => x.setAttribute('aria-selected', String(x.dataset.type === t)));
      if (seg) $$('button[data-type]', seg).forEach(b => b.addEventListener('click', () => setType(b.dataset.type)));
      // Suggerisce automaticamente "Saldo" se l'importo copre l'intero residuo.
      if (amount) amount.addEventListener('input', () => {
        const v = Number(amount.value) || 0;
        setType(residual > 0 && v >= residual - 0.005 ? 'saldo' : 'acconto');
      });
    },
    confirmText: t('Registra Pagamento'),
    onConfirm: async (card) => {
      const amount = Number($('#fp-amount', card).value);
      if (!(amount > 0)) { showError(card, t('Specificare un importo maggiore di 0.')); return false; }
      const typeBtn = $('#fp-type button[aria-selected="true"]', card);
      const pay = {
        id: genId(),
        ctx: ctx.key,
        ctxLabel: `${ctx.projLabel} · ${ctx.label}`,
        amount,
        type: typeBtn ? typeBtn.dataset.type : 'acconto',
        date: $('#fp-date', card).value || todayIso(),
        note: $('#fp-note', card).value.trim(),
        total
      };
      await dbPut('payments', pay);
      state.payments.push(pay);
      renderPayment();
      cloudPush();
      toast(t('Pagamento registrato'));
    }
  });
}

function settleResidual(ctx, residual, total) {
  if (!canManagePayment()) { toast(t('Account autorizzato in sola lettura'), 'error'); return; }
  if (!(residual > 0)) return;
  const pay = {
    id: genId(), ctx: ctx.key, ctxLabel: `${ctx.projLabel} · ${ctx.label}`,
    amount: Math.round(residual * 100) / 100, type: 'saldo',
    date: todayIso(), note: t('Saldo residuo'), total
  };
  dbPut('payments', pay).then(() => {
    state.payments.push(pay);
    renderPayment();
    cloudPush();
    toast(t('Residuo saldato'));
  });
}

function deletePayment(id) {
  if (!canManagePayment()) { toast(t('Account autorizzato in sola lettura'), 'error'); return; }
  const pay = state.payments.find(p => p.id === id);
  if (!pay) return;
  openModal({
    title: t('Eliminare il pagamento?'),
    danger: true,
    bodyHTML: `<p class="text-[14px]">${t('Rimuovere il pagamento di {a} del {d}? L\'operazione non è reversibile.', { a: `<span class="font-bold">${esc(eur(pay.amount))}</span>`, d: esc(dateIt(pay.date)) })}</p>`,
    confirmText: t('Elimina'),
    onConfirm: async () => {
      await dbDel('payments', id);
      state.payments = state.payments.filter(p => p.id !== id);
      renderPayment();
      cloudPush();
      toast(t('Pagamento eliminato'));
    }
  });
}

function renderPayment() {
  const root = $('#view-payment');
  if (!root) return;
  const s = state.settings;
  
  // La nota usa lo STESSO filtro canonico della Dashboard (progetto + tutti i
  // periodi: mese corrente/precedente, anno corrente, intervallo personalizzato).
  // Tutti i valori arrivano da buildNoteModel(), lo stesso modello dell'export
  // PDF: un unico punto di calcolo, vista e documenti non possono divergere.
  const m = buildNoteModel();
  const { flat, tH, baseCompensation, taxValue, subtotalWithTax, vatValue, wTaxValue,
          grandTotal, stampDuty, payable, ctx, note, ctxPayments, paid, residual, forfettario } = m;
  const taxPercentage = m.taxP, vatPercentage = m.vatP, wTaxPercentage = m.wTaxP;
  const hasTotal = payable > 0.005;
  const payStatus = !hasTotal ? null : (residual <= 0.005 && paid > 0 ? 'paid' : (paid > 0 ? 'acconto' : 'due'));
  // Snapshot del totale sulla nota: consente ai promemoria di sapere quali note
  // restano da incassare senza ricalcolare le voci. Scrive solo quando cambia.
  if (note && canManagePayment() && !sync.applyingRemote) {
    if (note.payableSnapshot !== payable) { note.payableSnapshot = payable; dbPut('settings', state.settings); }
  }
  const due = note ? dueStatus(note.dueDate, residual) : null;
  // Simbolo + testo: lo stato resta leggibile anche senza distinguere i colori.
  const statusMap = {
    paid:    { t: t('✓ PAGATA'),           cls: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30' },
    acconto: { t: t('◐ ACCONTO RICEVUTO'), cls: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30' },
    due:     { t: t('○ DA SALDARE'),       cls: 'bg-black/5 dark:bg-white/5 text-ink-soft dark:text-zinc-400 border-black/10 dark:border-white/10' }
  };
  const statusBadge = payStatus
    ? `<span class="inline-block mt-2 text-[10px] font-extrabold uppercase tracking-wider px-2.5 py-1 rounded-full border ${statusMap[payStatus].cls}">${statusMap[payStatus].t}</span>`
    : '';

  const payTypeChip = (type) => type === 'saldo'
    ? `<span class="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">${t('Saldo')}</span>`
    : `<span class="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400">${t('Acconto')}</span>`;
  const paymentsListHTML = ctxPayments.length
    ? ctxPayments.map(p => `
        <div class="flex items-center gap-2 py-2 border-t border-black/5 dark:border-white/5 text-[12px]">
          <div class="flex-1 min-w-0">
            <span class="font-bold text-ink dark:text-zinc-200 tabular-nums">${esc(eur(p.amount))}</span>
            <span class="ml-1.5">${payTypeChip(p.type)}</span>
            <span class="ml-1.5 text-ink-faint">${esc(dateIt(p.date))}</span>
            ${p.note ? `<div class="text-ink-faint mt-0.5 truncate">${esc(p.note)}</div>` : ''}
          </div>
          ${canManagePayment() ? `<button data-pay-action="del" data-id="${esc(p.id)}" title="${esc(t('Elimina pagamento'))}" class="w-7 h-7 rounded-full hover:bg-red-500/10 text-ink-faint hover:text-red-500 flex items-center justify-center shrink-0"><svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg></button>` : ''}
        </div>`).join('')
    : `<p class="text-[12px] text-ink-faint py-2">${t('Nessun pagamento registrato per questo contesto.')}</p>`;

  const paymentsCard = `
    <div class="no-print bg-white dark:bg-darkCard rounded-xl2 border border-black/5 dark:border-darkBorder p-4 shadow-sm mb-5">
      <div class="flex items-center justify-between gap-2 mb-0.5">
        <h3 class="text-[13px] font-bold text-ink dark:text-zinc-200">${t('Stato pagamento')}</h3>
        <div class="flex items-center gap-1.5">
          ${due === 'overdue' ? `<span class="text-[10px] font-extrabold uppercase tracking-wider px-2.5 py-1 rounded-full border border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400">${t('Scaduta')}</span>` : (due === 'soon' ? `<span class="text-[10px] font-extrabold uppercase tracking-wider px-2.5 py-1 rounded-full border border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400">${t('In scadenza')}</span>` : '')}
          ${payStatus ? `<span class="text-[10px] font-extrabold uppercase tracking-wider px-2.5 py-1 rounded-full border ${statusMap[payStatus].cls}">${statusMap[payStatus].t}</span>` : ''}
        </div>
      </div>
      <p class="text-[11px] text-ink-soft dark:text-zinc-400 mb-3">${esc(ctx.projLabel)} · ${esc(ctx.label)}</p>
      <div class="flex items-center justify-between gap-2 mb-3 rounded-xl bg-black/[0.02] dark:bg-white/[0.02] px-3 py-2">
        <div class="text-[11px] text-ink-soft dark:text-zinc-400">
          ${note
            ? `${t('Numero nota:')} <span class="font-extrabold text-ink dark:text-white tabular-nums">${t('N. {n}', { n: esc(noteNumFmt(note.n, note.year)) })}</span> <span class="text-ink-faint">· ${t('emessa il {d}', { d: esc(dateIt(note.issuedAt)) })}</span>`
            : `<span class="text-ink-faint">${t('Nessun numero progressivo assegnato a questa nota.')}</span>`}
        </div>
        ${canManagePayment()
          ? (note
              ? `<button id="btn-revoke-note" class="text-[11px] font-bold text-ink-faint hover:text-red-500 transition-soft shrink-0">${t('Annulla')}</button>`
              : `<button id="btn-assign-note" class="text-[11px] font-bold text-accent hover:text-accent-hover transition-soft shrink-0 whitespace-nowrap">${t('Assegna numero')}</button>`)
          : ''}
      </div>
      ${note ? `
      <div class="flex items-center justify-between gap-2 mb-3 rounded-xl bg-black/[0.02] dark:bg-white/[0.02] px-3 py-2">
        <div class="text-[11px] text-ink-soft dark:text-zinc-400">${t('Scadenza pagamento')}${due === 'overdue' ? ` <span class="text-red-500 font-bold">${t('· scaduta')}</span>` : (due === 'soon' ? ` <span class="text-amber-600 dark:text-amber-400 font-bold">${t('· imminente')}</span>` : '')}</div>
        ${canManagePayment()
          ? `<input id="note-due" type="date" value="${esc(note.dueDate || '')}" class="bg-transparent text-[12px] font-semibold text-ink dark:text-zinc-200 outline-none cursor-pointer" />`
          : `<span class="text-[12px] font-semibold text-ink dark:text-zinc-200">${esc(dateIt(note.dueDate))}</span>`}
      </div>` : ''}
      <div class="grid grid-cols-3 gap-2 text-center mb-3">
        <div class="rounded-xl bg-black/[0.02] dark:bg-white/[0.02] py-2">
          <div class="text-[10px] uppercase tracking-wide text-ink-faint font-bold">${t('Totale')}</div>
          <div class="text-[14px] font-extrabold text-ink dark:text-white tabular-nums">${esc(eur(payable))}</div>
        </div>
        <div class="rounded-xl bg-black/[0.02] dark:bg-white/[0.02] py-2">
          <div class="text-[10px] uppercase tracking-wide text-ink-faint font-bold">${t('Versato')}</div>
          <div class="text-[14px] font-extrabold text-emerald-600 dark:text-emerald-400 tabular-nums">${esc(eur(paid))}</div>
        </div>
        <div class="rounded-xl bg-black/[0.02] dark:bg-white/[0.02] py-2">
          <div class="text-[10px] uppercase tracking-wide text-ink-faint font-bold">${t('Residuo')}</div>
          <div class="text-[14px] font-extrabold ${residual > 0.005 ? 'text-accent' : 'text-emerald-600 dark:text-emerald-400'} tabular-nums">${esc(eur(Math.max(0, residual)))}</div>
        </div>
      </div>
      ${canManagePayment()
        ? `<div class="flex flex-wrap gap-2">
             <button id="btn-add-payment" ${hasTotal ? '' : 'disabled'} class="px-4 py-1.5 rounded-full bg-accent hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed text-white text-[12px] font-bold transition-soft">${t('+ Registra pagamento')}</button>
             ${hasTotal && residual > 0.005 ? `<button id="btn-settle-payment" class="px-4 py-1.5 rounded-full border border-emerald-500/40 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10 text-[12px] font-bold transition-soft">${t('Salda residuo ({r})', { r: esc(eur(residual)) })}</button>` : ''}
           </div>`
        : `<p class="text-[11px] text-ink-faint">${t('Accesso in sola lettura: la registrazione dei pagamenti non è disponibile.')}</p>`}
      <div class="mt-2">${paymentsListHTML}</div>
    </div>`;

  const rows = flat.length
    ? flat.map(e => `
        <tr class="border-b border-black/5 dark:border-white/5">
          <td class="py-2.5 pr-3 text-ink-soft dark:text-zinc-400 whitespace-nowrap font-medium">${esc(dateIt(e.date))}</td>
          <td class="py-2.5 pr-3 text-ink dark:text-zinc-200 font-semibold">${esc(e.project)} <span class="text-[10px] text-ink-faint tabular-nums">${e.billingType === 'flat' ? t('(forfait)') : `(${eur(e.rate)}/h)`}</span></td>
          <td class="py-2.5 pr-3 text-ink-soft dark:text-zinc-400 font-medium">${esc(e.spec)}</td>
          <td class="py-2.5 text-right tabular-nums text-ink dark:text-zinc-200 font-bold">${e.billingType === 'flat' ? esc(eur(e.amount)) : esc(hrs(e.hours))}</td>
        </tr>`).join('')
    : `<tr><td colspan="4" class="py-6 text-center text-ink-faint font-medium">${t('Nessuna voce corrisponde ai filtri di ricerca impostati.')}</td></tr>`;

  const clientNames = [...new Set(flat.map(x => x.clientName).filter(Boolean))];
  const clientAddresses = [...new Set(flat.map(x => x.clientAddress).filter(Boolean))];
  const clientVats = [...new Set(flat.map(x => x.clientVat).filter(Boolean))];
  const clientForeignVats = [...new Set(flat.map(x => x.clientForeignVat).filter(Boolean))];
  
  let clientDisplay = '—';
  if (clientNames.length === 1) {
    clientDisplay = `<strong>${esc(clientNames[0])}</strong><br>
                     <span class="text-[11px] text-ink-soft dark:text-zinc-400">
                       ${clientAddresses[0] ? esc(clientAddresses[0]) + '<br>' : ''}
                       ${clientVats[0] ? t('P.IVA/CF') + ': ' + esc(clientVats[0]) + '<br>' : ''}
                       ${clientForeignVats[0] ? t('IVA estera') + ': ' + esc(clientForeignVats[0]) : ''}
                     </span>`;
  } else if (clientNames.length > 1) {
    clientDisplay = `<strong>${t('Fatturazione Multi-cliente')}</strong><br><span class="text-[11px] text-ink-soft dark:text-zinc-400 font-medium">${t('Ripartita su {n} posizioni', { n: clientNames.length })}</span>`;
  }

  root.innerHTML = `
    <div class="no-print bg-white dark:bg-darkCard rounded-xl2 border border-black/5 dark:border-darkBorder p-4 shadow-sm mb-5">
      <div class="flex flex-col sm:flex-row justify-between sm:items-center gap-3">
        <div>
          <h3 class="text-[13px] font-bold text-ink dark:text-zinc-200">${t('Filtri di fatturazione attivi')}</h3>
          <p class="text-[11px] text-ink-soft dark:text-zinc-400 mt-0.5">${t('La nota mostrerà solo le voci filtrate nella Dashboard.')}</p>
          ${m.paidExcludedCount > 0 ? `<p class="text-[11px] font-semibold text-emerald-600 dark:text-emerald-400 mt-1">✓ ${esc(m.paidExcludedCount === 1 ? t('1 sessione già pagata esclusa dalla nota.') : t('{n} sessioni già pagate escluse dalla nota.', { n: m.paidExcludedCount }))}</p>` : ''}
        </div>
        <div class="flex items-center gap-2 no-print">
          <button id="btn-sync-dashboard-filters" type="button" aria-label="${esc(t('Filtra le voci della nota'))}" title="${esc(t('Filtra voci'))}" class="w-9 h-9 rounded-full border border-black/10 dark:border-white/10 text-ink-soft dark:text-zinc-300 hover:bg-black/5 dark:hover:bg-white/5 transition-soft flex items-center justify-center">
            <svg class="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h18M6 12h12M10 19h4"/></svg>
          </button>
          <button id="btn-print" type="button" aria-label="${esc(t('Stampa la nota in PDF'))}" title="${esc(t('Stampa PDF'))}" class="w-9 h-9 rounded-full bg-accent hover:bg-accent-hover text-white transition-soft flex items-center justify-center shadow-sm">
            <svg class="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 9V3h10v6"/><path d="M7 18H5a2 2 0 01-2-2v-4a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2h-2"/><rect x="7" y="14" width="10" height="7" rx="1"/></svg>
          </button>
        </div>
      </div>
    </div>

    ${paymentsCard}

    <div class="print-area bg-white dark:bg-darkCard rounded-xl2 border border-black/5 dark:border-darkBorder shadow-sm p-4 sm:p-8 dark:text-zinc-100 overflow-x-auto">
      
      <div class="flex flex-col sm:flex-row justify-between items-start gap-4 pb-5 border-b border-black/10 dark:border-white/10">
        <div>
          <div class="text-[20px] font-extrabold tracking-tight text-accent">${t('NOTA DI PAGAMENTO')}</div>
          <div class="text-[11px] font-bold text-ink-faint dark:text-zinc-500 uppercase tracking-wider mt-2">${t('Mittente:')}</div>
          <div class="text-[14px] font-bold text-ink dark:text-white">${esc(s.holderName || '—')}</div>
        </div>
        <div class="text-left sm:text-right text-[12px] text-ink-soft dark:text-zinc-400">
          ${note ? `<div class="text-[14px] font-extrabold text-ink dark:text-white tabular-nums">Nota N. ${esc(noteNumFmt(note.n, note.year))}</div>` : ''}
          <div>${t('Emissione:')} <strong class="text-ink dark:text-white">${esc(dateIt(note ? note.issuedAt : todayIso()))}</strong></div>
          ${statusBadge}
          <div class="mt-3 text-left sm:text-right border-t sm:border-t-0 pt-2 sm:pt-0">
            <div class="text-[10px] font-bold uppercase tracking-wide text-ink-faint">${t('Destinatario Cliente:')}</div>
            <div class="text-ink dark:text-white mt-1 leading-normal">${clientDisplay}</div>
          </div>
        </div>
      </div>

      <div class="overflow-x-auto w-full">
        <table class="print-table w-full text-[13px] mt-6 min-w-[500px]">
          <thead>
            <tr class="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-black/10 dark:border-white/10">
              <th class="py-2 pr-3 font-bold">${t('Data')}</th>
              <th class="py-2 pr-3 font-bold">${t('Dettagli Tariffa')}</th>
              <th class="py-2 pr-3 font-bold">${t('Descrizione Attività')}</th>
              <th class="py-2 font-bold text-right">${t('Ore / Forfait')}</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>

      ${s.causale ? `<div class="mt-5 text-[12px] text-ink-soft dark:text-zinc-400"><span class="text-[10px] uppercase tracking-wide text-ink-faint font-bold">${t('Causale:')}</span> <span class="font-semibold text-ink dark:text-zinc-200">${esc(s.causale)}</span></div>` : ''}
      ${forfettario ? `<div class="mt-2 text-[11px] text-ink-faint dark:text-zinc-500 leading-snug italic">${t('Operazione in franchigia da IVA (art. 1, c. 54-89, L. 190/2014) · compenso non soggetto a ritenuta d\'acconto.')}</div>` : ''}

      <div class="mt-6 flex justify-end print-keep">
        <div class="w-full sm:w-80 text-[13px] space-y-2">
          <div class="flex justify-between text-ink-soft dark:text-zinc-400 font-semibold"><span>${t('Compenso prestazioni')}</span><span class="tabular-nums">${esc(eur(baseCompensation))}</span></div>
          <div class="flex justify-between text-ink-soft dark:text-zinc-400 font-semibold"><span>${t('Totale Ore')}</span><span class="tabular-nums font-bold">${esc(hrs(tH))}</span></div>
          
          ${taxPercentage > 0 ? `
            <div class="flex justify-between text-ink-soft dark:text-zinc-400 font-semibold">
              <span>Rivalsa Previdenziale (${taxPercentage}%)</span>
              <span class="tabular-nums">${esc(eur(taxValue))}</span>
            </div>
          ` : ''}

          ${vatPercentage > 0 ? `
            <div class="flex justify-between text-ink-soft dark:text-zinc-400 font-semibold">
              <span>I.V.A. (${vatPercentage}%)</span>
              <span class="tabular-nums">${esc(eur(vatValue))}</span>
            </div>
          ` : ''}

          ${wTaxPercentage > 0 ? `
            <div class="flex justify-between text-red-500 font-semibold">
              <span>Ritenuta d'Acconto (${wTaxPercentage}%)</span>
              <span class="tabular-nums">-${esc(eur(wTaxValue))}</span>
            </div>
          ` : ''}

          ${stampDuty > 0 ? `
            <div class="flex justify-between pt-2.5 mt-1 border-t border-black/10 dark:border-white/10 text-ink-soft dark:text-zinc-400 font-semibold"><span>${t('Subtotale')}</span><span class="tabular-nums">${esc(eur(grandTotal))}</span></div>
            <div class="flex justify-between text-ink-soft dark:text-zinc-400 font-semibold"><span>${t('Marca da bollo')}</span><span class="tabular-nums">${esc(eur(stampDuty))}</span></div>
            <div class="flex justify-between text-[16px] font-extrabold"><span>${t('Totale documento')}</span><span class="tabular-nums text-accent">${esc(eur(payable))}</span></div>
          ` : `
            <div class="flex justify-between pt-2.5 mt-1 border-t border-black/10 dark:border-white/10 text-[16px] font-extrabold">
              <span>${t('Netto a pagare')}</span><span class="tabular-nums text-accent">${esc(eur(payable))}</span>
            </div>
          `}

          ${paid > 0 ? `
            <div class="flex justify-between text-emerald-600 dark:text-emerald-400 font-semibold pt-1.5"><span>${t('Già versato')}</span><span class="tabular-nums">-${esc(eur(paid))}</span></div>
            <div class="flex justify-between text-[15px] font-extrabold ${residual <= 0.005 ? 'text-emerald-600 dark:text-emerald-400' : 'text-ink dark:text-white'}"><span>${residual <= 0.005 ? t('Saldato') : t('Residuo da pagare')}</span><span class="tabular-nums">${esc(eur(Math.max(0, residual)))}</span></div>
          ` : ''}
        </div>
      </div>

      <div class="mt-8 pt-5 border-t border-black/10 dark:border-white/10 print-keep">
        <div class="text-[10px] uppercase tracking-wider text-ink-faint font-bold mb-3">${t('Estremi di Liquidazione')}</div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-y-3 gap-x-6 text-[13px]">
          <div>
            <span class="text-ink-faint font-medium text-[11px] block">${t('Intestatario')}</span>
            <span class="text-ink dark:text-zinc-200 font-semibold mt-0.5 block">${esc(s.holderName || '—')}</span>
          </div>
          <div>
            <span class="text-ink-faint font-medium text-[11px] block">${t('Codice IBAN')}</span>
            <span class="mt-0.5 block">
              ${!s.iban ? `<span class="text-ink dark:text-zinc-200 font-semibold">—</span>` :
                canSeeIban()
                ? `<span id="iban-screen" class="text-ink dark:text-zinc-200 font-bold tabular-nums break-all no-print">${esc(maskIban(s.iban))}</span>
                   <span class="hidden print:inline text-ink dark:text-zinc-200 font-bold tabular-nums break-all">${esc(groupIban(s.iban))}</span>
                   <button id="iban-toggle" type="button" aria-pressed="false" class="no-print ml-2 text-[11px] font-bold text-accent hover:underline">${t('Mostra')}</button>
                   <button id="iban-copy" type="button" class="no-print ml-2 text-[11px] font-bold text-emerald-600 dark:text-emerald-400 hover:underline">${t('Copia')}</button>`
                : `<span class="no-print inline-flex items-center gap-1.5 text-ink-soft dark:text-zinc-400 font-bold text-[12px]">
                     <span>${t('🔒 Riservato')}</span>
                     <button id="iban-login" type="button" class="text-accent hover:underline">${t('Accedi')}</button>
                   </span>
                   <span class="hidden print:inline text-ink-soft dark:text-zinc-400 font-semibold">${t('Riservato (Accesso richiesto)')}</span>`
              }
            </span>
          </div>
          <div>
            <span class="text-ink-faint font-medium text-[11px] block">BIC / SWIFT</span>
            <span class="text-ink dark:text-zinc-200 font-semibold mt-0.5 block tabular-nums">${esc(s.bic || '—')}</span>
          </div>
        </div>
      </div>

    </div>`;

  const prtBtn = $('#btn-print');
  if (prtBtn) prtBtn.addEventListener('click', async () => {
    prtBtn.disabled = true;
    try { await loadPdfLib(); } catch (_) {} // exportNotePDF falls back to print if unavailable
    try { exportNotePDF(); } finally { prtBtn.disabled = false; }
  });

  const addPayBtn = $('#btn-add-payment');
  if (addPayBtn) addPayBtn.addEventListener('click', () => openPaymentModal(ctx, residual, payable));
  const settleBtn = $('#btn-settle-payment');
  if (settleBtn) settleBtn.addEventListener('click', () => settleResidual(ctx, residual, payable));
  const assignNoteBtn = $('#btn-assign-note');
  if (assignNoteBtn) assignNoteBtn.addEventListener('click', () => assignNoteNumber(ctx));
  const revokeNoteBtn = $('#btn-revoke-note');
  if (revokeNoteBtn) revokeNoteBtn.addEventListener('click', () => revokeNoteNumber(ctx.key));
  const dueEl = $('#note-due');
  if (dueEl) dueEl.addEventListener('change', async () => {
    const n = getNote(ctx.key);
    if (!n || !canManagePayment()) return;
    n.dueDate = dueEl.value || null;
    await dbPut('settings', state.settings);
    renderPayment();
    cloudPush();
  });
  root.querySelectorAll('[data-pay-action="del"]').forEach(btn => {
    btn.addEventListener('click', () => deletePayment(btn.dataset.id));
  });

  const syncFiltBtn = $('#btn-sync-dashboard-filters');
  if (syncFiltBtn) syncFiltBtn.addEventListener('click', () => setView('dashboard'));

  const ibanToggle = $('#iban-toggle');
  if (ibanToggle) {
    const screenEl = $('#iban-screen');
    let shown = false;
    ibanToggle.addEventListener('click', () => {
      shown = !shown;
      if (screenEl) screenEl.innerText = shown ? groupIban(s.iban) : maskIban(s.iban);
      ibanToggle.innerText = shown ? t('Nascondi') : t('Mostra');
      ibanToggle.setAttribute('aria-pressed', String(shown));
    });
  }

  const ibanCopy = $('#iban-copy');
  if (ibanCopy && s.iban) {
    ibanCopy.addEventListener('click', () => {
      copyText(s.iban.replace(/\s+/g, '')).then(() => toast(t('IBAN copiato negli appunti')));
    });
  }

  const ibanLogin = $('#iban-login');
  if (ibanLogin) {
    ibanLogin.addEventListener('click', () => {
      toast(t('Esegui il login per visualizzare l\'IBAN'), 'warning');
      setView('settings');
    });
  }
}

/* ---------------------------------------------------------------------
   IMPOSTAZIONI E DATI FISCALI AVANZATI
--------------------------------------------------------------------- */
function renderSettings() {
  const root = $('#view-settings');
  if (!root) return;
  const s = state.settings;
  const client = isClient();
  const manage = canManagePayment();

  if (client) {
    const cp = s.clientProfile || {};
    root.innerHTML = `
      <h2 class="text-[13px] font-bold uppercase tracking-wider text-ink-faint dark:text-zinc-500 mb-4">${t('Profilo e Sicurezza')}</h2>
      ${accountPanelHTML()}

      <div class="bg-white dark:bg-darkCard rounded-xl2 border border-black/5 dark:border-darkBorder p-5 shadow-sm space-y-3">
        <div class="text-[11px] uppercase tracking-wider text-ink-faint dark:text-zinc-500 font-bold">${t('Collegamento al Professionista')}</div>
        ${sync.share && sync.share.linked ? `
          <div class="flex items-center gap-2 text-[13px] text-emerald-600 dark:text-emerald-400 font-bold"><span>●</span> ${t('Collegato — i dati si aggiornano in automatico')}</div>
        ` : `
          <div class="flex items-center gap-2 text-[13px] text-ink-soft dark:text-zinc-400 font-semibold"><span class="text-amber-500">○</span> ${t('In attesa di associazione')}</div>
        `}
        <p class="text-[12px] text-ink-soft dark:text-zinc-400 leading-relaxed">${t('Il collegamento è gestito dal professionista: quando associa la tua email{e}, i dati che ti riguardano compaiono qui in automatico, senza codici né file.', { e: sync.user && sync.user.email ? ` (<span class="font-semibold">${esc(sync.user.email)}</span>)` : '' })}</p>
      </div>

      <div class="bg-white dark:bg-darkCard rounded-xl2 border border-black/5 dark:border-darkBorder p-5 shadow-sm space-y-4">
        <div>
          <div class="text-[11px] uppercase tracking-wider text-ink-faint dark:text-zinc-500 font-bold">${t('I Miei Dati')}</div>
          <p class="text-[12px] text-ink-soft dark:text-zinc-400 mt-1 leading-relaxed">${t('Questi recapiti sono salvati nel tuo account e sincronizzati sui tuoi dispositivi.')}</p>
        </div>
        <div>
          <label for="cp-name" class="block text-[12px] font-semibold text-ink-soft dark:text-zinc-400 mb-1">${t('Nome / Ragione sociale')}</label>
          <input id="cp-name" class="field" value="${esc(cp.name || '')}" placeholder="${esc(t('Es. Mario Rossi / Acme S.r.l.'))}" />
        </div>
        <div>
          <label for="cp-vat" class="block text-[12px] font-semibold text-ink-soft dark:text-zinc-400 mb-1">${t('P.IVA / Codice Fiscale')}</label>
          <input id="cp-vat" class="field tabular-nums" value="${esc(cp.vat || '')}" placeholder="IT01234567890" />
        </div>
        <div>
          <label for="cp-address" class="block text-[12px] font-semibold text-ink-soft dark:text-zinc-400 mb-1">${t('Indirizzo')}</label>
          <input id="cp-address" class="field" value="${esc(cp.address || '')}" placeholder="${esc(t('Via, civico, CAP, città'))}" />
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label for="cp-email" class="block text-[12px] font-semibold text-ink-soft dark:text-zinc-400 mb-1">Email</label>
            <input id="cp-email" type="email" autocomplete="email" class="field" value="${esc(cp.email || '')}" placeholder="${esc(t('nome@email.it'))}" />
          </div>
          <div>
            <label for="cp-phone" class="block text-[12px] font-semibold text-ink-soft dark:text-zinc-400 mb-1">${t('Telefono')}</label>
            <input id="cp-phone" class="field" value="${esc(cp.phone || '')}" placeholder="+39 ..." />
          </div>
        </div>
        <div class="flex justify-end">
          <button id="cp-save" class="px-5 py-2.5 rounded-full bg-accent hover:bg-accent-hover text-white text-[14px] font-bold transition-soft shadow-sm">${t('Salva i miei dati')}</button>
        </div>
      </div>

      <div class="bg-white dark:bg-darkCard rounded-xl2 border border-black/5 dark:border-darkBorder p-5 shadow-sm space-y-4 mt-4">
        <div class="text-[11px] uppercase tracking-wider text-ink-faint dark:text-zinc-500 font-bold">${t('Dati per i Versamenti (Sola Lettura)')}</div>
        <div>
          <div class="text-[11px] text-ink-faint font-semibold">${t('Titolare Beneficiario')}</div>
          <div class="text-[14px] font-bold text-ink dark:text-zinc-100">${esc(s.holderName || '—')}</div>
        </div>
        <div>
          <div class="text-[11px] text-ink-faint font-semibold">IBAN</div>
          <div class="flex items-center gap-2 mt-1">
            <span id="s-iban-screen" class="text-[14px] font-bold text-ink dark:text-zinc-100 tabular-nums break-all">${esc(s.iban ? maskIban(s.iban) : '—')}</span>
            ${s.iban ? `<button id="s-iban-reveal" type="button" aria-pressed="false" class="text-[12px] font-bold text-accent hover:underline">${t('Mostra')}</button>` : ''}
          </div>
        </div>
        <div>
          <div class="text-[11px] text-ink-faint font-semibold">BIC / SWIFT</div>
          <div class="text-[14px] font-bold text-ink dark:text-zinc-100 tabular-nums">${esc(s.bic || '—')}</div>
        </div>
      </div>

      <div class="bg-white dark:bg-darkCard rounded-xl2 border border-black/5 dark:border-darkBorder p-5 shadow-sm mt-4">
        <label for="s-theme-ro" class="block text-[13px] font-medium text-ink-soft dark:text-zinc-400 mb-1.5">${t('Schema di Colori')}</label>
        <select id="s-theme-ro" class="field">
          <option value="auto" ${s.theme === 'auto' ? 'selected' : ''}>${t('Segui sistema (Auto)')}</option>
          <option value="light" ${s.theme === 'light' ? 'selected' : ''}>${t('Tema Chiaro')}</option>
          <option value="dark" ${s.theme === 'dark' ? 'selected' : ''}>${t('Tema Scuro')}</option>
        </select>
        ${langSelectHTML()}
      </div>`;

    const cpSave = $('#cp-save');
    if (cpSave) cpSave.addEventListener('click', saveClientProfile);

    const rev = $('#s-iban-reveal');
    const scr = $('#s-iban-screen');
    if (rev && scr) {
      let shown = false;
      rev.addEventListener('click', () => {
        shown = !shown;
        scr.innerText = shown ? groupIban(s.iban) : maskIban(s.iban);
        rev.innerText = shown ? t('Nascondi') : t('Mostra');
        rev.setAttribute('aria-pressed', String(shown));
      });
    }

    const themeRo = $('#s-theme-ro');
    if (themeRo) themeRo.addEventListener('change', () => {
      state.settings.theme = themeRo.value;
      dbPut('settings', state.settings);
      syncTheme(themeRo.value);
    });

    bindLangSelect();
    bindAccountPanel();
    return;
  }

  const paymentPanel = manage ? `
    <div class="bg-white dark:bg-darkCard rounded-xl2 border border-black/5 dark:border-darkBorder p-5 shadow-sm space-y-4 mt-4">
      <div class="text-[11px] uppercase tracking-wider text-ink-faint dark:text-zinc-500 font-bold">${t('Coordinate Professionali per Nota')}</div>
      <div>
        <label for="s-holder" class="block text-[13px] font-semibold text-ink-soft dark:text-zinc-400 mb-1.5">${t('Intestatario Nota (Mittente)')}</label>
        <input id="s-holder" class="field" value="${esc(s.holderName)}" placeholder="${esc(t('Nome, cognome, P.IVA e informazioni fiscali'))}" />
      </div>
      <div>
        <label for="s-iban" class="block text-[13px] font-semibold text-ink-soft dark:text-zinc-400 mb-1.5">${t('Codice IBAN')}</label>
        <div class="relative">
          <input id="s-iban" type="password" autocomplete="off" class="field tabular-nums pr-24 font-bold" value="${esc(s.iban)}" placeholder="IT.." />
          <button id="s-iban-toggle" type="button" aria-pressed="false" class="absolute inset-y-0 right-0 px-3 my-1 mr-1 rounded-[9px] text-[12px] font-bold text-accent hover:bg-accent-soft transition-soft">${t('Mostra')}</button>
        </div>
      </div>
      <div>
        <label for="s-bic" class="block text-[13px] font-semibold text-ink-soft dark:text-zinc-400 mb-1.5">BIC / SWIFT</label>
        <input id="s-bic" class="field tabular-nums" value="${esc(s.bic)}" placeholder="XXXXXXXX" />
      </div>
    </div>` : `
    <div class="bg-white dark:bg-darkCard rounded-xl2 border border-black/5 dark:border-darkBorder p-5 shadow-sm mt-4">
      <div class="text-[11px] uppercase tracking-wider text-ink-faint dark:text-zinc-500 font-bold mb-2">${t('Coordinate Professionali')}</div>
      <div class="flex items-start gap-3 rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3">
        <span class="text-lg">🔒</span>
        <div>
          <div class="text-[13px] font-bold text-ink dark:text-white">${t('Dati sensibili crittografati')}</div>
          <p class="text-[12px] text-ink-soft dark:text-zinc-400 mt-0.5 leading-relaxed">${t('Solo l\'account del Proprietario può gestire gli estremi di pagamento fiscali.')}</p>
        </div>
      </div>
    </div>`;

  root.innerHTML = `
    <h2 class="text-[13px] font-bold uppercase tracking-wider text-ink-faint dark:text-zinc-500 mb-4">${t('Profilo e Impostazioni Generali')}</h2>

    ${accountPanelHTML()}

    <div class="bg-white dark:bg-darkCard rounded-xl2 border border-black/5 dark:border-darkBorder p-5 shadow-sm space-y-4">
      <div class="text-[11px] uppercase tracking-wider text-ink-faint dark:text-zinc-500 font-bold">${t('Modello Economico Globale')}</div>
      <div>
        <label for="s-regime" class="block text-[12px] font-semibold text-ink-soft dark:text-zinc-400 mb-1">${t('Regime fiscale')}</label>
        <select id="s-regime" class="field">
          <option value="ordinario" ${(s.regime || 'ordinario') === 'ordinario' ? 'selected' : ''}>${t('Ordinario (rivalsa, IVA, ritenuta)')}</option>
          <option value="forfettario" ${s.regime === 'forfettario' ? 'selected' : ''}>${t('Forfettario (esente IVA, senza ritenuta)')}</option>
        </select>
        <p class="text-[11px] text-ink-faint dark:text-zinc-500 mt-1 leading-snug">${t('In {f} la nota non applica IVA né ritenuta d\'acconto: quei campi vengono ignorati nel calcolo. La rivalsa INPS resta opzionale.', { f: `<strong>${t('forfettario')}</strong>` })}</p>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label for="s-coeff" class="block text-[12px] font-semibold text-ink-soft dark:text-zinc-400 mb-1">${t('Coefficiente redditività (%)')}</label>
          <input id="s-coeff" type="number" min="0" max="100" step="1" class="field" value="${esc(s.coefficiente != null ? s.coefficiente : 78)}" />
        </div>
        <div>
          <label for="s-impsost" class="block text-[12px] font-semibold text-ink-soft dark:text-zinc-400 mb-1">${t('Imposta sostitutiva (%)')}</label>
          <input id="s-impsost" type="number" min="0" max="100" step="1" class="field" value="${esc(s.impostaSostitutiva != null ? s.impostaSostitutiva : 5)}" />
        </div>
      </div>
      <p class="text-[11px] text-ink-faint dark:text-zinc-500 -mt-2 leading-snug">${t('Usati nel {r} (Report) per stimare l\'imposta in regime forfettario.', { r: `<strong>${t('Riepilogo fiscale annuale')}</strong>` })}</p>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div>
          <label for="s-rate" class="block text-[12px] font-semibold text-ink-soft dark:text-zinc-400 mb-1">${t('Tariffa base (€/h)')}</label>
          <input id="s-rate" type="number" min="0" step="0.5" class="field" value="${esc(s.hourlyRate)}" />
        </div>
        <div>
          <label for="s-extra" class="block text-[12px] font-semibold text-ink-soft dark:text-zinc-400 mb-1">${t('Extra fisso (€)')}</label>
          <input id="s-extra" type="number" min="0" step="0.5" class="field" value="${esc(s.extra)}" />
        </div>
        <div>
          <label for="s-tax" class="block text-[12px] font-semibold text-ink-soft dark:text-zinc-400 mb-1">${t('Rivalsa INPS (%)')}</label>
          <input id="s-tax" type="number" min="0" max="100" step="1" class="field" value="${esc(s.taxRate || 0)}" />
        </div>
        <div>
          <label for="s-vat" class="block text-[12px] font-semibold text-ink-soft dark:text-zinc-400 mb-1">${t('IVA (%)')}</label>
          <input id="s-vat" type="number" min="0" max="100" step="1" class="field" value="${esc(s.vatRate || 0)}" />
        </div>
      </div>
      <div>
        <label for="s-withholding" class="block text-[12px] font-semibold text-ink-soft dark:text-zinc-400 mb-1">${t('Ritenuta d\'Acconto (%)')} <span class="text-red-500 font-bold">${t('(Sottratta dal netto)')}</span></label>
        <input id="s-withholding" type="number" min="0" max="100" step="1" class="field" value="${esc(s.withholdingTaxRate || 0)}" />
      </div>
      <div>
        <label for="s-rounding" class="block text-[12px] font-semibold text-ink-soft dark:text-zinc-400 mb-1">${t('Arrotondamento cronometro')}</label>
        <select id="s-rounding" class="field">
          <option value="0" ${!Number(s.roundingMinutes) ? 'selected' : ''}>${t('Nessuno (tempo esatto)')}</option>
          <option value="6" ${Number(s.roundingMinutes) === 6 ? 'selected' : ''}>${t('Per eccesso a 6 min (0,1 h)')}</option>
          <option value="15" ${Number(s.roundingMinutes) === 15 ? 'selected' : ''}>${t('Per eccesso a 15 min')}</option>
          <option value="30" ${Number(s.roundingMinutes) === 30 ? 'selected' : ''}>${t('Per eccesso a 30 min')}</option>
          <option value="60" ${Number(s.roundingMinutes) === 60 ? 'selected' : ''}>${t('Per eccesso a 1 ora')}</option>
        </select>
        <p class="text-[11px] text-ink-faint dark:text-zinc-500 mt-1 leading-snug">${t('Le sessioni del cronometro vengono arrotondate per eccesso a questo incremento (resta modificabile prima di salvare).')}</p>
      </div>
    </div>

    <div class="bg-white dark:bg-darkCard rounded-xl2 border border-black/5 dark:border-darkBorder p-5 shadow-sm mt-4 space-y-4">
      <div class="text-[11px] uppercase tracking-wider text-ink-faint dark:text-zinc-500 font-bold">${t('Dati del Documento')}</div>
      <div>
        <label for="s-causale" class="block text-[12px] font-semibold text-ink-soft dark:text-zinc-400 mb-1">${t('Causale predefinita')}</label>
        <input id="s-causale" class="field" value="${esc(s.causale || '')}" placeholder="${esc(t('Es. Prestazione professionale'))}" />
      </div>
      <label for="s-stampduty" class="flex items-start gap-3 cursor-pointer select-none">
        <input id="s-stampduty" type="checkbox" ${s.stampDuty ? 'checked' : ''} class="mt-0.5 w-4 h-4 accent-accent" />
        <span class="text-[13px] text-ink-soft dark:text-zinc-300 leading-snug">${t('Applica {m} sulle note esenti IVA con importo superiore a 77,47 € (regime forfettario / prestazione occasionale).', { m: `<strong class="text-ink dark:text-white">${t('marca da bollo 2,00 €')}</strong>` })}</span>
      </label>
    </div>

    ${paymentPanel}

    <div class="bg-white dark:bg-darkCard rounded-xl2 border border-black/5 dark:border-darkBorder p-5 shadow-sm mt-4">
      <label for="s-theme" class="block text-[13px] font-semibold text-ink-soft dark:text-zinc-400 mb-1.5">${t('Schema di Colori')}</label>
      <select id="s-theme" class="field">
        <option value="auto" ${s.theme === 'auto' ? 'selected' : ''}>${t('Segui sistema (Auto)')}</option>
        <option value="light" ${s.theme === 'light' ? 'selected' : ''}>${t('Tema Chiaro')}</option>
        <option value="dark" ${s.theme === 'dark' ? 'selected' : ''}>${t('Tema Scuro')}</option>
      </select>
      ${langSelectHTML()}
    </div>

    <div class="flex justify-end mt-4">
      <button id="s-save" class="px-5 py-2.5 rounded-full bg-accent hover:bg-accent-hover text-white text-[14px] font-bold transition-soft shadow-sm">${t('Salva Configurazione')}</button>
    </div>

    <div class="bg-white dark:bg-darkCard rounded-xl2 border border-black/5 dark:border-darkBorder p-5 shadow-sm mt-6">
      <div class="text-[11px] uppercase tracking-wider text-ink-faint dark:text-zinc-500 font-bold mb-3">${t('Manutenzione Locale Sicura')}</div>
      <div class="flex flex-wrap gap-2">
        <button id="exp-csv" class="px-4 py-2 rounded-full border border-black/10 dark:border-white/10 hover:bg-black/[.03] dark:hover:bg-white/[.03] text-[13px] font-bold transition-soft">${t('Esporta Tabella CSV')}</button>
        <button id="exp-json" class="px-4 py-2 rounded-full border border-black/10 dark:border-white/10 hover:bg-black/[.03] dark:hover:bg-white/[.03] text-[13px] font-bold transition-soft">${t('Esporta Database JSON')}</button>
        <button id="imp-json" class="px-4 py-2 rounded-full border border-black/10 dark:border-white/10 hover:bg-black/[.03] dark:hover:bg-white/[.03] text-[13px] font-bold transition-soft text-accent">${t('Ripristina da JSON')}</button>
        <input id="imp-file" type="file" accept="application/json,.json" class="hidden" />
      </div>
      <p class="text-[11px] text-ink-faint dark:text-zinc-500 mt-3 font-semibold">${t('Nota: Ripristinando un JSON sovrascriverai in modo definitivo l\'archivio locale.')}</p>
      <div class="border-t border-black/5 dark:border-white/10 mt-4 pt-4">
        <button id="sync-reset" class="px-4 py-2 rounded-full border border-amber-500/40 text-amber-600 dark:text-amber-400 hover:bg-amber-500/10 text-[13px] font-bold transition-soft">${t('Sblocca sincronizzazione')}</button>
        <p class="text-[11px] text-ink-faint dark:text-zinc-500 mt-3 font-semibold leading-relaxed">${t('Svuota la cache cloud e l\'app shell (service worker) e ricarica. Utile se la sincronizzazione resta bloccata su "In Sincronia…".')} <span class="font-bold">${t('I tuoi dati (progetti, ore, clienti…) NON vengono toccati')}</span> ${t('e restano in locale e sul cloud.')}</p>
      </div>
    </div>`;

  const sSave = $('#s-save');
  if (sSave) sSave.addEventListener('click', saveSettings);

  const ibanInput = $('#s-iban');
  const ibanBtn = $('#s-iban-toggle');
  if (ibanInput && ibanBtn) {
    ibanBtn.addEventListener('click', () => {
      const show = ibanInput.type === 'password';
      ibanInput.type = show ? 'text' : 'password';
      ibanBtn.innerText = show ? t('Nascondi') : t('Mostra');
      ibanBtn.setAttribute('aria-pressed', String(show));
    });
  }

  $('#exp-csv').addEventListener('click', exportCSV);
  $('#exp-json').addEventListener('click', exportJSON);
  
  const impJson = $('#imp-json');
  const impFile = $('#imp-file');
  if (impJson && impFile) {
    impJson.addEventListener('click', () => impFile.click());
    impFile.addEventListener('change', importJSON);
  }
  const syncReset = $('#sync-reset');
  if (syncReset) syncReset.addEventListener('click', confirmSyncReset);
  bindLangSelect();
  bindAccountPanel();
}

async function saveSettings() {
  if (!canEdit()) { toast(t('Account autorizzato in sola lettura'), 'error'); return; }
  const rate = Number($('#s-rate').value);
  const extra = Number($('#s-extra').value);
  const tax = Number($('#s-tax').value);
  const vat = Number($('#s-vat').value);
  const withholding = Number($('#s-withholding').value);
  const theme = $('#s-theme').value;
  const regime = ($('#s-regime') && $('#s-regime').value === 'forfettario') ? 'forfettario' : 'ordinario';
  const roundingMinutes = $('#s-rounding') ? (Number($('#s-rounding').value) || 0) : (Number(state.settings.roundingMinutes) || 0);
  const coefficiente = $('#s-coeff') ? (Number($('#s-coeff').value) || 0) : (Number(state.settings.coefficiente) || 78);
  const impostaSostitutiva = $('#s-impsost') ? (Number($('#s-impsost').value) || 0) : (Number(state.settings.impostaSostitutiva) || 5);

  if (isNaN(rate) || rate < 0) { toast(t('Tariffa oraria non corretta'), 'error'); return; }
  if (isNaN(extra) || extra < 0) { toast(t('Valore extra forfettario non valido'), 'error'); return; }
  if (isNaN(tax) || tax < 0 || tax > 100) { toast(t('Rivalsa fiscale non corretta'), 'error'); return; }
  if (isNaN(vat) || vat < 0 || vat > 100) { toast(t('IVA non valida'), 'error'); return; }
  if (isNaN(withholding) || withholding < 0 || withholding > 100) { toast(t('Ritenuta d\'acconto non corretta'), 'error'); return; }

  const holderEl = $('#s-holder'), ibanEl = $('#s-iban'), bicEl = $('#s-bic');
  const causaleEl = $('#s-causale'), stampDutyEl = $('#s-stampduty');

  // Spread dei settings esistenti per non perdere campi non presenti nel form
  // (es. noteRegistry della numerazione note).
  state.settings = {
    ...state.settings,
    id: 'app',
    hourlyRate: rate,
    extra: extra,
    taxRate: tax,
    vatRate: vat,
    withholdingTaxRate: withholding,
    regime: regime,
    roundingMinutes: roundingMinutes,
    coefficiente: coefficiente,
    impostaSostitutiva: impostaSostitutiva,
    holderName: holderEl ? holderEl.value.trim() : (state.settings.holderName || ''),
    iban: ibanEl ? ibanEl.value.trim() : (state.settings.iban || ''),
    bic: bicEl ? bicEl.value.trim() : (state.settings.bic || ''),
    causale: causaleEl ? causaleEl.value.trim() : (state.settings.causale || ''),
    stampDuty: stampDutyEl ? !!stampDutyEl.checked : !!state.settings.stampDuty,
    theme: theme
  };
  
  await dbPut('settings', state.settings);
  syncTheme(theme);
  cloudPush();
  toast(t('Configurazione applicata con successo'));
}

// Salvataggio del profilo personale del Cliente: sono i SUOI recapiti, archiviati
// nel suo account e sincronizzati. Non passa dal gate canEdit() (che protegge i
// dati del Proprietario): un Cliente può sempre gestire i propri dati.
async function saveClientProfile() {
  const val = (id) => { const el = $('#' + id); return el ? el.value.trim() : ''; };
  const email = val('cp-email');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast(t('Formato email non valido'), 'error'); return; }

  // Spread per preservare ogni altro campo delle impostazioni.
  state.settings = {
    ...state.settings,
    id: 'app',
    clientProfile: {
      name: val('cp-name'),
      vat: val('cp-vat'),
      address: val('cp-address'),
      email: email,
      phone: val('cp-phone')
    }
  };

  await dbPut('settings', state.settings);
  cloudPush();
  toast(t('I tuoi dati sono stati salvati'));
}

/* ---------------------------------------------------------------------
   EXPORTS CORE
--------------------------------------------------------------------- */
function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  if (/[";\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function exportCSV() {
  const sep = ';';
  const flat = allEntriesFlat();
  const lines = [];
  lines.push([t('Progetto'), t('Descrizione Attività'), t('Data'), t('Ore'), t('Tariffa applicata'), t('Forfait (€)'), t('Già pagata')].map(csvCell).join(sep));
  for (const e of flat) {
    lines.push([e.project, e.spec, dateIt(e.date), String(e.hours).replace('.', ','), String(e.rate).replace('.', ','), e.billingType === 'flat' ? String(e.amount).replace('.', ',') : '', e.paid ? t('Sì') : t('No')].map(csvCell).join(sep));
  }
  lines.push('');
  lines.push([csvCell(t('Ore Totali Filtrate')), '', '', csvCell(String(totalHours()).replace('.', ','))].join(sep));
  lines.push([csvCell(t('Imponibile Totale (€)')), '', '', csvCell(String(totalCompensation()).replace('.', ','))].join(sep));
  
  download(`hourflow_timesheet_${todayIso()}.csv`, '\uFEFF' + lines.join('\r\n'), 'text/csv;charset=utf-8');
  toast(t('Report CSV esportato correttamente'));
}

function exportJSON() {
  const dump = {
    app: 'hourflow',
    version: 3,
    exportedAt: new Date().toISOString(),
    settings: state.settings,
    projects: state.projects,
    entries: state.entries,
    clients: state.clients,
    payments: state.payments,
    expenses: state.expenses,
    quotes: state.quotes
  };
  download(`hourflow_db_${todayIso()}.json`, JSON.stringify(dump, null, 2), 'application/json');
  toast(t('Archivio esportato in formato JSON'));
}

function validateBackup(obj) {
  if (!obj || typeof obj !== 'object') return { ok: false, error: t('Struttura file non valida.') };
  if (!Array.isArray(obj.projects) || !Array.isArray(obj.entries)) {
    return { ok: false, error: t('Database JSON privo delle tabelle necessarie.') };
  }
  if (!obj.settings || typeof obj.settings !== 'object') {
    return { ok: false, error: t('Nessun file di configurazione rilevato nel pacchetto.') };
  }
  return { ok: true, data: obj };
}

function importJSON(ev) {
  if (!canEdit()) { toast(t('Account autorizzato in sola lettura'), 'error'); return; }
  const file = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let parsed;
    try { parsed = JSON.parse(reader.result); }
    catch (_) { toast(t('File corrotto o non leggibile'), 'error'); return; }
    const res = validateBackup(parsed);
    if (!res.ok) { toast(res.error, 'error'); return; }
    const d = res.data;
    openModal({
      title: t('Confermare Ripristino?'),
      danger: true,
      bodyHTML: `<p class="text-[14px]">${t('Ripristinando questo pacchetto verranno importati {p} progetti, {e} sessioni e {c} clienti. Tutti i dati correnti verranno persi definitivamente.', {
        p: `<span class="font-bold text-accent">${d.projects.length}</span>`,
        e: `<span class="font-bold text-accent">${d.entries.length}</span>`,
        c: `<span class="font-bold text-accent">${(d.clients || []).length}</span>` })}</p>`,
      confirmText: t('Sì, Sovrascrivi database'),
      onConfirm: async () => {
        try {
          await dbClear('projects');
          await dbClear('entries');
          await dbClear('clients');
          await dbClear('payments');
          await dbClear('expenses');
          await dbClear('quotes');
          await dbPut('settings', d.settings);
          // Import difensivo: scarta record non-oggetto e garantisce un id,
          // così un singolo record corrotto non interrompe l'intero ripristino.
          for (const p of d.projects) {
            if (p && typeof p === 'object') { if (!p.id) p.id = genId(); await dbPut('projects', p); }
          }
          for (const e of d.entries) {
            if (e && typeof e === 'object') { if (!e.id) e.id = genId(); await dbPut('entries', e); }
          }
          for (const c of (d.clients || [])) {
            if (c && typeof c === 'object') { if (!c.id) c.id = genId(); await dbPut('clients', c); }
          }
          for (const pay of (d.payments || [])) {
            if (pay && typeof pay === 'object') { if (!pay.id) pay.id = genId(); await dbPut('payments', pay); }
          }
          for (const x of (d.expenses || [])) {
            if (x && typeof x === 'object') { if (!x.id) x.id = genId(); await dbPut('expenses', x); }
          }
          for (const q of (d.quotes || [])) {
            if (q && typeof q === 'object') { if (!q.id) q.id = genId(); await dbPut('quotes', q); }
          }
          await loadState();
          state.expanded.clear();
          render();
          cloudPush();
          toast(t('Archivio ripristinato correttamente!'));
        } catch (err) {
          toast(t('Impossibile ripristinare il file JSON'), 'error');
        }
      }
    });
  };
  reader.readAsText(file);
}

/* ---------------------------------------------------------------------
   REPORT MENSILI
--------------------------------------------------------------------- */
const MONTH_NAMES = ['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno','Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];
const MONTH_NAMES_EN = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function monthLabel(key) {
  const [y, mm] = key.split('-');
  const names = isEn() ? MONTH_NAMES_EN : MONTH_NAMES;
  return `${names[Number(mm) - 1] || mm} ${y}`;
}

/* ---------------------------------------------------------------------
   SPESE / COSTI
--------------------------------------------------------------------- */
const EXPENSE_CATEGORIES = ['Attrezzatura', 'Software', 'Trasferte', 'Servizi', 'Formazione', 'Tasse e contributi', 'Altro'];

function expensesTotal(list) { return (list || state.expenses).reduce((a, x) => a + (Number(x.amount) || 0), 0); }

function expensesByYear() {
  const map = new Map();
  for (const x of state.expenses) {
    const y = String(x.date || '').slice(0, 4);
    if (!/^\d{4}$/.test(y)) continue;
    map.set(y, (map.get(y) || 0) + (Number(x.amount) || 0));
  }
  return map;
}

function renderExpenses() {
  const root = $('#view-expenses');
  if (!root) return;
  const editable = canEdit();
  const list = [...state.expenses].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const total = expensesTotal(list);
  const thisYear = todayIso().slice(0, 4);
  const yearTotal = list.filter(x => String(x.date || '').slice(0, 4) === thisYear).reduce((a, x) => a + (Number(x.amount) || 0), 0);

  const rows = list.length ? list.map(expenseRowHTML).join('') : `
    <div class="bg-white dark:bg-darkCard rounded-xl2 border border-black/5 dark:border-darkBorder px-6 py-12 text-center shadow-sm">
      <div class="flex justify-center mb-3"><svg class="w-12 h-12 text-ink-faint/40 dark:text-zinc-600" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><rect x="2.5" y="5.5" width="19" height="13" rx="2.5"/><path d="M2.5 9.5h19"/></svg></div>
      <p class="text-ink-soft dark:text-ink-faint text-[15px] font-medium">${t('Nessuna spesa registrata.')}</p>
      <p class="text-ink-faint dark:text-zinc-600 text-[13px] mt-1">${editable ? t('Aggiungi costi e trasferte per conoscere il tuo netto reale.') : t('Nessuna informazione presente.')}</p>
    </div>`;

  root.innerHTML = `
    <div class="flex items-center justify-between mb-4">
      <h2 class="text-[13px] font-bold uppercase tracking-wider text-ink-faint dark:text-zinc-500">${t('Spese & Costi')}</h2>
      ${editable ? `
        <button id="btn-add-expense" class="text-[14px] font-bold text-accent hover:text-accent-hover transition-soft flex items-center gap-1">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15"/></svg>
          ${t('Nuova spesa')}
        </button>` : ''}
    </div>
    <div class="grid grid-cols-3 gap-3 mb-5">
      ${summaryCard(t('Totale spese'), eur(total), 'text-red-500')}
      ${summaryCard(t('Anno {y}', { y: thisYear }), eur(yearTotal), 'text-ink dark:text-white')}
      ${summaryCard(t('Voci'), String(list.length), 'text-ink dark:text-white')}
    </div>
    <div class="space-y-2">${rows}</div>`;

  const addBtn = $('#btn-add-expense');
  if (addBtn) addBtn.addEventListener('click', () => editExpenseModal(null));
  root.removeEventListener('click', handleExpenseAction);
  root.addEventListener('click', handleExpenseAction);
}

function expenseRowHTML(x) {
  const editable = canEdit();
  const proj = x.projectId ? state.projects.find(p => p.id === x.projectId) : null;
  return `
    <div class="bg-white dark:bg-darkCard rounded-xl2 border border-black/5 dark:border-darkBorder p-4 shadow-sm flex items-center gap-3">
      <div class="min-w-0 flex-1">
        <div class="text-[14px] font-bold text-ink dark:text-white truncate">${esc(x.description || t('(senza descrizione)'))}</div>
        <div class="text-[11px] text-ink-faint dark:text-zinc-500 font-medium mt-0.5 flex items-center gap-1.5 flex-wrap">
          <span>${esc(dateIt(x.date))}</span><span>·</span>
          <span class="px-2 py-0.5 rounded-full bg-black/5 dark:bg-white/10">${esc(t(x.category || 'Altro'))}</span>
          ${proj ? `<span>·</span><span class="truncate">${esc(proj.name)}</span>` : ''}
        </div>
      </div>
      <div class="text-[15px] font-extrabold text-red-500 tabular-nums shrink-0">${esc(eur(x.amount))}</div>
      ${editable ? `
        <div class="flex items-center gap-1 shrink-0">
          <button data-expense-action="edit" data-id="${esc(x.id)}" class="w-8 h-8 rounded-full hover:bg-black/5 dark:hover:bg-white/5 flex items-center justify-center text-ink-faint hover:text-ink dark:hover:text-white transition-soft" title="${esc(t('Modifica'))}">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z"/></svg>
          </button>
          <button data-expense-action="delete" data-id="${esc(x.id)}" class="w-8 h-8 rounded-full hover:bg-red-500/10 flex items-center justify-center text-ink-faint hover:text-red-500 transition-soft" title="${esc(t('Elimina'))}">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
          </button>
        </div>` : ''}
    </div>`;
}

function handleExpenseAction(e) {
  const btn = e.target.closest('[data-expense-action]');
  if (!btn) return;
  const action = btn.dataset.expenseAction;
  const id = btn.dataset.id;
  if (action === 'edit') editExpenseModal(id);
  else if (action === 'delete') deleteExpense(id);
}

function editExpenseModal(id) {
  if (!canEdit()) { toast(t('Account in sola lettura'), 'error'); return; }
  const x = id ? state.expenses.find(e => e.id === id) : null;
  const projOpts = [`<option value="">${t('Nessun progetto')}</option>`]
    .concat(state.projects.map(p => `<option value="${esc(p.id)}" ${x && x.projectId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`)).join('');
  // Il valore salvato resta la categoria italiana (dato stabile); si traduce solo l'etichetta.
  const catOpts = EXPENSE_CATEGORIES.map(c => `<option value="${esc(c)}" ${x && x.category === c ? 'selected' : ''}>${esc(t(c))}</option>`).join('');
  openModal({
    title: x ? t('Modifica spesa') : t('Nuova spesa'),
    bodyHTML: `
      <label for="fx-desc" class="block text-[13px] font-semibold text-ink-soft mb-1.5">${t('Descrizione')}</label>
      <input id="fx-desc" class="field mb-3" placeholder="${esc(t('Es. Abbonamento software'))}" value="${x ? esc(x.description || '') : ''}" />
      <div class="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label for="fx-amount" class="block text-[13px] font-semibold text-ink-soft mb-1.5">${t('Importo (€)')}</label>
          <input id="fx-amount" type="number" min="0" step="0.01" class="field" value="${x ? esc(x.amount) : ''}" />
        </div>
        <div>
          <label for="fx-date" class="block text-[13px] font-semibold text-ink-soft mb-1.5">${t('Data')}</label>
          <input id="fx-date" type="date" class="field" value="${x ? esc(x.date || todayIso()) : todayIso()}" />
        </div>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label for="fx-category" class="block text-[13px] font-semibold text-ink-soft mb-1.5">${t('Categoria')}</label>
          <select id="fx-category" class="field">${catOpts}</select>
        </div>
        <div>
          <label for="fx-project" class="block text-[13px] font-semibold text-ink-soft mb-1.5">${t('Progetto (opzionale)')}</label>
          <select id="fx-project" class="field">${projOpts}</select>
        </div>
      </div>`,
    confirmText: x ? t('Salva spesa') : t('Aggiungi spesa'),
    onConfirm: async (card) => {
      const desc = $('#fx-desc', card).value.trim();
      const amount = Number($('#fx-amount', card).value);
      const date = $('#fx-date', card).value || todayIso();
      if (!desc) { showError(card, t('La descrizione è obbligatoria.')); return false; }
      if (isNaN(amount) || amount <= 0) { showError(card, t('Inserisci un importo maggiore di 0.')); return false; }
      const data = {
        id: x ? x.id : genId(),
        description: desc,
        amount: Math.round(amount * 100) / 100,
        date,
        category: $('#fx-category', card).value || 'Altro',
        projectId: $('#fx-project', card).value || null
      };
      await dbPut('expenses', data);
      if (x) Object.assign(x, data); else state.expenses.push(data);
      renderExpenses();
      cloudPush();
      toast(t('Spesa salvata'));
    }
  });
}

function deleteExpense(id) {
  if (!canEdit()) { toast(t('Account in sola lettura'), 'error'); return; }
  const x = state.expenses.find(e => e.id === id);
  if (!x) return;
  openModal({
    title: t('Eliminare la spesa?'),
    danger: true,
    bodyHTML: `<p class="text-[14px]">${t('Eliminare {p}? L\'operazione non è reversibile.', { p: `<span class="font-bold">${esc(x.description || t('questa spesa'))}</span> (${esc(eur(x.amount))})` })}</p>`,
    confirmText: t('Elimina'),
    onConfirm: async () => {
      await dbDel('expenses', id);
      state.expenses = state.expenses.filter(e => e.id !== id);
      renderExpenses();
      cloudPush();
      toast(t('Spesa eliminata'));
    }
  });
}

/* ---------------------------------------------------------------------
   PREVENTIVI (quotes) — documenti standalone con voci, stato e PDF.
--------------------------------------------------------------------- */
const QUOTE_STATUSES = {
  bozza:     { t: 'Bozza',     cls: 'bg-black/5 dark:bg-white/5 text-ink-soft dark:text-zinc-400 border-black/10 dark:border-white/10' },
  inviato:   { t: 'Inviato',   cls: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30' },
  accettato: { t: 'Accettato', cls: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30' },
  rifiutato: { t: 'Rifiutato', cls: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30' }
};

function quoteNumFmt(n, year) { return `PREV-${String(n || 0).padStart(4, '0')}/${year}`; }
function nextQuoteSeq(year) {
  let max = 0;
  for (const q of state.quotes) { if (q.year === year && (q.number || 0) > max) max = q.number; }
  return max + 1;
}
function quoteTotal(q) {
  const subtotal = round2((q.items || []).reduce((a, it) => a + (Number(it.qty) || 0) * (Number(it.unitPrice) || 0), 0));
  const { vatP } = effectiveFiscal(state.settings);
  const vat = q.applyVat ? round2(subtotal * vatP / 100) : 0;
  return { subtotal, vat, total: round2(subtotal + vat) };
}

function renderQuotes() {
  const root = $('#view-quotes');
  if (!root) return;
  const editable = canEdit();
  const list = [...state.quotes].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const accepted = list.filter(q => q.status === 'accettato').reduce((a, q) => a + quoteTotal(q).total, 0);

  const cards = list.length ? list.map(quoteCardHTML).join('') : `
    <div class="bg-white dark:bg-darkCard rounded-xl2 border border-black/5 dark:border-darkBorder px-6 py-12 text-center shadow-sm">
      <div class="flex justify-center mb-3"><svg class="w-12 h-12 text-ink-faint/40 dark:text-zinc-600" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="16" rx="2"/><rect x="9" y="3" width="6" height="4" rx="1.5"/><path d="M9 12h6M9 16h4"/></svg></div>
      <p class="text-ink-soft dark:text-ink-faint text-[15px] font-medium">${t('Nessun preventivo.')}</p>
      <p class="text-ink-faint dark:text-zinc-600 text-[13px] mt-1">${editable ? t('Crea un preventivo per un cliente, esportalo in PDF e seguine lo stato.') : t('Nessuna informazione presente.')}</p>
    </div>`;

  root.innerHTML = `
    <div class="flex items-center justify-between mb-4">
      <h2 class="text-[13px] font-bold uppercase tracking-wider text-ink-faint dark:text-zinc-500">${t('Preventivi')}</h2>
      ${editable ? `
        <button id="btn-add-quote" class="text-[14px] font-bold text-accent hover:text-accent-hover transition-soft flex items-center gap-1">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15"/></svg>
          ${t('Nuovo preventivo')}
        </button>` : ''}
    </div>
    <div class="grid grid-cols-2 gap-3 mb-5">
      ${summaryCard(t('Preventivi'), String(list.length), 'text-ink dark:text-white')}
      ${summaryCard(t('Accettati (valore)'), eur(accepted), 'text-accent')}
    </div>
    <div class="space-y-3">${cards}</div>`;

  const addBtn = $('#btn-add-quote');
  if (addBtn) addBtn.addEventListener('click', () => editQuoteModal(null));
  root.removeEventListener('click', handleQuoteAction);
  root.addEventListener('click', handleQuoteAction);
}

function quoteCardHTML(q) {
  const editable = canEdit();
  const client = state.clients.find(c => c.id === q.clientId);
  const qt = quoteTotal(q);
  const st = QUOTE_STATUSES[q.status] || QUOTE_STATUSES.bozza;
  return `
    <div class="bg-white dark:bg-darkCard rounded-xl2 border border-black/5 dark:border-darkBorder p-4 shadow-sm">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="text-[14px] font-extrabold text-ink dark:text-white tabular-nums">${esc(quoteNumFmt(q.number, q.year))}</span>
            <span class="text-[10px] font-extrabold uppercase tracking-wider px-2 py-0.5 rounded-full border ${st.cls}">${t(st.t)}</span>
          </div>
          <div class="text-[12px] text-ink-soft dark:text-zinc-400 mt-0.5 truncate">${esc(client ? client.name : t('Cliente non assegnato'))}</div>
          <div class="text-[11px] text-ink-faint dark:text-zinc-500 mt-0.5">${esc(dateIt(q.date))}${q.validUntil ? ` · ${t('valido fino al {d}', { d: esc(dateIt(q.validUntil)) })}` : ''} · ${esc(plural((q.items || []).length, t('voce'), t('voci')))}</div>
        </div>
        <div class="text-right shrink-0">
          <div class="text-[16px] font-extrabold text-accent tabular-nums">${esc(eur(qt.total))}</div>
          ${qt.vat > 0 ? `<div class="text-[10px] text-ink-faint">${t('IVA incl.')}</div>` : ''}
        </div>
      </div>
      <div class="mt-3 pt-3 border-t border-black/5 dark:border-white/5 flex items-center gap-2 flex-wrap no-print">
        <button data-quote-action="pdf" data-id="${esc(q.id)}" class="text-[12px] font-bold text-ink-soft dark:text-zinc-300 hover:text-accent transition-soft flex items-center gap-1.5">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M7 9V3h10v6"/><rect x="4" y="9" width="16" height="8" rx="2"/><path d="M7 14h10v6H7z"/></svg>
          PDF
        </button>
        ${editable ? `
        <button data-quote-action="edit" data-id="${esc(q.id)}" class="text-[12px] font-bold text-ink-soft dark:text-zinc-300 hover:text-accent transition-soft">${t('Modifica')}</button>
        ${q.status === 'accettato' ? (q.convertedProjectId
          ? `<span class="text-[12px] font-bold text-emerald-600 dark:text-emerald-400 flex items-center gap-1"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>${t('Progetto creato')}</span>`
          : `<button data-quote-action="to-project" data-id="${esc(q.id)}" class="text-[12px] font-bold text-accent hover:text-accent-hover transition-soft flex items-center gap-1"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15"/></svg>${t('Crea progetto')}</button>`) : ''}
        <div class="flex-1"></div>
        <button data-quote-action="delete" data-id="${esc(q.id)}" class="text-[12px] font-bold text-ink-faint hover:text-red-500 transition-soft">${t('Elimina')}</button>` : ''}
      </div>
    </div>`;
}

function handleQuoteAction(e) {
  const btn = e.target.closest('[data-quote-action]');
  if (!btn) return;
  const action = btn.dataset.quoteAction;
  const id = btn.dataset.id;
  if (action === 'edit') editQuoteModal(id);
  else if (action === 'delete') deleteQuote(id);
  else if (action === 'pdf') exportQuotePDF(id);
  else if (action === 'to-project') createProjectFromQuote(id);
}

function quoteItemRowHTML(it) {
  it = it || {};
  return `
    <div class="q-item grid grid-cols-12 gap-1.5 mb-2 items-center">
      <input class="q-desc field col-span-6 !py-1.5 text-[13px]" placeholder="${esc(t('Descrizione'))}" value="${esc(it.description || '')}" />
      <input class="q-qty field col-span-2 !py-1.5 text-[13px] text-center" type="number" min="0" step="0.5" placeholder="${esc(t('Q.tà'))}" value="${it.qty != null ? esc(it.qty) : ''}" />
      <input class="q-price field col-span-3 !py-1.5 text-[13px] text-right" type="number" min="0" step="0.01" placeholder="€" value="${it.unitPrice != null ? esc(it.unitPrice) : ''}" />
      <button type="button" class="q-del col-span-1 text-ink-faint hover:text-red-500 transition-soft flex items-center justify-center" title="${esc(t('Rimuovi voce'))}">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
      </button>
    </div>`;
}

function readQuoteItems(card) {
  return $$('.q-item', card).map(row => ({
    description: $('.q-desc', row).value.trim(),
    qty: Number($('.q-qty', row).value) || 0,
    unitPrice: Number($('.q-price', row).value) || 0
  })).filter(it => it.description || it.qty || it.unitPrice);
}

function editQuoteModal(id) {
  if (!canEdit()) { toast(t('Account in sola lettura'), 'error'); return; }
  const q = id ? state.quotes.find(x => x.id === id) : null;
  const clientOpts = [`<option value="">${t('— Seleziona cliente —')}</option>`]
    .concat(state.clients.map(c => `<option value="${esc(c.id)}" ${q && q.clientId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`)).join('');
  const statusOpts = Object.keys(QUOTE_STATUSES)
    .map(k => `<option value="${k}" ${(q ? q.status : 'bozza') === k ? 'selected' : ''}>${t(QUOTE_STATUSES[k].t)}</option>`).join('');
  const items = (q && q.items && q.items.length) ? q.items : [{}];
  const { vatP } = effectiveFiscal(state.settings);

  openModal({
    title: q ? t('Modifica {n}', { n: quoteNumFmt(q.number, q.year) }) : t('Nuovo preventivo'),
    bodyHTML: `
      <div class="grid grid-cols-2 gap-3 mb-3">
        <div class="col-span-2">
          <label for="q-client" class="block text-[13px] font-semibold text-ink-soft mb-1.5">${t('Cliente')}</label>
          <select id="q-client" class="field">${clientOpts}</select>
        </div>
        <div>
          <label for="q-date" class="block text-[13px] font-semibold text-ink-soft mb-1.5">${t('Data')}</label>
          <input id="q-date" type="date" class="field" value="${q ? esc(q.date || todayIso()) : todayIso()}" />
        </div>
        <div>
          <label for="q-valid" class="block text-[13px] font-semibold text-ink-soft mb-1.5">${t('Valido fino al')}</label>
          <input id="q-valid" type="date" class="field" value="${q ? esc(q.validUntil || '') : ''}" />
        </div>
      </div>

      <label class="block text-[13px] font-semibold text-ink-soft mb-1.5">${t('Voci')}</label>
      <div class="grid grid-cols-12 gap-1.5 mb-1 text-[10px] uppercase tracking-wide text-ink-faint font-bold px-1">
        <span class="col-span-6">${t('Descrizione')}</span><span class="col-span-2 text-center">Q.tà</span><span class="col-span-3 text-right">${t('Prezzo')}</span><span class="col-span-1"></span>
      </div>
      <div id="q-items">${items.map(quoteItemRowHTML).join('')}</div>
      <button type="button" id="q-add-item" class="text-[12px] font-bold text-accent hover:text-accent-hover transition-soft flex items-center gap-1 mb-3">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15"/></svg>
        ${t('Aggiungi voce')}
      </button>

      <label for="q-vat" class="flex items-center gap-2 cursor-pointer select-none mb-3">
        <input id="q-vat" type="checkbox" ${q && q.applyVat ? 'checked' : ''} class="w-4 h-4 accent-accent" />
        <span class="text-[13px] text-ink-soft dark:text-zinc-300">Applica IVA (${vatP || 0}%) al totale</span>
      </label>

      <div class="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label for="q-status" class="block text-[13px] font-semibold text-ink-soft mb-1.5">${t('Stato')}</label>
          <select id="q-status" class="field">${statusOpts}</select>
        </div>
        <div class="flex flex-col justify-end">
          <div class="text-right text-[11px] text-ink-faint uppercase tracking-wide font-bold">${t('Totale')}</div>
          <div id="q-total" class="text-right text-[18px] font-extrabold text-accent tabular-nums">${esc(eur(0))}</div>
        </div>
      </div>

      <label for="q-notes" class="block text-[13px] font-semibold text-ink-soft mb-1.5">${t('Note (opzionale)')}</label>
      <textarea id="q-notes" class="field h-16 resize-none" placeholder="${esc(t('Condizioni, tempistiche, modalità di pagamento…'))}">${q ? esc(q.notes || '') : ''}</textarea>`,
    confirmText: q ? t('Salva preventivo') : t('Crea preventivo'),
    onMount: (card) => {
      const recompute = () => {
        const its = readQuoteItems(card);
        const subtotal = its.reduce((a, it) => a + it.qty * it.unitPrice, 0);
        const vat = $('#q-vat', card).checked ? subtotal * (vatP || 0) / 100 : 0;
        const tEl = $('#q-total', card);
        if (tEl) tEl.textContent = eur(subtotal + vat);
      };
      const addBtn = $('#q-add-item', card);
      if (addBtn) addBtn.addEventListener('click', () => {
        const cont = $('#q-items', card);
        cont.insertAdjacentHTML('beforeend', quoteItemRowHTML());
        recompute();
      });
      const itemsCont = $('#q-items', card);
      if (itemsCont) itemsCont.addEventListener('click', (e) => {
        const del = e.target.closest('.q-del');
        if (!del) return;
        const row = del.closest('.q-item');
        if (row) row.remove();
        recompute();
      });
      card.addEventListener('input', recompute);
      recompute();
    },
    onConfirm: async (card) => {
      const clientId = $('#q-client', card).value;
      const date = $('#q-date', card).value || todayIso();
      const its = readQuoteItems(card);
      if (!clientId) { showError(card, t('Seleziona un cliente.')); return false; }
      if (!its.length) { showError(card, t('Aggiungi almeno una voce con importo.')); return false; }
      const year = Number(date.slice(0, 4)) || Number(todayIso().slice(0, 4));
      const data = {
        id: q ? q.id : genId(),
        number: q ? q.number : nextQuoteSeq(year),
        year: q ? q.year : year,
        clientId,
        date,
        validUntil: $('#q-valid', card).value || null,
        items: its,
        applyVat: $('#q-vat', card).checked,
        status: $('#q-status', card).value || 'bozza',
        notes: $('#q-notes', card).value.trim()
      };
      await dbPut('quotes', data);
      if (q) Object.assign(q, data); else state.quotes.push(data);
      renderQuotes();
      cloudPush();
      toast(q ? t('Preventivo aggiornato') : t('Preventivo {n} creato', { n: quoteNumFmt(data.number, data.year) }));
    }
  });
}

function deleteQuote(id) {
  if (!canEdit()) { toast(t('Account in sola lettura'), 'error'); return; }
  const q = state.quotes.find(x => x.id === id);
  if (!q) return;
  openModal({
    title: t('Eliminare il preventivo?'),
    danger: true,
    bodyHTML: `<p class="text-[14px]">${t('Eliminare {p}? L\'operazione non è reversibile.', { p: `<span class="font-bold">${esc(quoteNumFmt(q.number, q.year))}</span>` })}</p>`,
    confirmText: t('Elimina'),
    onConfirm: async () => {
      await dbDel('quotes', id);
      state.quotes = state.quotes.filter(x => x.id !== id);
      renderQuotes();
      cloudPush();
      toast(t('Preventivo eliminato'));
    }
  });
}

// Bridge: turn an accepted quote into a new project pre-linked to its client.
// The note/billing flow stays hour-based; this just sets up the project to track on.
function createProjectFromQuote(id) {
  if (!canEdit()) { toast(t('Account in sola lettura'), 'error'); return; }
  const q = state.quotes.find(x => x.id === id);
  if (!q) return;
  if (q.convertedProjectId && state.projects.some(p => p.id === q.convertedProjectId)) {
    toast(t('Progetto già creato da questo preventivo'), 'warning'); return;
  }
  const client = state.clients.find(c => c.id === q.clientId);
  const defaultName = (q.items && q.items[0] && q.items[0].description)
    ? q.items[0].description
    : `Da ${quoteNumFmt(q.number, q.year)}`;
  const qTot = quoteTotal(q).total;
  openModal({
    title: t('Crea progetto dal preventivo'),
    bodyHTML: `
      <p class="text-[13px] text-ink-soft dark:text-zinc-400 mb-3">${t('Verrà creato un progetto collegato a {c}, dal preventivo {q}.', {
        c: `<span class="font-bold text-ink dark:text-white">${esc(client ? client.name : t('cliente non assegnato'))}</span>`,
        q: `<span class="font-bold">${esc(quoteNumFmt(q.number, q.year))}</span>` })}</p>
      <label for="qp-name" class="block text-[13px] font-semibold text-ink-soft mb-1.5">${t('Nome progetto')}</label>
      <input id="qp-name" class="field mb-3" value="${esc(defaultName)}" />

      <label class="block text-[13px] font-semibold text-ink-soft mb-1.5">${t('Tipo di compenso')}</label>
      <div class="seg gap-0 text-[13px] font-semibold mb-3" id="f-billing">
        <button type="button" data-bt="hourly" aria-selected="false" onclick="projBilling(this,'hourly')" class="flex-1 py-2">${t('A ore')}</button>
        <button type="button" data-bt="flat" aria-selected="true" onclick="projBilling(this,'flat')" class="flex-1 py-2">${t('A forfait')}</button>
      </div>
      <div id="f-rate-wrap" class="hidden">
        <label for="f-rate" class="block text-[13px] font-semibold text-ink-soft mb-1.5">${t('Tariffa oraria dedicata (€/h)')} <span class="text-ink-faint">${t('(vuoto = globale)')}</span></label>
        <input id="f-rate" type="number" min="0" step="0.5" class="field mb-3" placeholder="${esc(t('Es. 35'))}" />
      </div>
      <div id="f-flat-wrap">
        <label for="f-flat" class="block text-[13px] font-semibold text-ink-soft mb-1.5">${t('Importo a forfait (€)')}</label>
        <input id="f-flat" type="number" min="0" step="1" class="field" value="${qTot}" />
        <p class="text-[11px] text-ink-faint mt-1">${t('Preimpostato sul totale del preventivo.')}</p>
      </div>`,
    confirmText: t('Crea progetto'),
    onConfirm: async (card) => {
      const name = $('#qp-name', card).value.trim();
      if (!name) { showError(card, t('Il nome del progetto è obbligatorio.')); return false; }
      const btSel = $('#f-billing button[aria-selected="true"]', card);
      const billingType = btSel ? btSel.dataset.bt : 'flat';
      const flatAmount = Number($('#f-flat', card).value) || 0;
      const rate = $('#f-rate', card).value;
      if (billingType === 'flat' && flatAmount <= 0) { showError(card, t('Indica l\'importo a forfait.')); return false; }
      const p = { id: genId(), name, createdAt: todayIso(), hourlyRate: rate !== '' ? Number(rate) : null, clientId: q.clientId || null, billingType, flatAmount: billingType === 'flat' ? flatAmount : 0 };
      await dbPut('projects', p);
      state.projects.push(p);
      state.expanded.add(p.id);
      q.convertedProjectId = p.id;
      await dbPut('quotes', q);
      setView('dashboard');
      cloudPush();
      toast(t('Progetto creato dal preventivo'));
    }
  });
}

async function exportQuotePDF(id) {
  const q = state.quotes.find(x => x.id === id);
  if (!q) return;
  try { await loadPdfLib(); } catch (_) {}
  if (!(window.jspdf && window.jspdf.jsPDF)) { toast(t('Modulo PDF non disponibile'), 'error'); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const M = 40;
  const accent = [255, 149, 0], ink = [29, 29, 31], soft = [110, 110, 115];
  const s = state.settings;
  const tot = quoteTotal(q);
  const client = state.clients.find(c => c.id === q.clientId);
  const money = (n) => (Number(n) || 0).toLocaleString(numLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' EUR';

  doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.setTextColor(...accent);
  doc.text(t('PREVENTIVO'), M, 52);
  let ry = 44; doc.setFontSize(10);
  doc.setFont('helvetica', 'bold'); doc.setTextColor(...ink);
  doc.text(quoteNumFmt(q.number, q.year), W - M, ry, { align: 'right' }); ry += 14;
  doc.setFont('helvetica', 'normal'); doc.setTextColor(...soft);
  doc.text(`${t('Data')}: ${dateIt(q.date)}`, W - M, ry, { align: 'right' }); ry += 14;
  if (q.validUntil) doc.text(`${t('Valido fino al')}: ${dateIt(q.validUntil)}`, W - M, ry, { align: 'right' });

  const y = 88;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(...soft); doc.text(t('DA'), M, y);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...ink); doc.text(s.holderName || '-', M, y + 14);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(...soft); doc.text(t('PER'), M, y + 36);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...ink); doc.text(client ? client.name : '-', M, y + 50);
  let dy = y + 64;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...soft);
  if (client && client.address) { doc.text(String(client.address), M, dy); dy += 12; }
  if (client && client.vatCode) { doc.text(t('P.IVA/CF') + ': ' + client.vatCode, M, dy); dy += 12; }
  if (client && client.foreignVat) { doc.text(t('IVA estera') + ': ' + client.foreignVat, M, dy); dy += 12; }

  const body = (q.items || []).map(it => [it.description || '', String(it.qty || 0), money(it.unitPrice), money((Number(it.qty) || 0) * (Number(it.unitPrice) || 0))]);
  doc.autoTable({
    startY: Math.max(dy + 10, y + 92),
    head: [[t('Descrizione'), t('Q.tà'), t('Prezzo'), t('Importo')]],
    body: body.length ? body : [['—', '—', '—', '—']],
    theme: 'grid',
    headStyles: { fillColor: [245, 245, 247], textColor: ink, fontStyle: 'bold', fontSize: 8 },
    bodyStyles: { fontSize: 9, textColor: ink },
    columnStyles: { 1: { halign: 'center' }, 2: { halign: 'right' }, 3: { halign: 'right' } },
    margin: { left: M, right: M }
  });

  let ty = doc.lastAutoTable.finalY + 18;
  const rightVal = (label, val, bold) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(bold ? 12 : 10);
    doc.setTextColor(...(bold ? accent : ink));
    doc.text(label, W - M - 150, ty); doc.text(val, W - M, ty, { align: 'right' }); ty += bold ? 20 : 15;
  };
  rightVal(t('Imponibile'), money(tot.subtotal), false);
  if (tot.vat > 0) rightVal(t('IVA'), money(tot.vat), false);
  rightVal(t('Totale'), money(tot.total), true);

  if (q.notes) {
    ty += 8; doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...soft);
    doc.text(doc.splitTextToSize(`${t('Note')}: ${q.notes}`, W - 2 * M), M, ty);
  }

  doc.save(`${isEn() ? 'quote' : 'preventivo'}_${quoteNumFmt(q.number, q.year).replace('/', '-')}.pdf`);
  toast(t('Preventivo esportato in PDF'));
}

function monthlyAggregate() {
  const flat = allEntriesFlat();
  const map = new Map();
  for (const e of flat) {
    const key = String(e.date || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(key)) continue;
    if (!map.has(key)) map.set(key, { hours: 0, comp: 0, count: 0 });
    const m = map.get(key);
    m.hours += Number(e.hours) || 0;
    m.comp += entryValue(e);
    m.count += 1;
  }
  for (const p of state.projects) {
    if (p.billingType !== 'flat') continue;
    const key = String(p.createdAt || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(key)) continue;
    if (!map.has(key)) map.set(key, { hours: 0, comp: 0, count: 0 });
    map.get(key).comp += Number(p.flatAmount) || 0;
  }
  return map;
}

function yearlyAggregate() {
  const flat = allEntriesFlat();
  const map = new Map();
  for (const e of flat) {
    const key = String(e.date || '').slice(0, 4);
    if (!/^\d{4}$/.test(key)) continue;
    if (!map.has(key)) map.set(key, { hours: 0, comp: 0, count: 0 });
    const m = map.get(key);
    m.hours += Number(e.hours) || 0;
    m.comp += entryValue(e);
    m.count += 1;
  }
  for (const p of state.projects) {
    if (p.billingType !== 'flat') continue;
    const key = String(p.createdAt || '').slice(0, 4);
    if (!/^\d{4}$/.test(key)) continue;
    if (!map.has(key)) map.set(key, { hours: 0, comp: 0, count: 0 });
    map.get(key).comp += Number(p.flatAmount) || 0;
  }
  return map;
}

// Regime-aware fiscal estimate for a yearly gross compensation, using current settings.
function annualFiscal(comp) {
  const s = state.settings;
  const { forfettario, taxP, vatP, wTaxP } = effectiveFiscal(s);
  if (forfettario) {
    const coeff = Number(s.coefficiente) || 0;
    const impRate = Number(s.impostaSostitutiva) || 0;
    const imponibile = comp * coeff / 100;
    const imposta = imponibile * impRate / 100;
    return { forfettario, comp, imponibile, imposta, coeff, impRate };
  }
  const rivalsa = comp * taxP / 100;
  const sub = comp + rivalsa;
  const iva = sub * vatP / 100;
  const ritenuta = sub * wTaxP / 100;
  const netto = sub + iva - ritenuta;
  return { forfettario, comp, rivalsa, iva, ritenuta, netto, taxP, vatP, wTaxP };
}

// Annual fiscal recap card list (one per year), ordered most-recent first.
function annualSummaryHTML() {
  const ymap = yearlyAggregate();
  const years = [...ymap.keys()].sort().reverse();
  if (!years.length) return '';
  const forf = (state.settings.regime || 'ordinario') === 'forfettario';
  const exp = expensesByYear();
  const line = (label, val, cls = '') =>
    `<div class="flex justify-between text-[12px] py-0.5"><span class="text-ink-soft dark:text-zinc-400">${esc(label)}</span><span class="font-semibold tabular-nums ${cls} dark:text-zinc-200">${esc(eur(val))}</span></div>`;
  const cards = years.map(y => {
    const f = annualFiscal(ymap.get(y).comp);
    const body = forf
      ? line(t('Compenso lordo'), f.comp) + line(t('Imponibile ({p}%)', { p: f.coeff }), f.imponibile) + line(t('Imposta sostitutiva ({p}%)', { p: f.impRate }), f.imposta, 'text-red-500')
      : line(t('Compenso'), f.comp)
        + (f.rivalsa ? line(t('Rivalsa ({p}%)', { p: f.taxP }), f.rivalsa) : '')
        + (f.iva ? line(t('IVA ({p}%)', { p: f.vatP }), f.iva) : '')
        + (f.ritenuta ? line(t('Ritenuta ({p}%)', { p: f.wTaxP }), f.ritenuta, 'text-red-500') : '')
        + line(t('Netto stimato'), f.netto, 'text-accent');
    const sp = exp.get(y) || 0;
    const speseBlock = sp ? line(t('Spese anno'), sp, 'text-red-500') + line(t('Compenso netto spese'), (f.comp - sp), 'text-accent') : '';
    return `
      <div class="bg-white dark:bg-darkCard rounded-xl2 border border-black/5 dark:border-darkBorder p-4 shadow-sm">
        <div class="flex items-baseline justify-between mb-2">
          <div class="text-[15px] font-bold tracking-tight dark:text-white">${esc(y)}</div>
          <div class="text-[10px] uppercase tracking-wide font-bold text-ink-faint">${forf ? t('Forfettario') : t('Ordinario')}</div>
        </div>
        ${body}${speseBlock}
      </div>`;
  }).join('');
  return `
    <div class="flex items-center justify-between mt-8 mb-3 gap-3">
      <h2 class="text-[13px] font-bold uppercase tracking-wider text-ink-faint dark:text-zinc-500">${t('Riepilogo fiscale annuale')}</h2>
      <button id="ann-export" class="text-[13px] font-bold text-accent hover:text-accent-hover transition-soft flex items-center gap-1.5">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M4 14v4a2 2 0 002 2h12a2 2 0 002-2v-4"/><path d="M12 4v10"/><path d="M8 10l4 4 4-4"/></svg>
        ${t('Esporta CSV')}
      </button>
    </div>
    <p class="text-[11px] text-ink-faint dark:text-zinc-500 mb-3 leading-snug">${t('Stima sui compensi dell\'anno con le impostazioni fiscali correnti. Da verificare sempre con il commercialista.')}</p>
    <div class="grid sm:grid-cols-2 gap-3">${cards}</div>`;
}

function exportAnnualCSV() {
  const ymap = yearlyAggregate();
  const years = [...ymap.keys()].sort();
  if (!years.length) { toast(t('Nessun dato da esportare'), 'error'); return; }
  const forf = (state.settings.regime || 'ordinario') === 'forfettario';
  const sep = ';';
  const num = (n) => (Number(n) || 0).toFixed(2).replace('.', ',');
  const header = forf
    ? [t('Anno'), t('Compenso lordo'), t('Imponibile'), t('Imposta sostitutiva')]
    : [t('Anno'), t('Compenso'), t('Rivalsa'), t('IVA'), t('Ritenuta'), t('Netto stimato')];
  const lines = years.map(y => {
    const f = annualFiscal(ymap.get(y).comp);
    return (forf
      ? [y, num(f.comp), num(f.imponibile), num(f.imposta)]
      : [y, num(f.comp), num(f.rivalsa), num(f.iva), num(f.ritenuta), num(f.netto)]
    ).join(sep);
  });
  download(`hourflow_${isEn() ? 'annual_summary' : 'riepilogo_annuale'}_${todayIso()}.csv`, '\uFEFF' + [header.join(sep), ...lines].join('\r\n'), 'text/csv;charset=utf-8');
  toast(t('Riepilogo annuale esportato'));
}

// Mesi espansi nel Report (persistono tra i re-render della sessione).
const _repExpanded = new Set();

function renderReports() {
  const root = $('#view-report');
  if (!root) return;
  const map = monthlyAggregate();
  const months = [...map.keys()].sort().reverse();

  if (!months.length) {
    root.innerHTML = `
      <h2 class="text-[13px] font-bold uppercase tracking-wider text-ink-faint dark:text-zinc-500 mb-4">${t('Report Mensili')}</h2>
      <div class="bg-white dark:bg-darkCard rounded-xl2 border border-black/5 dark:border-darkBorder px-6 py-12 text-center shadow-sm">
        <div class="text-3xl mb-3">📅</div>
        <p class="text-ink-soft dark:text-ink-faint text-[15px] font-medium">${t('Ancora nessuna sessione da aggregare.')}</p>
      </div>`;
    return;
  }

  const totHours = months.reduce((a, k) => a + map.get(k).hours, 0);
  const totComp = months.reduce((a, k) => a + map.get(k).comp, 0);
  const maxComp = Math.max(...months.map(k => map.get(k).comp), 1);
  const avgComp = totComp / months.length;

  // Dettaglio del mese: sessioni svolte + eventuali forfait di progetto contati
  // da monthlyAggregate nel mese di creazione dell'incarico.
  const monthDetailHTML = (k) => {
    const sessions = allEntriesFlat().filter(e => String(e.date || '').slice(0, 7) === k);
    const flatProjs = state.projects.filter(p => p.billingType === 'flat' && String(p.createdAt || '').slice(0, 7) === k);
    if (!sessions.length && !flatProjs.length) {
      return `<div class="mt-3 pt-3 border-t border-black/5 dark:border-white/5 text-[12px] text-ink-faint font-medium">${t('Nessuna sessione registrata in questo mese.')}</div>`;
    }
    const sRows = sessions.map(e => `
      <div class="flex items-center gap-3 py-2 border-b border-black/5 dark:border-white/5 last:border-b-0">
        <div class="text-[11px] text-ink-faint whitespace-nowrap tabular-nums">${esc(dateIt(e.date))}</div>
        <div class="flex-1 min-w-0">
          <div class="text-[13px] font-semibold text-ink dark:text-zinc-200 truncate">${esc(e.spec)}</div>
          <div class="text-[11px] text-ink-faint dark:text-zinc-500 truncate">${esc(e.project)}${e.billingType === 'flat' ? ` · ${t('forfait')}` : ''}${e.paid ? ` · <span class="text-emerald-600 dark:text-emerald-400 font-bold">${t('✓ pagata')}</span>` : ''}</div>
        </div>
        <div class="text-[12px] font-bold tabular-nums text-ink-soft dark:text-zinc-400 shrink-0">${e.billingType === 'flat' ? esc(eur(e.amount)) : esc(hrs(e.hours))}</div>
      </div>`).join('');
    const pRows = flatProjs.map(p => `
      <div class="flex items-center gap-3 py-2 border-b border-black/5 dark:border-white/5 last:border-b-0">
        <div class="text-[11px] text-ink-faint whitespace-nowrap tabular-nums">${esc(dateIt(p.createdAt))}</div>
        <div class="flex-1 min-w-0">
          <div class="text-[13px] font-semibold text-ink dark:text-zinc-200 truncate">${esc(p.name)}</div>
          <div class="text-[11px] text-ink-faint dark:text-zinc-500">${t('Forfait di progetto')}</div>
        </div>
        <div class="text-[12px] font-bold tabular-nums text-ink-soft dark:text-zinc-400 shrink-0">${esc(eur(p.flatAmount))}</div>
      </div>`).join('');
    return `<div class="mt-3 pt-1 border-t border-black/5 dark:border-white/5">${sRows}${pRows}</div>`;
  };

  const rows = months.map(k => {
    const m = map.get(k);
    const pct = Math.max(2, Math.round((m.comp / maxComp) * 100));
    const open = _repExpanded.has(k);
    return `
      <div class="bg-white dark:bg-darkCard rounded-xl2 border border-black/5 dark:border-darkBorder p-4 shadow-sm">
        <div class="rep-month cursor-pointer select-none" data-month="${k}" role="button" tabindex="0" aria-expanded="${open}" aria-label="${esc(t('{m} — espandi o comprimi le sessioni del mese', { m: monthLabel(k) }))}">
          <div class="flex items-baseline justify-between gap-3">
            <div class="text-[15px] font-bold tracking-tight dark:text-white flex items-center gap-2"><span class="chev ${open ? 'open' : ''} text-ink-faint dark:text-zinc-600 text-[10px]">▶</span>${esc(monthLabel(k))}</div>
            <div class="text-[15px] font-extrabold text-accent tabular-nums">${esc(eur(m.comp))}</div>
          </div>
          <div class="mt-2 h-2 rounded-full bg-black/[0.05] dark:bg-white/[0.06] overflow-hidden">
            <div class="h-full rounded-full bg-accent" style="width:${pct}%"></div>
          </div>
          <div class="mt-2 text-[11px] text-ink-faint dark:text-zinc-500 font-medium flex items-center gap-2 flex-wrap">
            <span>${esc(plural(m.count, t('sessione'), t('sessioni')))}</span><span>·</span>
            <span class="font-bold text-ink-soft dark:text-zinc-400">${esc(hrs(m.hours))}</span><span>·</span>
            <span>${t('media {v}/h', { v: esc(eur(m.hours > 0 ? m.comp / m.hours : 0)) })}</span>
          </div>
        </div>
        ${open ? monthDetailHTML(k) : ''}
      </div>`;
  }).join('');

  root.innerHTML = `
    <div class="flex items-center justify-between mb-4 gap-3">
      <h2 class="text-[13px] font-bold uppercase tracking-wider text-ink-faint dark:text-zinc-500">${t('Report Mensili')}</h2>
      <button id="rep-export" class="text-[13px] font-bold text-accent hover:text-accent-hover transition-soft flex items-center gap-1.5">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M4 14v4a2 2 0 002 2h12a2 2 0 002-2v-4"/><path d="M12 4v10"/><path d="M8 10l4 4 4-4"/></svg>
        ${t('Esporta CSV')}
      </button>
    </div>

    <div class="grid grid-cols-3 gap-3 mb-6">
      ${summaryCard(t('Mesi attivi'), String(months.length), 'text-ink dark:text-white')}
      ${summaryCard(t('Ore totali'), hrs(totHours), 'text-ink dark:text-white')}
      ${summaryCard(t('Media mensile'), eur(avgComp), 'text-accent')}
    </div>

    <div class="space-y-3">${rows}</div>

    ${annualSummaryHTML()}

    <div class="mt-6 bg-white dark:bg-darkCard rounded-xl2 border border-black/5 dark:border-darkBorder p-4 shadow-sm flex items-center justify-between">
      <span class="text-[13px] font-bold uppercase tracking-wider text-ink-faint dark:text-zinc-500">${t('Totale complessivo')}</span>
      <span class="text-[16px] font-extrabold text-accent tabular-nums">${esc(eur(totComp))}</span>
    </div>`;

  const exp = $('#rep-export', root);
  if (exp) exp.addEventListener('click', exportMonthlyCSV);
  const annExp = $('#ann-export', root);
  if (annExp) annExp.addEventListener('click', exportAnnualCSV);

  // Click (o Invio/Spazio) su un mese: mostra/nasconde le sessioni del mese.
  $$('.rep-month', root).forEach(el => {
    const toggle = () => {
      const k = el.dataset.month;
      if (_repExpanded.has(k)) _repExpanded.delete(k); else _repExpanded.add(k);
      renderReports();
    };
    el.addEventListener('click', toggle);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  });
}

function exportMonthlyCSV() {
  const map = monthlyAggregate();
  const months = [...map.keys()].sort().reverse();
  if (!months.length) { toast(t('Nessun dato da esportare'), 'error'); return; }
  const sep = ';';
  const header = [t('Mese'), t('Sessioni'), t('Ore'), t('Compenso')].join(sep);
  const lines = months.map(k => {
    const m = map.get(k);
    return [monthLabel(k), m.count, String(m.hours).replace('.', ','), String(m.comp.toFixed(2)).replace('.', ',')].join(sep);
  });
  download(`hourflow_${isEn() ? 'monthly_report' : 'report_mensile'}_${todayIso()}.csv`, '\uFEFF' + [header, ...lines].join('\r\n'), 'text/csv;charset=utf-8');
  toast(t('Report mensile esportato'));
}

/* ---------------------------------------------------------------------
   GUIDE VIEW (Manuale Integrato)
--------------------------------------------------------------------- */
// Badge icona in stile iOS: quadrato arrotondato a tinta unita con glifo bianco.
function gIcon(bg, glyph) {
  return `<span class="w-7 h-7 shrink-0 rounded-[7px] ${bg} flex items-center justify-center shadow-sm">` +
         `<svg class="w-[17px] h-[17px]" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${glyph}</svg></span>`;
}

function guideSection(icon, title, bodyHTML) {
  // Converte **grassetto** in <strong> (la sintassi markdown non sarebbe interpretata).
  const body = String(bodyHTML).replace(/\*\*(.+?)\*\*/g, '<strong class="font-bold text-ink dark:text-zinc-200">$1</strong>');
  return `
    <details class="bg-white dark:bg-darkCard rounded-xl2 border border-black/5 dark:border-darkBorder overflow-hidden shadow-sm group">
      <summary class="cursor-pointer select-none list-none px-5 py-4 flex items-center gap-3 hover:bg-black/[.015] dark:hover:bg-white/[0.01] transition-soft">
        ${icon}
        <span class="flex-1 text-[15px] font-bold tracking-tight dark:text-zinc-100">${esc(title)}</span>
        <svg class="w-4 h-4 shrink-0 text-ink-faint dark:text-zinc-600 transition-transform group-open:rotate-90" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
      </summary>
      <div class="px-5 pb-5 pt-1 text-[13px] text-ink-soft dark:text-zinc-400 leading-relaxed space-y-2.5 border-t border-black/[0.02] dark:border-white/[0.02]">${body}</div>
    </details>`;
}

function renderGuide() {
  const root = $('#view-guide');
  if (!root) return;
  const client = isClient();
  const title = client ? t('Manuale di Consultazione — Cliente') : t('Manuale di Utilizzo Professionale');
  const intro = client
    ? t('La tua guida per consultare le note di pagamento, verificare lo stato dei versamenti e accedere ai tuoi dati in sicurezza.')
    : t('Tutte le potenzialità di HourFlow spiegate nel dettaglio.');
  root.innerHTML = `
    <h2 class="text-[13px] font-bold uppercase tracking-wider text-ink-faint dark:text-zinc-500 mb-2">${title}</h2>
    <p class="text-[14px] text-ink-soft dark:text-zinc-400 mb-4 leading-relaxed font-medium">${intro}</p>
    <div class="space-y-3">
      ${client ? (isEn() ? clientGuideSectionsEn() : clientGuideSections()) : (isEn() ? ownerGuideSectionsEn() : ownerGuideSections())}
    </div>`;
}

// Manuale completo per l'account Proprietario.
function ownerGuideSections() {
  return `
      ${guideSection(gIcon('bg-blue-500', '<path d="M4 19V5"/><path d="M4 19h16"/><rect x="7" y="11" width="3" height="5" rx="0.5"/><rect x="12.5" y="7" width="3" height="9" rx="0.5"/>'), 'Dashboard & Filtri Avanzati', `
        <p>La **Dashboard** è la tua centrale di controllo operativa. Da qui puoi tenere sotto controllo le ore totali registrate, la tariffa di base e il compenso finanziario calcolato.</p>
        <p>Grazie ai **Filtri di Visualizzazione**, puoi segmentare istantaneamente il tuo lavoro per:</p>
        <ul class="list-disc pl-5 space-y-1">
          <li>**Periodo Temporale:** Visualizza solo le ore del mese in corso, del mese precedente, dell'anno corrente o imposta un intervallo di date "dal / al" personalizzato.</li>
          <li>**Filtro Progetto:** Isola un singolo progetto per analizzarne i guadagni e la ripartizione finanziaria.</li>
          <li>**Stato pagamento:** Mostra **solo le sessioni ancora da pagare** (o, al contrario, solo quelle già saldate). Sotto ai filtri compare il riepilogo di quanto stai guardando: numero di sessioni, ore e importo.</li>
        </ul>
        <p>Usa la **barra di ricerca** per trovare al volo un progetto o un'attività per nome. Indicatori, grafico analitico e Nota di pagamento seguono in tempo reale **periodo e progetto**; il filtro **Stato pagamento** agisce solo sulla vista, perché la Nota esclude comunque sempre le sessioni già pagate.</p>`)}

      ${guideSection(gIcon('bg-orange-500', '<circle cx="12" cy="13" r="8"/><path d="M12 13V9"/><path d="M9 2h6"/><path d="M18.5 6.5l1.2-1.2"/>'), 'Cronometro di precisione real-time', `
        <p>Avvia una sessione di lavoro in tempo reale toccando il pulsante **cronometro** situato su qualsiasi riga di progetto.</p>
        <p>Il cronometro di HourFlow è stato progettato per massimizzare le prestazioni del dispositivo:</p>
        <ul class="list-disc pl-5 space-y-1">
          <li>**Risparmio Batteria:** Quando la scheda del browser è ridotta a icona o in background, il motore riduce i consumi ricalcolando il tempo al millisecondo solo quando ritorni visibile.</li>
          <li>**Uscita Sicura:** Anche se rinfreschi la pagina o spegni il browser, il cronometro riprenderà la conta dall'istante esatto di avvio.</li>
          <li>**Arrotondamento:** Dalle **Impostazioni** puoi attivare l'arrotondamento per eccesso della sessione a 6, 15, 30 o 60 minuti. Al salvataggio vedi sia il tempo reale sia quello arrotondato che verrà conteggiato.</li>
        </ul>`)}

      ${guideSection(gIcon('bg-indigo-500', '<path d="M3 7a2 2 0 012-2h3.5l2 2H19a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>'), 'Progetti & Sessioni', `
        <p>Crea un nuovo incarico con **+ Nuovo progetto**: assegni un nome, scegli il **tipo di compenso** e colleghi il **cliente** dall'anagrafica.</p>
        <p>**A ore o a forfait:** con *A ore* imposti una **tariffa oraria dedicata** (vuota = usa quella globale) e il compenso si calcola sulle ore registrate. Con *A forfait* fissi un **importo concordato**: le ore vengono comunque tracciate, ma la fatturazione usa quella cifra fissa, a prescindere dal tempo impiegato. Un preventivo accettato può creare direttamente un progetto a forfait con il suo importo.</p>
        <p>Per ogni progetto puoi:</p>
        <ul class="list-disc pl-5 space-y-1">
          <li>**Aggiungere sessioni** manualmente — data, descrizione dell'attività e ore — oltre che tramite il cronometro.</li>
          <li>**Modificare** nome e tariffa con l'icona matita, oppure **eliminare** il progetto e le singole sessioni con l'icona cestino.</li>
          <li>**Espandere** la riga del progetto per consultare l'elenco completo delle sessioni registrate, con ore e importi.</li>
          <li>**Segnare una sessione come pagata** con l'icona ✓ sulla riga: diventa verde, esce dalla Nota di pagamento e la ritrovi con il filtro **Stato pagamento**. Ripremendola torna tra quelle da pagare.</li>
          <li>**Segnare più sessioni insieme:** tocca **Seleziona** accanto a "I tuoi Progetti", spunta le sessioni (o la casella del progetto per prenderle tutte) e usa la barra in basso: **Segna come pagate** o **Segna da pagare**. La barra mostra quante sessioni hai scelto, con ore e importo; **Seleziona tutte** prende tutte quelle visibili con i filtri attivi.</li>
        </ul>`)}

      ${guideSection(gIcon('bg-emerald-500', '<path d="M7 3h7l4 4v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z"/><path d="M14 3v4h4"/><path d="M9 12h6"/><path d="M9 16h6"/>'), 'Nota Pro, Rivalsa, IVA e Ritenuta', `
        <p>La sezione **Nota Pro** compila istantaneamente una fattura/ricevuta intestata al cliente selezionato.</p>
        <p>Dalle **Impostazioni** puoi calibrare il calcolo fiscale a seconda della tua posizione contributiva:</p>
        <ul class="list-disc pl-5 space-y-1">
          <li>**Rivalsa INPS:** Solitamente impostata al 4% per i professionisti iscritti alla Gestione Separata. Viene calcolata sull'imponibile base.</li>
          <li>**I.V.A.:** Imposta l'aliquota di legge (es. 22%). Viene calcolata sulla somma di imponibile base e rivalsa.</li>
          <li>**Ritenuta d'Acconto:** Imposta la ritenuta (es. 20%). Viene calcolata sulla somma di imponibile base e rivalsa e sottratta automaticamente per determinare il Netto a Pagare.</li>
        </ul>
        <p>**Regime fiscale:** dalle Impostazioni scegli tra **Ordinario** e **Forfettario**. In regime forfettario IVA e ritenuta d'acconto vengono azzerate automaticamente e in nota (e nel PDF) compare la dicitura di legge sull'operazione in franchigia (art. 1, c. 54-89, L. 190/2014).</p>
        <p>Sopra la nota trovi il riquadro **Stato pagamento**: puoi assegnare un **numero progressivo** alla nota (sequenziale per anno, es. N. 0007/2026, riportato anche in stampa) e registrare un **acconto** (versamento parziale) o un **saldo**, con importo, data e nota. La nota mostra **Totale**, **Versato** e **Residuo** e passa automaticamente da **Da saldare** ad **Acconto ricevuto** fino a **Pagata**; lo stato compare anche in stampa. Numero e pagamenti sono agganciati al contesto di fatturazione corrente (cliente/progetto e periodo selezionati nei filtri). Puoi impostare una **scadenza** per la nota (predefinita a +30 giorni): le note non saldate mostrano un avviso **in scadenza** o **scaduta** per aiutarti nei solleciti.</p>
        <p>Dalle **Impostazioni** puoi definire una **Causale predefinita** (riportata in nota) e attivare la **marca da bollo da 2,00 €**, applicata automaticamente alle note esenti IVA sopra 77,47 €.</p>`)}

      ${guideSection(gIcon('bg-teal-500', '<path d="M3 4h18v4H3z"/><path d="M3 8v12h18V8"/><path d="M8 12v5"/><path d="M12 11v6"/><path d="M16 13v4"/>'), 'Report Mensili', `
        <p>La sezione **Report** aggrega automaticamente il lavoro **mese per mese**: ore, numero di sessioni, compenso e tariffa media oraria, con una barra di confronto tra i mesi e i totali complessivi.</p>
        <p>Con **Esporta CSV** scarichi il riepilogo mensile pronto per Excel o Numbers, utile per dichiarazioni e consuntivi.</p>
        <p>In fondo trovi il **Riepilogo annuale**: aggrega compensi, spese e calcolo fiscale dell'anno (coerente col regime, con coefficiente e imposta sostitutiva per il forfettario) e restituisce il **compenso netto spese**. Anche questo è esportabile in CSV.</p>`)}

      ${guideSection(gIcon('bg-pink-500', '<rect x="2.5" y="5.5" width="19" height="13" rx="2.5"/><path d="M2.5 9.5h19"/>'), 'Spese & Costi', `
        <p>La sezione **Spese** ti permette di registrare costi e trasferte, così da conoscere il **guadagno reale** e non solo il fatturato. È una vista riservata al Proprietario.</p>
        <ul class="list-disc pl-5 space-y-1">
          <li>Ogni spesa ha **descrizione, importo, categoria, data** e può essere collegata a un **progetto**.</li>
          <li>Le spese confluiscono nel **Riepilogo annuale**, sottratte dal compenso per ottenere il netto.</li>
          <li>Sono incluse nel backup JSON e sincronizzate sul cloud come gli altri dati.</li>
        </ul>`)}

      ${guideSection(gIcon('bg-cyan-600', '<rect x="5" y="5" width="14" height="16" rx="2"/><rect x="9" y="3" width="6" height="4" rx="1.5"/><path d="M9 12h6M9 16h4"/>'), 'Preventivi', `
        <p>La sezione **Preventivi** crea documenti commerciali con più **voci** (descrizione, quantità, prezzo) e totale calcolato in tempo reale, con IVA opzionale coerente col regime fiscale.</p>
        <ul class="list-disc pl-5 space-y-1">
          <li>**Numerazione automatica** per anno (es. PREV-0007/2026).</li>
          <li>**Stato:** Bozza → Inviato → Accettato / Rifiutato, con badge colorato.</li>
          <li>**Esporta PDF** del preventivo (intestazione, voci, imponibile/IVA/totale, note).</li>
          <li>**Crea progetto:** da un preventivo **accettato** generi con un tocco un progetto già collegato al cliente, pronto da tracciare a ore. Il preventivo resta segnato come convertito.</li>
        </ul>`)}

      ${guideSection(gIcon('bg-violet-500', '<circle cx="9" cy="8" r="3"/><path d="M3.5 20a5.5 5.5 0 0111 0"/><path d="M16 5.5a3 3 0 010 5.4"/><path d="M18.5 20a5.5 5.5 0 00-3-4.9"/>'), 'Anagrafica Clienti', `
        <p>La sezione **Clienti** raccoglie le anagrafiche complete dei tuoi committenti: denominazione, **P.IVA / Codice Fiscale**, indirizzo della sede, email e telefono.</p>
        <p>Ogni cliente può essere associato a uno o più progetti e i suoi dati vengono richiamati automaticamente nell'intestazione della **Nota Pro**. Per proteggere lo storico di fatturazione, un cliente collegato a progetti attivi non è eliminabile finché non lo scolleghi.</p>`)}

      ${guideSection(gIcon('bg-sky-500', '<path d="M7 18A4 4 0 016.5 10a5.5 5.5 0 0110.7 1.3A3.4 3.4 0 0117 18z"/><path d="M9.5 14.5L12 12l2.5 2.5"/><path d="M12 12v6"/>'), 'Account & Sincronizzazione Cloud', `
        <p>Con l'accesso tramite **email e password** i tuoi dati vengono sincronizzati in tempo reale su tutti i dispositivi, con allineamento per **singola voce**: progetti, sessioni e clienti restano coerenti anche lavorando offline su più dispositivi, senza sovrascritture accidentali.</p>
        <p>Sono previsti due livelli di accesso:</p>
        <ul class="list-disc pl-5 space-y-1">
          <li>**Proprietario:** pieno controllo su modifiche, tariffe e coordinate di pagamento.</li>
          <li>**Cliente:** consultazione protetta della nota, in **sola lettura**, senza poter modificare o eliminare nulla.</li>
        </ul>
        <p>Il badge in alto a destra indica in ogni momento se sei **Sincronizzato**, in sincronia o non connesso.</p>`)}

      ${guideSection(gIcon('bg-zinc-500', '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/><circle cx="12" cy="15.5" r="1.2" fill="white" stroke="none"/>'), "Privacy dell'IBAN", `
        <p>A schermo l'IBAN è mostrato **mascherato** — prime e ultime 4 cifre visibili — per proteggerlo da sguardi indiscreti. Con **Mostra** lo riveli temporaneamente, con **Copia** lo trasferisci negli appunti.</p>
        <p>In **stampa** l'IBAN viene sempre riportato per intero e raggruppato in blocchi da 4, così la nota resta valida per il pagamento. Per gli account **Cliente** le coordinate restano riservate.</p>`)}

      ${guideSection(gIcon('bg-rose-500', '<path d="M7 9V3h10v6"/><rect x="4" y="9" width="16" height="8" rx="2"/><path d="M7 14h10v6H7z"/><circle cx="16.5" cy="12" r="0.8" fill="white" stroke="none"/>'), 'Stampa & Esportazione PDF', `
        <p>Dalla **Nota Pro**, il pulsante con l'icona stampante genera un **PDF nativo** scaricabile con impaginazione A4 pulita, completo di numero nota, dati, totali, stato pagamento e coordinate.</p>
        <p>Su iOS il PDF viene salvato tra i file/condivisione. Se il modulo PDF non fosse disponibile, HourFlow ripiega automaticamente sulla stampa del browser.</p>`)}

      ${guideSection(gIcon('bg-amber-500', '<path d="M4 14v3.5A1.5 1.5 0 005.5 19h13a1.5 1.5 0 001.5-1.5V14"/><path d="M12 4v10"/><path d="M8 10l4 4 4-4"/>'), 'Backup & Ripristino', `
        <p>Dalle **Impostazioni** proteggi e trasferisci il tuo archivio:</p>
        <ul class="list-disc pl-5 space-y-1">
          <li>**Esporta Database JSON:** un backup completo — progetti, sessioni, clienti e impostazioni — da conservare o ripristinare.</li>
          <li>**Esporta Tabella CSV:** l'elenco delle sessioni in formato foglio di calcolo, pronto per Excel o Numbers.</li>
          <li>**Ripristino:** reimporta un file JSON per riportare l'archivio a uno stato salvato. L'import è difensivo: un singolo record corrotto non interrompe l'intera operazione.</li>
        </ul>`)}

      ${guideSection(gIcon('bg-slate-700', '<path d="M20 14.5A8 8 0 119.5 4a6.5 6.5 0 0010.5 10.5z"/>'), 'Tema & Aspetto', `
        <p>L'icona **luna / sole** in alto inverte all'istante il tema **chiaro** o **scuro**. La preferenza viene salvata e sincronizzata; è disponibile anche la modalità **automatica**, che segue le impostazioni di sistema del dispositivo.</p>
        <p>**Lingua:** il pulsante **IT / EN** in alto (o la voce **Lingua** nelle Impostazioni) passa l'app in inglese. La lingua vale anche per i **documenti generati**: PDF della nota e dei preventivi ed esportazioni CSV. La scelta è salvata su questo dispositivo.</p>`)}`;
}

// Manuale dedicato all'account Cliente: sola consultazione, niente operazioni
// di modifica (cronometro, creazione progetti, fiscalità, backup, pagamenti).
function clientGuideSections() {
  return `
      ${guideSection(gIcon('bg-sky-500', '<path d="M7 18A4 4 0 016.5 10a5.5 5.5 0 0110.7 1.3A3.4 3.4 0 0117 18z"/><path d="M9.5 14.5L12 12l2.5 2.5"/><path d="M12 12v6"/>'), 'Il tuo accesso Cliente', `
        <p>Hai effettuato l'accesso come **Cliente**: una modalità di **sola consultazione**, pensata per permetterti di seguire il lavoro svolto e le note di pagamento in totale sicurezza.</p>
        <p>Puoi **visualizzare** progetti, ore, note e report, ma non puoi modificare o eliminare dati: l'archivio resta sotto il pieno controllo del professionista. I tuoi dati si **sincronizzano** automaticamente su tutti i tuoi dispositivi.</p>`)}

      ${guideSection(gIcon('bg-blue-500', '<path d="M4 19V5"/><path d="M4 19h16"/><rect x="7" y="11" width="3" height="5" rx="0.5"/><rect x="12.5" y="7" width="3" height="9" rx="0.5"/>'), 'Dashboard & Filtri', `
        <p>La **Dashboard** riepiloga le ore registrate, la tariffa applicata e il compenso complessivo.</p>
        <p>Con i **Filtri** puoi consultare il lavoro per **periodo** (mese corrente, mese precedente, anno o intervallo personalizzato), isolare un singolo **progetto** oppure vedere con **Stato pagamento** le sole attività **ancora da pagare**. La **ricerca** ti aiuta a trovare rapidamente un progetto o un'attività. Indicatori e grafico si aggiornano in tempo reale.</p>`)}

      ${guideSection(gIcon('bg-emerald-500', '<path d="M7 3h7l4 4v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z"/><path d="M14 3v4h4"/><path d="M9 12h6"/><path d="M9 16h6"/>'), 'Leggere la Nota di Pagamento', `
        <p>La sezione **Nota Pro** mostra la nota a te intestata, con il dettaglio delle prestazioni, le eventuali voci fiscali (rivalsa, IVA, ritenuta, marca da bollo) e il **Netto a pagare**.</p>
        <p>Il riquadro **Stato pagamento** ti dice a colpo d'occhio la situazione:</p>
        <ul class="list-disc pl-5 space-y-1">
          <li>**Da saldare:** nessun versamento ancora registrato.</li>
          <li>**Acconto ricevuto:** è stato versato un importo parziale; trovi **Versato** e **Residuo**.</li>
          <li>**Pagata:** la nota risulta saldata per intero.</li>
        </ul>
        <p>Se è prevista una **scadenza**, la nota non ancora saldata può mostrarla evidenziando se è **in scadenza** o **scaduta**.</p>
        <p>La registrazione dei pagamenti è gestita dal professionista; tu la vedi sempre aggiornata in tempo reale.</p>`)}

      ${guideSection(gIcon('bg-teal-500', '<path d="M3 4h18v4H3z"/><path d="M3 8v12h18V8"/><path d="M8 12v5"/><path d="M12 11v6"/><path d="M16 13v4"/>'), 'Report Mensili', `
        <p>La sezione **Report** riepiloga il lavoro **mese per mese**: ore, numero di sessioni e compenso, con un confronto visivo tra i periodi.</p>
        <p>Con **Esporta CSV** puoi scaricare il riepilogo per i tuoi archivi.</p>`)}

      ${guideSection(gIcon('bg-zinc-500', '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/><circle cx="12" cy="15.5" r="1.2" fill="white" stroke="none"/>'), 'Coordinate di pagamento', `
        <p>Le coordinate per il pagamento sono riportate sulla nota. A schermo l'**IBAN** è mostrato **mascherato** per riservatezza: usa **Mostra** per rivelarlo e **Copia** per inserirlo nel bonifico.</p>
        <p>Nel **PDF/stampa** della nota l'IBAN compare per intero e raggruppato in blocchi da 4, pronto per effettuare il versamento.</p>`)}

      ${guideSection(gIcon('bg-rose-500', '<path d="M7 9V3h10v6"/><rect x="4" y="9" width="16" height="8" rx="2"/><path d="M7 14h10v6H7z"/><circle cx="16.5" cy="12" r="0.8" fill="white" stroke="none"/>'), 'Scaricare la Nota in PDF', `
        <p>Dalla **Nota Pro**, il pulsante con l'icona stampante genera un **PDF nativo** della nota, con impaginazione A4 pulita: comodo da archiviare o allegare alla disposizione di pagamento.</p>
        <p>Su iOS il PDF viene salvato tramite il pannello di condivisione (“Salva su File”).</p>`)}

      ${guideSection(gIcon('bg-slate-600', '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>'), 'Account & Sicurezza', `
        <p>Accedi con **email e password**. Il tuo livello **Cliente** è in sola lettura e i dati restano sincronizzati e protetti sul cloud.</p>
        <p>Dalle **Impostazioni** puoi gestire la tua sessione, verificare l'email e disconnetterti in sicurezza dal dispositivo.</p>`)}

      ${guideSection(gIcon('bg-slate-700', '<path d="M20 14.5A8 8 0 119.5 4a6.5 6.5 0 0010.5 10.5z"/>'), 'Tema & Aspetto', `
        <p>L'icona **luna / sole** in alto inverte all'istante il tema **chiaro** o **scuro**. È disponibile anche la modalità **automatica**, che segue le impostazioni del tuo dispositivo.</p>
        <p>**Lingua:** con il pulsante **IT / EN** in alto passi all'inglese; anche il PDF della nota viene generato nella lingua scelta.</p>`)}`;
}

// Manuale in inglese (stessa struttura e stesse icone della versione italiana).
function ownerGuideSectionsEn() {
  return `
      ${guideSection(gIcon('bg-blue-500', '<path d="M4 19V5"/><path d="M4 19h16"/><rect x="7" y="11" width="3" height="5" rx="0.5"/><rect x="12.5" y="7" width="3" height="9" rx="0.5"/>'), 'Dashboard & Advanced Filters', `
        <p>The **Dashboard** is your operational control centre. From here you keep track of total hours logged, the base rate and the calculated compensation.</p>
        <p>With the **View Filters** you can instantly slice your work by:</p>
        <ul class="list-disc pl-5 space-y-1">
          <li>**Time period:** show only the hours of the current month, the previous month, the current year, or set a custom "from / to" date range.</li>
          <li>**Project filter:** isolate a single project to analyse its earnings and financial breakdown.</li>
          <li>**Payment status:** show **only the sessions still to be paid** (or, conversely, only those already settled). Below the filters a summary tells you what you are looking at: number of sessions, hours and amount.</li>
        </ul>
        <p>Use the **search bar** to find a project or an activity by name. Indicators, the chart and the Payment note follow **period and project** in real time; the **Payment status** filter only affects the view, because the Note always leaves out sessions already paid.</p>`)}

      ${guideSection(gIcon('bg-orange-500', '<circle cx="12" cy="13" r="8"/><path d="M12 13V9"/><path d="M9 2h6"/><path d="M18.5 6.5l1.2-1.2"/>'), 'Real-time precision stopwatch', `
        <p>Start a live work session by tapping the **stopwatch** button on any project row.</p>
        <p>The HourFlow stopwatch is designed to be light on your device:</p>
        <ul class="list-disc pl-5 space-y-1">
          <li>**Battery saving:** when the browser tab is minimised or in the background, the engine saves power and recomputes the elapsed time to the millisecond only when you come back.</li>
          <li>**Safe exit:** even if you reload the page or close the browser, the stopwatch resumes counting from the exact moment it started.</li>
          <li>**Rounding:** in **Settings** you can round sessions up to 6, 15, 30 or 60 minutes. When saving you see both the actual time and the rounded time that will be counted.</li>
        </ul>`)}

      ${guideSection(gIcon('bg-indigo-500', '<path d="M3 7a2 2 0 012-2h3.5l2 2H19a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>'), 'Projects & Sessions', `
        <p>Create a new engagement with **+ New project**: give it a name, choose the **billing type** and link the **client** from your address book.</p>
        <p>**Hourly or flat fee:** with *Hourly* you set a **dedicated hourly rate** (empty = use the global one) and compensation is calculated on the hours logged. With *Flat fee* you set an **agreed amount**: hours are still tracked, but billing uses that fixed figure regardless of the time spent. An accepted quote can directly create a flat-fee project with its amount.</p>
        <p>For each project you can:</p>
        <ul class="list-disc pl-5 space-y-1">
          <li>**Add sessions** manually — date, activity description and hours — as well as through the stopwatch.</li>
          <li>**Edit** name and rate with the pencil icon, or **delete** the project and individual sessions with the bin icon.</li>
          <li>**Expand** the project row to see the full list of logged sessions, with hours and amounts.</li>
          <li>**Mark a session as paid** with the ✓ icon on its row: it turns green, leaves the Payment note and can be found again with the **Payment status** filter. Tap it again to put it back among those to be paid.</li>
          <li>**Mark several sessions at once:** tap **Select** next to "Your Projects", tick the sessions (or the project checkbox to take them all) and use the bar at the bottom: **Mark as paid** or **Mark as unpaid**. The bar shows how many sessions you picked, with hours and amount; **Select all** takes every session visible with the active filters.</li>
        </ul>`)}

      ${guideSection(gIcon('bg-emerald-500', '<path d="M7 3h7l4 4v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z"/><path d="M14 3v4h4"/><path d="M9 12h6"/><path d="M9 16h6"/>'), 'Pro Note, Social security, VAT and Withholding', `
        <p>The **Pro Note** section instantly compiles an invoice/receipt addressed to the selected client.</p>
        <p>In **Settings** you can tune the tax calculation to your contribution position:</p>
        <ul class="list-disc pl-5 space-y-1">
          <li>**INPS social security surcharge:** usually 4% for professionals enrolled in the Gestione Separata. It is calculated on the taxable base.</li>
          <li>**VAT:** set the statutory rate (e.g. 22%). It is calculated on the taxable base plus the surcharge.</li>
          <li>**Withholding tax:** set the rate (e.g. 20%). It is calculated on the taxable base plus the surcharge and automatically deducted to determine the Net amount due.</li>
        </ul>
        <p>**Tax regime:** in Settings choose between **Standard** and **Flat-rate**. Under the flat-rate scheme VAT and withholding tax are zeroed automatically and the note (and the PDF) shows the statutory wording for VAT-exempt transactions (art. 1, par. 54-89, Law 190/2014).</p>
        <p>Above the note you find the **Payment status** box: you can assign a **progressive number** to the note (sequential per year, e.g. No. 0007/2026, printed on the document too) and record a **deposit** (partial payment) or a **final payment**, with amount, date and note. The note shows **Total**, **Paid** and **Balance** and moves automatically from **To be paid** to **Deposit received** to **Paid**; the status also appears on the printout. Number and payments are tied to the current billing context (client/project and period selected in the filters). You can set a **due date** for the note (30 days by default): unpaid notes show a **due soon** or **overdue** warning to help with reminders.</p>
        <p>In **Settings** you can also define a **Default payment reference** (printed on the note) and enable the **€2.00 revenue stamp**, applied automatically to VAT-exempt notes above €77.47.</p>`)}

      ${guideSection(gIcon('bg-teal-500', '<path d="M3 4h18v4H3z"/><path d="M3 8v12h18V8"/><path d="M8 12v5"/><path d="M12 11v6"/><path d="M16 13v4"/>'), 'Monthly Reports', `
        <p>The **Report** section automatically aggregates your work **month by month**: hours, number of sessions, compensation and average hourly rate, with a comparison bar between months and overall totals.</p>
        <p>With **Export CSV** you download the monthly summary ready for Excel or Numbers, handy for tax returns and final statements.</p>
        <p>At the bottom you find the **Annual summary**: it aggregates the year's compensation, expenses and tax calculation (consistent with your regime, using the profitability coefficient and substitute tax for the flat-rate scheme) and returns the **compensation net of expenses**. This can be exported to CSV too.</p>`)}

      ${guideSection(gIcon('bg-pink-500', '<rect x="2.5" y="5.5" width="19" height="13" rx="2.5"/><path d="M2.5 9.5h19"/>'), 'Expenses & Costs', `
        <p>The **Expenses** section lets you record costs and travel, so you know your **real earnings** and not just your turnover. It is a view reserved to the Owner.</p>
        <ul class="list-disc pl-5 space-y-1">
          <li>Each expense has a **description, amount, category and date** and can be linked to a **project**.</li>
          <li>Expenses flow into the **Annual summary**, deducted from compensation to get the net figure.</li>
          <li>They are included in the JSON backup and synced to the cloud like the rest of your data.</li>
        </ul>`)}

      ${guideSection(gIcon('bg-cyan-600', '<rect x="5" y="5" width="14" height="16" rx="2"/><rect x="9" y="3" width="6" height="4" rx="1.5"/><path d="M9 12h6M9 16h4"/>'), 'Quotes', `
        <p>The **Quotes** section creates commercial documents with multiple **line items** (description, quantity, price) and a total calculated in real time, with optional VAT consistent with your tax regime.</p>
        <ul class="list-disc pl-5 space-y-1">
          <li>**Automatic numbering** per year (e.g. PREV-0007/2026).</li>
          <li>**Status:** Draft → Sent → Accepted / Rejected, with a coloured badge.</li>
          <li>**Export PDF** of the quote (header, items, taxable amount/VAT/total, notes).</li>
          <li>**Create project:** from an **accepted** quote you generate, in one tap, a project already linked to the client and ready to track. The quote stays marked as converted.</li>
        </ul>`)}

      ${guideSection(gIcon('bg-violet-500', '<circle cx="9" cy="8" r="3"/><path d="M3.5 20a5.5 5.5 0 0111 0"/><path d="M16 5.5a3 3 0 010 5.4"/><path d="M18.5 20a5.5 5.5 0 00-3-4.9"/>'), 'Client Directory', `
        <p>The **Clients** section holds the complete records of your customers: company name, **VAT No. / Tax code**, registered address, email and phone.</p>
        <p>Each client can be linked to one or more projects and its details are pulled automatically into the header of the **Pro Note**. To protect your billing history, a client linked to active projects cannot be deleted until you unlink it.</p>`)}

      ${guideSection(gIcon('bg-sky-500', '<path d="M7 18A4 4 0 016.5 10a5.5 5.5 0 0110.7 1.3A3.4 3.4 0 0117 18z"/><path d="M9.5 14.5L12 12l2.5 2.5"/><path d="M12 12v6"/>'), 'Account & Cloud Sync', `
        <p>By signing in with **email and password** your data is synced in real time across all devices, aligned **item by item**: projects, sessions and clients stay consistent even when working offline on several devices, with no accidental overwrites.</p>
        <p>There are two access levels:</p>
        <ul class="list-disc pl-5 space-y-1">
          <li>**Owner:** full control over edits, rates and payment details.</li>
          <li>**Client:** protected, **read-only** view of the note, with no way to edit or delete anything.</li>
        </ul>
        <p>The badge at the top right always tells you whether you are **Synced**, syncing or offline.</p>`)}

      ${guideSection(gIcon('bg-zinc-500', '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/><circle cx="12" cy="15.5" r="1.2" fill="white" stroke="none"/>'), 'IBAN privacy', `
        <p>On screen the IBAN is shown **masked** — first and last 4 characters visible — to protect it from prying eyes. **Show** reveals it temporarily, **Copy** puts it on the clipboard.</p>
        <p>When **printed** the IBAN always appears in full, grouped in blocks of 4, so the note remains valid for payment. For **Client** accounts the bank details stay reserved.</p>`)}

      ${guideSection(gIcon('bg-rose-500', '<path d="M7 9V3h10v6"/><rect x="4" y="9" width="16" height="8" rx="2"/><path d="M7 14h10v6H7z"/><circle cx="16.5" cy="12" r="0.8" fill="white" stroke="none"/>'), 'Printing & PDF export', `
        <p>From the **Pro Note**, the printer button generates a downloadable **native PDF** with a clean A4 layout, complete with note number, details, totals, payment status and bank details. The PDF follows the app language: in English you get an English document.</p>
        <p>On iOS the PDF is saved through Files/Share. If the PDF module is not available, HourFlow automatically falls back to the browser's print dialog.</p>`)}

      ${guideSection(gIcon('bg-amber-500', '<path d="M4 14v3.5A1.5 1.5 0 005.5 19h13a1.5 1.5 0 001.5-1.5V14"/><path d="M12 4v10"/><path d="M8 10l4 4 4-4"/>'), 'Backup & Restore', `
        <p>From **Settings** you protect and move your archive:</p>
        <ul class="list-disc pl-5 space-y-1">
          <li>**Export JSON database:** a full backup — projects, sessions, clients and settings — to keep or restore.</li>
          <li>**Export CSV table:** the list of sessions as a spreadsheet, ready for Excel or Numbers.</li>
          <li>**Restore:** re-import a JSON file to bring the archive back to a saved state. The import is defensive: a single corrupted record does not stop the whole operation.</li>
        </ul>`)}

      ${guideSection(gIcon('bg-slate-700', '<path d="M20 14.5A8 8 0 119.5 4a6.5 6.5 0 0010.5 10.5z"/>'), 'Theme & Appearance', `
        <p>The **moon / sun** icon at the top instantly switches between **light** and **dark** theme. The preference is saved and synced; there is also an **automatic** mode that follows your device's system settings.</p>
        <p>**Language:** the **IT / EN** button at the top (or **Language** in Settings) switches the app between Italian and English. The language also applies to **generated documents**: note and quote PDFs and CSV exports. The choice is saved on this device.</p>`)}`;
}

function clientGuideSectionsEn() {
  return `
      ${guideSection(gIcon('bg-sky-500', '<path d="M7 18A4 4 0 016.5 10a5.5 5.5 0 0110.7 1.3A3.4 3.4 0 0117 18z"/><path d="M9.5 14.5L12 12l2.5 2.5"/><path d="M12 12v6"/>'), 'Your Client access', `
        <p>You are signed in as a **Client**: a **read-only** mode designed to let you follow the work done and the payment notes in complete safety.</p>
        <p>You can **view** projects, hours, notes and reports, but you cannot edit or delete data: the archive stays fully under the professional's control. Your data **syncs** automatically across all your devices.</p>`)}

      ${guideSection(gIcon('bg-blue-500', '<path d="M4 19V5"/><path d="M4 19h16"/><rect x="7" y="11" width="3" height="5" rx="0.5"/><rect x="12.5" y="7" width="3" height="9" rx="0.5"/>'), 'Dashboard & Filters', `
        <p>The **Dashboard** summarises the hours logged, the rate applied and the overall compensation.</p>
        <p>With the **Filters** you can browse the work by **period** (current month, previous month, year or custom range), isolate a single **project**, or use **Payment status** to see only the activities **still to be paid**. **Search** helps you quickly find a project or an activity. Indicators and chart update in real time.</p>`)}

      ${guideSection(gIcon('bg-emerald-500', '<path d="M7 3h7l4 4v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z"/><path d="M14 3v4h4"/><path d="M9 12h6"/><path d="M9 16h6"/>'), 'Reading the Payment Note', `
        <p>The **Pro Note** section shows the note addressed to you, with the breakdown of services, any tax items (social security surcharge, VAT, withholding tax, revenue stamp) and the **Net amount due**.</p>
        <p>The **Payment status** box tells you the situation at a glance:</p>
        <ul class="list-disc pl-5 space-y-1">
          <li>**To be paid:** no payment recorded yet.</li>
          <li>**Deposit received:** a partial amount has been paid; you see **Paid** and **Balance**.</li>
          <li>**Paid:** the note has been settled in full.</li>
        </ul>
        <p>If a **due date** is set, an unpaid note can show it, highlighting whether it is **due soon** or **overdue**.</p>
        <p>Payments are recorded by the professional; you always see them updated in real time.</p>`)}

      ${guideSection(gIcon('bg-teal-500', '<path d="M3 4h18v4H3z"/><path d="M3 8v12h18V8"/><path d="M8 12v5"/><path d="M12 11v6"/><path d="M16 13v4"/>'), 'Monthly Reports', `
        <p>The **Report** section summarises the work **month by month**: hours, number of sessions and compensation, with a visual comparison between periods.</p>
        <p>With **Export CSV** you can download the summary for your records.</p>`)}

      ${guideSection(gIcon('bg-zinc-500', '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/><circle cx="12" cy="15.5" r="1.2" fill="white" stroke="none"/>'), 'Payment details', `
        <p>The payment details are shown on the note. On screen the **IBAN** is **masked** for privacy: use **Show** to reveal it and **Copy** to paste it into your bank transfer.</p>
        <p>In the note's **PDF/printout** the IBAN appears in full, grouped in blocks of 4, ready for the payment.</p>`)}

      ${guideSection(gIcon('bg-rose-500', '<path d="M7 9V3h10v6"/><rect x="4" y="9" width="16" height="8" rx="2"/><path d="M7 14h10v6H7z"/><circle cx="16.5" cy="12" r="0.8" fill="white" stroke="none"/>'), 'Downloading the Note as PDF', `
        <p>From the **Pro Note**, the printer button generates a **native PDF** of the note with a clean A4 layout: handy to archive or attach to your payment order. With the app in English, the PDF is in English too.</p>
        <p>On iOS the PDF is saved through the share sheet ("Save to Files").</p>`)}

      ${guideSection(gIcon('bg-slate-600', '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>'), 'Account & Security', `
        <p>Sign in with **email and password**. Your **Client** level is read-only and your data stays synced and protected in the cloud.</p>
        <p>From **Settings** you can manage your session, verify your email and sign out safely from the device.</p>`)}

      ${guideSection(gIcon('bg-slate-700', '<path d="M20 14.5A8 8 0 119.5 4a6.5 6.5 0 0010.5 10.5z"/>'), 'Theme & Appearance', `
        <p>The **moon / sun** icon at the top instantly switches between **light** and **dark** theme. There is also an **automatic** mode that follows your device settings.</p>
        <p>**Language:** the **IT / EN** button at the top switches to Italian or English; the note PDF is generated in the chosen language too.</p>`)}`;
}

/* ---------------------------------------------------------------------
   GESTIONE EVENTI ACCOUNT PANEL (BINDACOUNTOPANEL)
--------------------------------------------------------------------- */
function bindAccountPanel() {
  if (!sync.enabled) return;
  if (sync.user) {
    const out = $('#a-signout');
    if (out) out.addEventListener('click', doSignOut);
    const ver = $('#a-verify');
    if (ver) ver.addEventListener('click', doSendVerification);
    const pr = $('#a-passreset');
    if (pr) pr.addEventListener('click', doSendPasswordReset);
    return;
  }
  const emailEl = $('#a-email');
  const passEl = $('#a-pass');
  const errEl = $('#a-error');
  const roleSeg = $('#a-role');
  const roleHint = $('#a-role-hint');
  let chosenRole = 'owner';

  if (roleSeg) {
    $$('button[data-role]', roleSeg).forEach(btn => {
      btn.addEventListener('click', () => {
        chosenRole = btn.dataset.role;
        $$('button[data-role]', roleSeg).forEach(b => b.setAttribute('aria-selected', String(b === btn)));
        if (roleHint) {
          roleHint.innerText = chosenRole === 'client'
            ? t('Livello Cliente: visualizzazione protetta della fattura e dell\'IBAN senza possibilità di modificare.')
            : t('Livello Proprietario: abilitazione modifiche, coordinate IBAN e tariffe.');
        }
      });
    });
  }

  const readCreds = () => ({ email: (emailEl.value || '').trim(), password: passEl.value || '' });
  const showErr = (m) => { if (errEl) { errEl.textContent = m; errEl.classList.remove('hidden'); } };
  const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
  const guard = (c, isSignup) => {
    if (!c.email) { showErr(t('Email obbligatoria.')); return false; }
    if (!validEmail(c.email)) { showErr(t('Formato email non valido.')); return false; }
    if (!c.password) { showErr(t('Inserisci la password d\'accesso.')); return false; }
    if (isSignup && c.password.length < 6) { showErr(t('La password deve contenere almeno 6 caratteri.')); return false; }
    if (errEl) errEl.classList.add('hidden');
    return true;
  };

  const signin = $('#a-signin');
  const signup = $('#a-signup');
  if (signin) signin.addEventListener('click', () => { const c = readCreds(); if (guard(c, false)) doSignIn(c.email, c.password); });
  if (signup) signup.addEventListener('click', () => { const c = readCreds(); if (guard(c, true)) doSignUp(c.email, c.password, chosenRole); });
  if (passEl) passEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const c = readCreds(); if (guard(c, false)) doSignIn(c.email, c.password); } });
}

/* ---------------------------------------------------------------------
   CLOUD ENGINE (Firebase & Real-time Integration)
--------------------------------------------------------------------- */
// Schema cloud: 2 = sottocollezioni per-record (users/{uid}/{store}/{id}).
// 1 = vecchio documento unico con array (migrato automaticamente al primo accesso).
const CLOUD_SCHEMA = 2;
const SYNC_STORES = ['projects', 'entries', 'clients', 'payments', 'expenses', 'quotes'];

const sync = {
  enabled: false,
  ready: false,
  auth: null,
  db: null,
  user: null,
  role: null,        
  pendingRole: null, 
  unsub: null,          // listener documento padre (settings/ruolo)
  colUnsubs: [],        // listener delle sottocollezioni
  applyingRemote: false,
  pushTimer: null,
  reloadTimer: null,
  status: 'off',
  // "Ombra" delle versioni note sul server: store -> Map(id -> updatedAt).
  // Serve a calcolare il diff in push (cosa creare/aggiornare/eliminare).
  server: { projects: new Map(), entries: new Map(), clients: new Map(), payments: new Map(), expenses: new Map(), quotes: new Map() },
  // Idratazione: una sottocollezione e' "idratata" dopo il primo snapshot.
  // Finche' non lo e', NON si propagano eliminazioni (evita di azzerare il
  // server prima di aver letto cosa contiene).
  hydrated: { projects: false, entries: false, clients: false, payments: false, expenses: false, quotes: false },
  serverSettingsAt: 0,
  // Condivisione (architettura A): pubblicazione statement per cliente lato
  // Proprietario; scoperta+lettura live lato Cliente tramite la propria email.
  share: { unsub: null, linksUnsub: null, pubTimer: null, linked: false, curKey: null, statementRef: null, pollTimer: null, lastAppliedAt: 0 }
};

function isAuthed() { return !!(sync.enabled && sync.user); }
function currentRole() {
  if (!sync.enabled) return 'owner';
  if (!sync.user) return 'guest';
  return sync.role === 'client' ? 'client' : 'owner';
}
function isClient()  { return currentRole() === 'client'; }
function isGuest()   { return currentRole() === 'guest'; }
function canEdit()   { return !isClient(); }
function canSeeIban() { return !sync.enabled || isAuthed(); }
function canManagePayment() { return canSeeIban() && !isClient(); }
function roleLabel(r) { return r === 'client' ? t('Cliente') : (r === 'guest' ? t('Ospite') : t('Proprietario')); }

function firebaseConfigured() {
  const c = window.FIREBASE_CONFIG || {};
  return typeof firebase !== 'undefined' && !!c.apiKey && !!c.projectId;
}

function userDocRef() {
  if (!sync.user) return null;
  return sync.db.collection('users').doc(sync.user.uid);
}

// Riferimento alla sottocollezione per-record: users/{uid}/{store}
function colRef(store) {
  if (!sync.user) return null;
  return sync.db.collection('users').doc(sync.user.uid).collection(store);
}

// Marca lo stadio corrente della sincronizzazione (a fini diagnostici): se il
// watchdog scatta, sappiamo ESATTAMENTE dove si era fermato il flusso.
function syncStage(s) {
  sync.stage = s;
  try { console.log('[sync] stadio:', s); } catch (_) {}
}

let _syncWatchdog = null;
function setSyncStatus(status) {
  sync.status = status;
  // Watchdog centrale: lo stato "syncing" NON puo' restare appeso all'infinito,
  // qualunque sia il punto di blocco (get Firestore, listener, push...). Se dopo
  // 12s siamo ancora in "syncing", sblocchiamo e mostriamo l'errore con lo stadio
  // raggiunto, lasciando comunque utilizzabili i dati locali gia' caricati.
  clearTimeout(_syncWatchdog);
  if (status === 'syncing') {
    _syncWatchdog = setTimeout(() => {
      if (sync.status !== 'syncing') return;
      try { console.warn('[sync] watchdog scattato — ultimo stadio:', sync.stage); } catch (_) {}
      sync.applyingRemote = false;            // non lasciare il push bloccato
      sync.status = 'error'; updateSyncBadge(); if (state.view === 'settings') renderSettings();
      if (maybeRecoverWedgedFirestore(new Error('sync-timeout'))) return;
      toast(t('Sincronizzazione non completata (stadio: {s}). Dati locali disponibili.', { s: sync.stage || '?' }), 'warning');
    }, 12000);
  }
  updateSyncBadge();
  if (state.view === 'settings') renderSettings();
}

function updateSyncBadge() {
  const el = $('#sync-badge');
  if (!el) return;
  if (!sync.enabled) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const map = {
    signedout: { t: 'Non Connesso', c: 'bg-black/5 dark:bg-white/5 text-ink-soft', dot: '○' },
    syncing:   { t: 'In Sincronia…', c: 'bg-accent-soft text-accent', dot: '⟳' },
    synced:    { t: 'Sincronizzato', c: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400', dot: '●' },
    error:     { t: 'Errore cloud', c: 'bg-[#ff3b30]/10 text-[#ff3b30]', dot: '⚠' },
    off:       { t: '', c: '', dot: '' }
  };
  const m = map[sync.status] || map.signedout;
  el.className = `shrink-0 text-[12px] font-bold rounded-full px-2 sm:px-2.5 py-1 transition-soft flex items-center gap-1.5 ${m.c}`;
  el.innerHTML = `<span>${m.dot}</span><span class="hidden sm:inline">${esc(t(m.t))}</span>`;
  el.onclick = () => setView('settings');
  updateUserBadge();
}

function roleLabel() {
  const r = currentRole();
  if (r === 'client') return t('Cliente');
  if (r === 'owner') return t('Proprietario');
  return '';
}

function userDisplayName() {
  const s = state.settings || {};
  if (isClient()) {
    if (s.clientProfile && s.clientProfile.name) return s.clientProfile.name;
  } else if (s.holderName) {
    return s.holderName;
  }
  if (sync.user && sync.user.email) return sync.user.email;
  return '';
}

// Mostra "Nome · Ruolo" accanto al titolo, in base all'account collegato.
function updateUserBadge() {
  const el = $('#user-badge');
  if (!el) return;
  if (!(sync.enabled && sync.user)) { el.classList.add('hidden'); el.classList.remove('flex'); return; }
  const name = userDisplayName();
  const role = roleLabel();
  const client = isClient();
  el.classList.remove('hidden'); el.classList.add('flex');
  el.innerHTML = `
    <span class="hidden sm:inline truncate font-semibold text-ink-soft dark:text-zinc-300">${esc(name)}</span>
    ${role ? `<span class="shrink-0 font-bold rounded-full px-2 py-0.5 ${client ? 'bg-sky-500/10 text-sky-600 dark:text-sky-400' : 'bg-accent-soft text-accent'}">${esc(role)}</span>` : ''}`;
}

function initSync() {
  if (!firebaseConfigured()) { sync.enabled = false; updateSyncBadge(); return; }
  try {
    firebase.initializeApp(window.FIREBASE_CONFIG);
    sync.auth = firebase.auth();
    sync.db = firebase.firestore();
    // Safari/WebKit blocca il trasporto WebChannel di Firestore ("access control
    // checks"). Forzare il long-polling (anziche' il solo auto-detect) e' la
    // configurazione piu' robusta per Safari. Va impostato PRIMA di ogni altra
    // operazione (enablePersistence, onSnapshot, ecc.).
    try { sync.db.settings({ experimentalForceLongPolling: true }); } catch (_) {}
    sync.enabled = true;
    sync.ready = true;
    // La persistenza IndexedDB di Firestore puo' "ingolfare" il client su iOS/iPadOS
    // (ogni lettura resta appesa). Se l'auto-ripristino l'ha disattivata, la saltiamo:
    // le letture vanno dirette in rete e i dati offline restano nel DB locale dell'app.
    let usePersist = true;
    try { if (localStorage.getItem('hf_skip_persist') === '1') usePersist = false; } catch (_) {}
    if (usePersist) {
      try { sync.db.enablePersistence({ synchronizeTabs: true }).catch(() => {}); } catch (_) {}
    } else {
      try { console.warn('[sync] persistenza Firestore disattivata (auto-ripristino)'); } catch (_) {}
    }
    sync.auth.onAuthStateChanged(onAuthChanged);
    // In modalità app/PWA (soprattutto iOS) le connessioni realtime vengono
    // sospese in background: al ritorno in primo piano si ri-aggancia il flusso.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !sync.user) return;
      if (isClient()) attachClientStatementByEmail();
      else publishAllStatements();
    });
    setSyncStatus('signedout');
  } catch (err) {
    sync.enabled = false;
    updateSyncBadge();
  }
}

function onAuthChanged(user) {
  sync.user = user || null;
  if (user) {
    if (sync.pendingRole) sync.role = sync.pendingRole;
    startCloudListener();
  } else {
    sync.role = null;
    sync.pendingRole = null;
    stopCloudListener();
    resetSyncShadow();
    setSyncStatus('signedout');
  }
  render();
}

// Svuota l'ombra del server e i flag di idratazione (al logout o cambio utente).
function resetSyncShadow() {
  for (const s of SYNC_STORES) { sync.server[s] = new Map(); sync.hydrated[s] = false; }
  sync.serverSettingsAt = 0;
}

async function startCloudListener() {
  if (!sync.user) return;
  setSyncStatus('syncing');
  syncStage('start');
  stopCloudListener();
  resetSyncShadow();
  try {
    await initialHydrate();        // caricamento iniziale deterministico (one-shot .get)
  } catch (err) {
    setSyncStatus('error');
    if (!maybeRecoverWedgedFirestore(err)) toast(syncErrorMsg(err), 'error');
    return;
  }
  // Se nel frattempo l'utente e' cambiato/uscito (onAuthChanged puo' rifirare),
  // non proseguire con riferimenti non piu' validi: evita TypeError silenziosi
  // che lascerebbero il badge appeso su "syncing".
  if (!sync.user) { setSyncStatus('signedout'); return; }
  syncStage('attach-listeners');
  try {
    attachParentDocListener();
    if (isClient()) {
      // Cliente: trova lo statement che lo riguarda (per email) e lo legge live;
      // nessun listener sui propri record per non sovrascrivere i dati condivisi.
      attachClientStatementByEmail();
    } else {
      attachRecordListeners();      // merge per-record realtime
      publishAllStatements();       // (ri)pubblica gli statement dei clienti associati
    }
  } catch (err) {
    setSyncStatus('error');
    toast(syncErrorMsg(err), 'error');
    return;
  }
  syncStage('done');
  setSyncStatus('synced');
}

function stopCloudListener() {
  if (sync.unsub) { sync.unsub(); sync.unsub = null; }
  for (const u of sync.colUnsubs) { try { u(); } catch (_) {} }
  sync.colUnsubs = [];
  if (sync.share.unsub) { try { sync.share.unsub(); } catch (_) {} sync.share.unsub = null; }
  if (sync.share.linksUnsub) { try { sync.share.linksUnsub(); } catch (_) {} sync.share.linksUnsub = null; }
  sync.share.linked = false;
  sync.share.curKey = null;
  sync.share.statementRef = null;
  sync.share.lastAppliedAt = 0;
  clearInterval(sync.share.pollTimer); sync.share.pollTimer = null;
  clearTimeout(sync.share.pubTimer);
  clearTimeout(sync.reloadTimer);
}

// Caricamento iniziale deterministico via .get() (l'ordine d'arrivo tra documento
// padre e sottocollezioni nei listener NON e' garantito, quindi non ci si appoggia
// ad esso). Account inesistente -> push dello stato locale. Account esistente ->
// il cloud e' autoritativo: si sostituiscono i record locali (inclusi i dati demo
// di un'installazione nuova), coerentemente col comportamento storico.
// Lettura Firestore a prova di stallo: tenta il server, ma se entro `ms` non
// risponde (canale realtime sospeso in modalita' app/PWA su iOS) ripiega sulla
// cache locale di Firestore. Senza questa rete di sicurezza la prima idratazione
// poteva restare appesa per sempre -> badge bloccato su "In Sincronia...".
function getWithTimeout(ref, serverMs = 9000, cacheMs = 2500) {
  const bound = (p, ms) => {
    let t;
    const timeout = new Promise((_, reject) => { t = setTimeout(() => reject(new Error('sync-timeout')), ms); });
    return Promise.race([p, timeout]).finally(() => clearTimeout(t));
  };
  // Prima il server (limite generoso, regge anche reti lente); se non risponde,
  // la cache locale (deve essere istantanea). Entrambi i tentativi sono limitati,
  // quindi questa funzione NON puo' restare appesa: o risolve o rigetta entro ~11s.
  return bound(ref.get(), serverMs).catch(() => bound(ref.get({ source: 'cache' }), cacheMs));
}

// Auto-ripristino per client Firestore "ingolfato" (tipico di iOS/iPadOS quando la
// persistenza IndexedDB si blocca): se la prima lettura va in timeout e non l'abbiamo
// gia' tentato in questa sessione, disattiva la persistenza e ricarica UNA volta.
// Ritorna true se ha avviato il ripristino (cosi' il chiamante non mostra il toast d'errore).
function maybeRecoverWedgedFirestore(err) {
  const code = String((err && (err.code || err.message)) || '');
  const looksWedged = /sync-timeout|unavailable|deadline-exceeded|failed-precondition/i.test(code);
  if (!looksWedged) return false;
  try {
    if (sessionStorage.getItem('hf_recovered') === '1') return false; // gia' tentato: non rientrare in loop
    sessionStorage.setItem('hf_recovered', '1');
    localStorage.setItem('hf_skip_persist', '1');
    toast(t('Connessione cloud bloccata: riavvio senza cache locale…'), 'warning');
    setTimeout(() => { try { location.reload(); } catch (_) {} }, 1500);
    return true;
  } catch (_) { return false; }
}

// Account senza documento utente (creato dalla console o dalla fabbrica
// account): se esiste uno statement indirizzato alla sua email, è un Cliente.
// La query links richiede email verificata (regole Firestore).
async function probeClientByLinks() {
  try {
    if (!(sync.user && sync.user.email && sync.user.emailVerified)) return false;
    const qs = await sync.db.collection('links')
      .where('viewerEmail', '==', String(sync.user.email).toLowerCase())
      .limit(1).get();
    return !qs.empty;
  } catch (_) { return false; }
}

// Corregge un account cliente finito per errore con ruolo Proprietario (o senza
// ruolo): scrive accountRole=client sul documento e riparte come Cliente.
async function adoptClientRole() {
  sync.role = 'client';
  try {
    await userDocRef().set({ accountRole: 'client', schema: CLOUD_SCHEMA,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
  } catch (_) {}
  startCloudListener(); // ri-aggancia i listener nel flusso Cliente
}

async function initialHydrate() {
  syncStage('hydrate:parent-get');
  const snap = await getWithTimeout(userDocRef());

  if (!snap.exists) {
    // Prima di presumere "Proprietario" (e caricare i dati locali sul cloud),
    // verifica se questo account è il destinatario di uno statement: in quel
    // caso è un Cliente e i dati locali NON vanno pubblicati.
    if (!sync.role && await probeClientByLinks()) sync.role = 'client';
    for (const s of SYNC_STORES) sync.hydrated[s] = true; // niente sul cloud da leggere
    syncStage('hydrate:push-new');
    await pushNow();  // Proprietario: carica lo stato locale; Cliente: solo il proprio profilo
    return;
  }

  const data = snap.data() || {};
  if (data.accountRole === 'client' || data.accountRole === 'owner') sync.role = data.accountRole;
  else if (!sync.role) sync.role = 'owner';

  // Migrazione una-tantum dal vecchio documento unico con array.
  if ((!data.schema || data.schema < CLOUD_SCHEMA) && hasLegacyArrays(data)) {
    await migrateLegacyDoc(data);
  }

  sync.applyingRemote = true;
  try {
    syncStage('hydrate:clear');
    await dbClear('projects'); await dbClear('entries'); await dbClear('clients'); await dbClear('payments');
    await dbClear('expenses'); await dbClear('quotes');
    for (const store of SYNC_STORES) {
      try {
        syncStage('hydrate:get:' + store);
        const qs = await getWithTimeout(colRef(store));
        for (const doc of qs.docs) {
          const at = typeof doc.data().updatedAt === 'number' ? doc.data().updatedAt : 0;
          sync.server[store].set(doc.id, at);
          await dbPut(store, { ...doc.data(), id: doc.id }); // applyingRemote=true: updatedAt preservato
        }
        sync.hydrated[store] = true;
      } catch (e) {
        // A store may be unreadable (e.g. Firestore rules not yet updated for a new
        // collection): skip it so the rest of the sync still completes.
        sync.hydrated[store] = true;
      }
    }
    if (data.settings && typeof data.settings === 'object') {
      sync.serverSettingsAt = typeof data.settingsAt === 'number' ? data.settingsAt : 0;
      await dbPut('settings', { ...data.settings, id: 'app' });
    }
    syncStage('hydrate:loadState');
    await loadState();
    render();
  } finally {
    sync.applyingRemote = false;
  }
}

function attachParentDocListener() {
  // Documento padre: ruolo + impostazioni in tempo reale.
  sync.unsub = userDocRef().onSnapshot(
    (snap) => {
      if (!snap.exists) return;
      if (snap.metadata && snap.metadata.hasPendingWrites) return;
      applyParentDoc(snap.data());
    },
    (err) => { setSyncStatus('error'); toast(syncErrorMsg(err), 'error'); }
  );
}

function attachRecordListeners() {
  // Sottocollezioni record: merge per-record in tempo reale.
  for (const store of SYNC_STORES) {
    const unsub = colRef(store).onSnapshot(
      (qs) => handleColSnapshot(store, qs),
      (err) => { setSyncStatus('error'); toast(syncErrorMsg(err), 'error'); }
    );
    sync.colUnsubs.push(unsub);
  }
}

function attachRealtimeListeners() {
  attachParentDocListener();
  attachRecordListeners();
}

// Documento padre in tempo reale: solo ruolo + impostazioni (oggetto singolo,
// last-write-wins per timestamp). I record viaggiano nelle sottocollezioni.
async function applyParentDoc(data) {
  if (!data) return;
  sync.applyingRemote = true;
  try {
    if (data.accountRole === 'client' || data.accountRole === 'owner') {
      sync.role = data.accountRole;
    } else if (!sync.role) {
      sync.role = 'owner';
    }
    const at = typeof data.settingsAt === 'number' ? data.settingsAt : 0;
    if (data.settings && typeof data.settings === 'object' && at > sync.serverSettingsAt) {
      sync.serverSettingsAt = at;
      // Merge sopra le impostazioni correnti: per il Cliente preserva l'overlay
      // dei dati del Proprietario ricevuti via statement (IBAN, tariffe, ecc.).
      const settings = { ...state.settings, ...data.settings, id: 'app' };
      await dbPut('settings', settings);
      state.settings = settings;
      render();
      if (!isClient()) schedulePublish();   // tariffe/IBAN aggiornati -> ripubblica
    }
  } catch (err) {
    console.error('applyParentDoc failed', err);
  } finally {
    sync.applyingRemote = false;
  }
}

function hasLegacyArrays(data) {
  return Array.isArray(data.projects) || Array.isArray(data.entries) || Array.isArray(data.clients);
}

// Migrazione: copia gli array del vecchio documento nelle sottocollezioni e
// ripulisce il documento padre. Idempotente (gira solo finche' schema < CLOUD_SCHEMA).
// Lo stato locale viene poi ripopolato da initialHydrate via .get().
async function migrateLegacyDoc(data) {
  const ts = Date.now();
  const FieldValue = firebase.firestore.FieldValue;
  const groups = {
    projects: Array.isArray(data.projects) ? data.projects : [],
    entries:  Array.isArray(data.entries)  ? data.entries  : [],
    clients:  Array.isArray(data.clients)  ? data.clients  : []
  };

  const batches = [];
  let batch = sync.db.batch(); let ops = 0;
  const rotate = () => { batches.push(batch); batch = sync.db.batch(); ops = 0; };

  for (const store of SYNC_STORES) {
    for (const rec of groups[store]) {
      if (!rec || typeof rec !== 'object') continue;
      if (!rec.id) rec.id = genId();
      if (typeof rec.updatedAt !== 'number') rec.updatedAt = ts;
      batch.set(colRef(store).doc(String(rec.id)), rec);
      if (++ops >= 450) rotate();
    }
  }

  // Rimuove gli array legacy dal documento padre e segna lo schema nuovo.
  batch.set(userDocRef(), {
    schema: CLOUD_SCHEMA,
    projects: FieldValue.delete(),
    entries: FieldValue.delete(),
    clients: FieldValue.delete(),
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  batches.push(batch);

  for (const b of batches) await b.commit();
  toast(t('Sincronizzazione aggiornata al nuovo modello per-record.'));
}

// Pull per-record: applica i cambiamenti remoti con confronto updatedAt.
// Il remoto vince solo se non e' piu' vecchio del locale.
function handleColSnapshot(store, qs) {
  sync.applyingRemote = true;
  const tasks = [];
  // Il corpo e' protetto: un'eccezione qui (es. store imprevisto) NON deve
  // lasciare applyingRemote incastrato a true, altrimenti il push si blocca.
  try {
    qs.docChanges().forEach((chg) => {
      const id = chg.doc.id;
      const pending = chg.doc.metadata && chg.doc.metadata.hasPendingWrites;
      if (chg.type === 'removed') {
        sync.server[store].delete(id);
        if (pending) return;                 // eco della nostra eliminazione
        tasks.push(removeRecordLocally(store, id));
        return;
      }
      const data = chg.doc.data() || {};
      const remoteAt = typeof data.updatedAt === 'number' ? data.updatedAt : 0;
      sync.server[store].set(id, remoteAt);
      if (pending) return;                   // eco della nostra scrittura
      const local = state[store].find(x => x.id === id);
      if (!local || remoteAt > (local.updatedAt || 0)) {
        tasks.push(dbPut(store, { ...data, id }));
      }
    });
  } catch (err) {
    console.error('handleColSnapshot failed', err);
  }
  Promise.all(tasks).catch((err) => console.error('handleColSnapshot tasks failed', err)).finally(() => {
    sync.applyingRemote = false;
    sync.hydrated[store] = true;
    scheduleReload();
    if (!isClient()) schedulePublish();   // ripubblica gli statement dei clienti collegati
  });
}

async function removeRecordLocally(store, id) {
  if (!state[store].some(x => x.id === id)) return;
  await dbDel(store, id);
}

// Ricarica lo stato e ridisegna, accorpando i molti snapshot del caricamento iniziale.
function scheduleReload() {
  clearTimeout(sync.reloadTimer);
  sync.reloadTimer = setTimeout(async () => {
    await loadState();
    render();
  }, 150);
}

// Push diff-based: documento padre (impostazioni/ruolo) + un upsert/delete per
// ogni record cambiato rispetto all'ombra del server.
async function pushNow() {
  if (!sync.user) return;
  setSyncStatus('syncing');
  try {
    const FieldValue = firebase.firestore.FieldValue;
    const client = isClient();

    // (1) Documento padre: impostazioni come oggetto singolo (LWW per timestamp).
    // Il Cliente pubblica SOLO le proprie impostazioni (tema/profilo/collegamento),
    // mai i dati del Proprietario ricevuti via statement.
    const settingsAt = Date.now();
    await userDocRef().set({
      accountRole: sync.role || 'owner',
      settings: client ? clientOwnSettings() : state.settings,
      settingsAt,
      schema: CLOUD_SCHEMA,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    // Aggiornato solo a scrittura riuscita: se il set fallisce, il prossimo push
    // non deve credere che le impostazioni siano già sul server.
    sync.serverSettingsAt = settingsAt;

    // (2) Record: solo il Proprietario sincronizza le proprie sottocollezioni.
    if (!client) {
      for (const store of SYNC_STORES) {
        const seen = new Set();
        let batch = sync.db.batch(); let ops = 0; let staged = [];
        // Il mirror sync.server si aggiorna SOLO a commit riuscito: se si
        // aggiornasse prima e il batch fallisse, i record risulterebbero già
        // sincronizzati e non verrebbero mai ritentati (perdita dati silenziosa).
        const commit = async () => {
          if (ops > 0) {
            await batch.commit();
            for (const apply of staged) apply();
            batch = sync.db.batch(); ops = 0; staged = [];
          }
        };

        // Upsert: record assenti sul server o piu' recenti del server.
        for (const rec of state[store]) {
          if (!rec || !rec.id) continue;
          const id = String(rec.id);
          seen.add(id);
          const known = sync.server[store].get(id);
          const at = typeof rec.updatedAt === 'number' ? rec.updatedAt : Date.now();
          if (known === undefined || at > known) {
            batch.set(colRef(store).doc(id), { ...rec, id, updatedAt: at });
            staged.push(() => sync.server[store].set(id, at));
            if (++ops >= 450) await commit();
          }
        }

        // Eliminazioni: presenti sul server ma non piu' in locale. Solo a
        // sottocollezione idratata, per non cancellare dati non ancora letti.
        if (sync.hydrated[store]) {
          for (const id of Array.from(sync.server[store].keys())) {
            if (!seen.has(id)) {
              batch.delete(colRef(store).doc(id));
              staged.push(() => sync.server[store].delete(id));
              if (++ops >= 450) await commit();
            }
          }
        }
        await commit();
      }
      schedulePublish();   // aggiorna gli statement dei clienti collegati
    }
    setSyncStatus('synced');
  } catch (err) {
    setSyncStatus('error');
    toast(syncErrorMsg(err), 'error');
  }
}

function cloudPush() {
  if (!sync.enabled || !sync.user || sync.applyingRemote) return;
  setSyncStatus('syncing');
  clearTimeout(sync.pushTimer);
  sync.pushTimer = setTimeout(pushNow, 400);
}

// Aggiornamento manuale: ristabilisce i listener e ricarica i dati dal cloud.
// Utile in modalità app (PWA) dove non c'è il pulsante di ricarica del browser,
// e come rete di sicurezza se un aggiornamento in tempo reale viene perso.
async function forceRefresh() {
  if (!sync.enabled || !sync.user) {
    try { await loadState(); } catch (_) {}
    render();
    toast(t('Aggiornato'));
    return;
  }
  setSyncStatus('syncing');
  try {
    await startCloudListener();
    toast(t('Dati aggiornati'));
  } catch (err) {
    setSyncStatus('error');
    toast(t('Errore di aggiornamento'), 'error');
  }
}

/* ---------------------------------------------------------------------
   CONDIVISIONE OWNER -> CLIENTE (Architettura A: statement pubblicato)
   - Associazione guidata dal Proprietario tramite l'EMAIL dell'account Cliente.
   - Il Proprietario pubblica users/{ownerUid}/statements/{clientId} (solo i dati
     di quel cliente) e un indice links/{ownerUid_clientId} per la scoperta.
   - Il Cliente, al login, trova lo statement che lo riguarda tramite la propria
     email e lo legge in tempo reale: nessun codice, nessun import di file.
--------------------------------------------------------------------- */

// Impostazioni "proprie" del Cliente (le uniche che il suo account spinge).
function clientOwnSettings() {
  const s = state.settings || {};
  return {
    id: 'app',
    theme: s.theme || 'auto',
    clientProfile: s.clientProfile || { name: '', vat: '', address: '', email: '', phone: '' }
  };
}

// Filtra i contesti (proj:<id>) appartenenti ai progetti del cliente, escludendo
// "proj:all" che e' trasversale e rivelerebbe dati di altri clienti.
function ctxBelongsToProjects(key, projIds) {
  const m = /^proj:([^|]+)\|/.exec(key || '');
  return !!(m && m[1] !== 'all' && projIds.has(m[1]));
}

// Statement (estratto) per un singolo cliente, indirizzato alla sua email.
function buildClientStatement(clientId, viewerEmail) {
  const projects = state.projects.filter(p => p.clientId === clientId);
  const projIds = new Set(projects.map(p => p.id));
  const entries = state.entries.filter(e => projIds.has(e.projectId));
  const payments = state.payments.filter(p => ctxBelongsToProjects(p.ctx, projIds));
  const reg = (state.settings && state.settings.noteRegistry) || {};
  const noteRegistry = {};
  for (const k in reg) if (ctxBelongsToProjects(k, projIds)) noteRegistry[k] = reg[k];
  const client = state.clients.find(c => c.id === clientId) || null;
  const s = state.settings || {};
  const settings = {
    holderName: s.holderName || '', iban: s.iban || '', bic: s.bic || '',
    causale: s.causale || '', stampDuty: !!s.stampDuty,
    hourlyRate: Number(s.hourlyRate) || 0, extra: Number(s.extra) || 0,
    taxRate: Number(s.taxRate) || 0, vatRate: Number(s.vatRate) || 0,
    withholdingTaxRate: Number(s.withholdingTaxRate) || 0,
    noteRegistry
  };
  return {
    ownerUid: sync.user.uid, clientId, viewerEmail: String(viewerEmail || '').toLowerCase(),
    updatedAt: Date.now(),
    payload: { projects, entries, payments, clients: client ? [client] : [], settings }
  };
}

// Proprietario: scrive statement + indice per UN cliente. Propaga gli errori.
async function publishStatementFor(c) {
  const owner = sync.user.uid;
  const email = String(c.accountEmail || '').trim().toLowerCase();
  if (!email) return;
  const stmt = buildClientStatement(c.id, email);
  await sync.db.collection('users').doc(owner).collection('statements').doc(c.id).set(stmt);
  await sync.db.collection('links').doc(owner + '_' + c.id).set({
    ownerUid: owner, clientId: c.id, viewerEmail: email, clientName: c.name || '', updatedAt: Date.now()
  });
}

// Proprietario: pubblica/aggiorna statement e indice per ogni cliente associato.
async function publishAllStatements() {
  if (!sync.user || isClient()) return;
  let lastErr = null;
  for (const c of state.clients) {
    if (!(c.accountEmail && String(c.accountEmail).trim())) continue;
    try { await publishStatementFor(c); }
    catch (err) { lastErr = err; }
  }
  if (lastErr) { setSyncStatus('error'); toast(t('Pubblicazione dati cliente non riuscita: {e}', { e: syncErrorMsg(lastErr) }), 'error'); }
}

function schedulePublish() {
  if (!sync.user || isClient()) return;
  clearTimeout(sync.share.pubTimer);
  sync.share.pubTimer = setTimeout(publishAllStatements, 600);
}

// Password provvisoria leggibile per i nuovi account cliente.
function genTempPassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  const b = new Uint8Array(10);
  crypto.getRandomValues(b);
  for (const x of b) s += chars[x % chars.length];
  return 'Hf-' + s;
}

// Crea l'account Firebase del cliente SENZA toccare la sessione del
// Proprietario: usa un'app secondaria usa-e-getta, invia subito l'email di
// verifica (richiesta dalle regole Firestore per leggere i dati condivisi)
// e chiude la sessione temporanea.
async function createClientAuthAccount(email, password) {
  const sec = firebase.initializeApp(window.FIREBASE_CONFIG, 'account-factory-' + Date.now());
  try {
    const cred = await sec.auth().createUserWithEmailAndPassword(email, password);
    try { await cred.user.sendEmailVerification(); } catch (_) {}
    // Documento utente con ruolo Cliente scritto SUBITO (con la sessione
    // temporanea): al primo login l'app lo riconosce come Cliente e non
    // pubblica i dati locali del dispositivo come se fosse un Proprietario.
    try {
      await sec.firestore().collection('users').doc(cred.user.uid).set({
        accountRole: 'client', schema: CLOUD_SCHEMA,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    } catch (_) {}
    await sec.auth().signOut();
    return { created: true };
  } catch (err) {
    if (err && err.code === 'auth/email-already-in-use') return { created: false, exists: true };
    throw err;
  } finally {
    try { await sec.delete(); } catch (_) {}
  }
}

// Proprietario: associa l'account del cliente indicandone l'email di accesso,
// con possibilità di creare l'account di login direttamente da qui.
async function associateClientAccount(clientId) {
  if (isClient()) { toast(t('Solo il Proprietario può associare gli account'), 'error'); return; }
  const c = state.clients.find(x => x.id === clientId);
  if (!c) return;
  const tempPass = genTempPassword();
  openModal({
    title: t('Associa account cliente'),
    bodyHTML: `
      <p class="text-[14px] text-ink-soft dark:text-zinc-300 mb-3">${t('Inserisci l\'{e} a HourFlow. Da quel momento, accedendo, vedrà in automatico i dati che lo riguardano — senza codici né file.', { e: `<span class="font-bold">${t('email con cui il cliente accede')}</span>` })}</p>
      <input id="assoc-email" type="email" autocomplete="off" class="field" value="${esc(c.accountEmail || c.email || '')}" placeholder="${esc(t('email@cliente.it'))}" />
      <label for="assoc-create" class="mt-3 flex items-start gap-2.5 cursor-pointer select-none">
        <input id="assoc-create" type="checkbox" class="w-4 h-4 mt-0.5 shrink-0" style="accent-color:#FF9500" checked />
        <span class="text-[13px] font-semibold text-ink-soft dark:text-zinc-400">${t('Crea anche l\'account di accesso')}
          <span class="block text-[11px] font-medium text-ink-faint dark:text-zinc-500 mt-0.5">${t('Se il cliente non si è ancora registrato, l\'account viene creato ora con la password qui sotto (da comunicargli). Riceverà l\'email per verificare l\'indirizzo. La tua sessione non viene toccata.')}</span>
        </span>
      </label>
      <div class="mt-3">
        <label for="assoc-pass" class="block text-[13px] font-semibold text-ink-soft mb-1.5">${t('Password provvisoria del cliente')}</label>
        <input id="assoc-pass" type="text" autocomplete="off" spellcheck="false" class="field" value="${esc(tempPass)}" />
      </div>`,
    confirmText: t('Associa'),
    onConfirm: async (card) => {
      const el = $('#assoc-email', card);
      const email = (el ? el.value : '').trim().toLowerCase();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showError(card, t('Inserisci un\'email valida')); return false; }
      const wantCreate = $('#assoc-create', card).checked;
      const pass = ($('#assoc-pass', card).value || '').trim();
      if (wantCreate && pass.length < 8) { showError(card, t('La password provvisoria deve avere almeno 8 caratteri.')); return false; }

      let createdNow = false;
      if (wantCreate) {
        try {
          const res = await createClientAuthAccount(email, pass);
          createdNow = res.created;
          if (!res.created) toast(t('Account già esistente: completo solo l\'associazione'));
        } catch (err) {
          showError(card, t('Creazione account non riuscita: {e}', { e: authError(err.code || '') }));
          return false;
        }
      }

      const updated = { ...c, accountEmail: email, updatedAt: Date.now() };
      await dbPut('clients', updated);
      state.clients = state.clients.map(x => x.id === clientId ? updated : x);
      cloudPush();
      try {
        await publishStatementFor(updated);   // scrittura verificata (propaga errori)
        toast(t('Account associato: il cliente vedrà i dati a breve'));
      } catch (err) {
        toast(t('Associazione NON riuscita: {e} — pubblica le regole Firestore aggiornate', { e: syncErrorMsg(err) }), 'error');
      }
      renderClients();
      if (createdNow) showClientCredentials(email, pass);
    }
  });
}

// Riepilogo credenziali da consegnare al cliente appena creato.
function showClientCredentials(email, pass) {
  openModal({
    title: t('Credenziali del cliente'),
    bodyHTML: `
      <p class="text-[14px] text-ink-soft dark:text-zinc-300 mb-3">${t('Account creato. Comunica queste credenziali al cliente: {b} che ha ricevuto via email.', { b: `<span class="font-bold">${t('prima del primo accesso deve cliccare il link di verifica')}</span>` })}</p>
      <div class="rounded-xl border border-black/10 dark:border-white/10 p-3 text-[13px]">
        <div>${t('Email:')} <span class="font-bold">${esc(email)}</span></div>
        <div class="mt-1">${t('Password provvisoria:')} <span class="font-bold">${esc(pass)}</span></div>
      </div>
      <button id="cred-copy" type="button" class="mt-3 px-4 py-2 rounded-full border border-black/10 dark:border-white/10 hover:bg-black/[.03] dark:hover:bg-white/[.03] text-[13px] font-bold transition-soft">${t('Copia credenziali')}</button>`,
    confirmText: t('Fatto'),
    onMount: (card) => {
      const btn = $('#cred-copy', card);
      if (btn) btn.addEventListener('click', () => {
        copyText(`HourFlow — ${t('accesso cliente')}\nEmail: ${email}\n${t('Password provvisoria:')} ${pass}\n${t('Prima di accedere clicca il link di verifica ricevuto via email.')}`)
          .then(() => toast(t('Credenziali copiate negli appunti')));
      });
    }
  });
}

// Proprietario: rimuove l'associazione (cancella statement e indice).
function removeClientAssociation(clientId) {
  if (isClient()) return;
  const c = state.clients.find(x => x.id === clientId);
  if (!c) return;
  openModal({
    title: t('Rimuovere l\'associazione?'),
    danger: true,
    bodyHTML: `<p class="text-[14px]">${t('Il cliente {c} non vedrà più i dati condivisi.', { c: `<span class="font-bold">${esc(c.name)}</span>` })}</p>`,
    confirmText: t('Rimuovi'),
    onConfirm: async () => {
      const owner = sync.user.uid;
      const updated = { ...c, accountEmail: '', updatedAt: Date.now() };
      await dbPut('clients', updated);
      state.clients = state.clients.map(x => x.id === clientId ? updated : x);
      cloudPush();
      try { await sync.db.collection('users').doc(owner).collection('statements').doc(clientId).delete(); } catch (_) {}
      try { await sync.db.collection('links').doc(owner + '_' + clientId).delete(); } catch (_) {}
      toast(t('Associazione rimossa'));
      renderClients();
    }
  });
}

// Cliente: trova (in tempo reale) lo statement indirizzato alla propria email e
// lo legge. Se l'associazione arriva dopo il login, compare comunque da sola.
async function attachClientStatementByEmail() {
  if (sync.share.linksUnsub) { try { sync.share.linksUnsub(); } catch (_) {} sync.share.linksUnsub = null; }
  if (sync.share.unsub) { try { sync.share.unsub(); } catch (_) {} sync.share.unsub = null; }
  clearInterval(sync.share.pollTimer); sync.share.pollTimer = null;
  sync.share.curKey = null;
  sync.share.statementRef = null;
  const email = (sync.user && sync.user.email ? sync.user.email : '').toLowerCase();
  if (!email) return;
  // I dati condivisi si aprono solo a identità verificata: Firebase permette di
  // registrare account con email altrui non confermate, che altrimenti
  // combacerebbero con viewerEmail. (La barriera server è nelle regole
  // Firestore: request.auth.token.email_verified — vedi FIRESTORE_RULES.md.)
  // Se il cliente ha appena cliccato il link di verifica, reload() vede il
  // nuovo stato e getIdToken(true) rinnova il token con il claim aggiornato:
  // niente logout/login, niente "permission denied" da token vecchio.
  if (!sync.user.emailVerified) {
    try { await sync.user.reload(); } catch (_) {}
    if (sync.user.emailVerified) {
      try { await sync.user.getIdToken(true); } catch (_) {}
    }
  }
  if (!sync.user.emailVerified) {
    toast(t('Verifica la tua email per consultare i dati condivisi: Impostazioni → "Verifica ora", poi ricarica HourFlow.'), 'warning');
    if (state.view === 'settings') renderSettings();
    return;
  }
  sync.share.linksUnsub = sync.db.collection('links').where('viewerEmail', '==', email)
    .onSnapshot((qs) => {
      if (qs.empty) { sync.share.linked = false; sync.share.curKey = null; sync.share.statementRef = null;
        if (sync.share.unsub) { try { sync.share.unsub(); } catch (_) {} sync.share.unsub = null; }
        if (state.view === 'settings') renderSettings(); return; }
      sync.share.linked = true;
      const link = qs.docs[0].data() || {};
      const key = String(link.ownerUid) + '/' + String(link.clientId);
      // Riaggancia il listener dello statement SOLO se cambia il bersaglio,
      // così le ri-scritture dell'indice non interrompono il flusso realtime.
      if (key !== sync.share.curKey || !sync.share.unsub) {
        sync.share.curKey = key;
        if (sync.share.unsub) { try { sync.share.unsub(); } catch (_) {} sync.share.unsub = null; }
        const ref = sync.db.collection('users').doc(link.ownerUid).collection('statements').doc(link.clientId);
        sync.share.statementRef = ref;
        sync.share.unsub = ref.onSnapshot(
          (snap) => { if (snap.exists) applyStatement(snap.data()); },
          () => { setSyncStatus('error'); }
        );
      }
      if (state.view === 'settings') renderSettings();
    }, (err) => {
      // Errore di lettura dell'indice (es. regole non aggiornate): rendilo visibile.
      sync.share.linked = false;
      setSyncStatus('error');
      toast(t('Lettura dati condivisi negata: {e}', { e: syncErrorMsg(err) }), 'error');
      if (state.view === 'settings') renderSettings();
    });
  // Rete di sicurezza: rilettura periodica nel caso il realtime cada in background.
  sync.share.pollTimer = setInterval(pollStatement, 30000);
}

// Cliente: rilegge lo statement e lo applica solo se più recente di quello già visto.
function pollStatement() {
  if (!sync.share.statementRef || document.visibilityState !== 'visible') return;
  sync.share.statementRef.get()
    .then((snap) => {
      if (snap && snap.exists) {
        const data = snap.data() || {};
        const at = typeof data.updatedAt === 'number' ? data.updatedAt : 0;
        if (at > (sync.share.lastAppliedAt || 0)) applyStatement(data);
      }
    })
    .catch(() => {});
}

// Cliente: applica lo statement ricevuto allo stato locale (sola lettura).
async function applyStatement(data) {
  const p = (data && data.payload) || {};
  sync.share.lastAppliedAt = typeof data.updatedAt === 'number' ? data.updatedAt : (sync.share.lastAppliedAt || 0);
  sync.applyingRemote = true;
  try {
    await dbClear('projects'); await dbClear('entries'); await dbClear('clients'); await dbClear('payments');
    for (const r of (p.projects || [])) await dbPut('projects', r);
    for (const r of (p.entries || [])) await dbPut('entries', r);
    for (const r of (p.payments || [])) await dbPut('payments', r);
    for (const r of (p.clients || [])) await dbPut('clients', r);
    const own = state.settings || {};
    const merged = { ...own, ...(p.settings || {}), id: 'app',
      theme: own.theme, clientProfile: own.clientProfile };
    await dbPut('settings', merged);
    await loadState();
    render();
    setSyncStatus('synced');
  } finally { sync.applyingRemote = false; }
}

function syncErrorMsg(err) {
  const code = (err && err.code) ? String(err.code) : '';
  if (code.indexOf('permission-denied') !== -1) {
    return t('Permesso Firestore negato. Verifica regole di scrittura.');
  }
  return t('Errore cloud: {c}', { c: code });
}

function authError(code) {
  const map = {
    'auth/invalid-email': t('Formato email non corretto.'),
    'auth/missing-password': t('Digitare la password.'),
    'auth/weak-password': t('Scegliere una password di almeno 6 caratteri.'),
    'auth/email-already-in-use': t('Email già associata ad un account esistente.'),
    'auth/wrong-password': t('Credenziali non corrette.')
  };
  return map[code] || t('Errore autenticazione.');
}

async function doSignIn(email, password) {
  try {
    sync.pendingRole = null;
    await sync.auth.signInWithEmailAndPassword(email, password);
    toast(t('Login effettuato correttamente'));
  } catch (err) {
    showAuthError(authError(err.code));
    toast(authError(err.code), 'error');
  }
}

async function doSignUp(email, password, role) {
  try {
    sync.pendingRole = (role === 'client') ? 'client' : 'owner';
    sync.role = sync.pendingRole;
    await sync.auth.createUserWithEmailAndPassword(email, password);
    // La verifica parte subito: serve al ruolo Cliente per leggere i dati
    // condivisi (regole Firestore) e in generale a confermare l'indirizzo.
    try { await sync.auth.currentUser.sendEmailVerification(); } catch (_) {}
    toast(t("Registrazione completata: controlla l'email per il link di verifica"));
  } catch (err) {
    sync.pendingRole = null;
    showAuthError(authError(err.code));
    toast(authError(err.code), 'error');
  }
}

async function doSignOut() {
  try { await sync.auth.signOut(); toast(t('Disconnessione avvenuta correttamente')); }
  catch (err) { toast(t('Impossibile disconnettere'), 'error'); }
}

async function doSendVerification() {
  if (!sync.user) return;
  try {
    await sync.user.sendEmailVerification();
    toast(t('Email di controllo recapitata'));
  } catch (err) {
    toast(authError(err.code), 'error');
  }
}

async function doSendPasswordReset() {
  if (!(sync.auth && sync.user && sync.user.email)) { toast(t('Nessun account connesso'), 'error'); return; }
  try {
    await sync.auth.sendPasswordResetEmail(sync.user.email);
    toast(t('Email per reimpostare la password inviata a {e}', { e: sync.user.email }));
  } catch (err) {
    toast(authError(err.code), 'error');
  }
}

function showAuthError(message) {
  const box = $('#a-error');
  if (box) { box.textContent = message; box.classList.remove('hidden'); }
}

function accountPanelHTML() {
  if (!sync.enabled) {
    return `
      <div class="bg-white dark:bg-darkCard rounded-xl2 border border-black/5 dark:border-darkBorder p-5 shadow-sm mb-4">
        <div class="text-[11px] uppercase tracking-wider text-ink-faint dark:text-zinc-500 font-bold mb-2">${t('Infrastruttura Cloud')}</div>
        <p class="text-[13px] text-ink-soft dark:text-zinc-400 leading-relaxed font-semibold">${t('Configura l\'oggetto {c} nel sorgente per abilitare la sincronizzazione automatica multi-dispositivo.', { c: '<code class="text-accent">FIREBASE_CONFIG</code>' })}</p>
      </div>`;
  }
  if (sync.user) {
    const statusBase = { syncing: t('Sincronia in corso…'), synced: t('Tutti i dati sono salvati'), error: t('Rete assente o errore'), signedout: '—', off: '—' }[sync.status] || '';
    // In "syncing"/"error" mostriamo anche lo stadio raggiunto: aiuta a capire dove si ferma.
    const statusText = ((sync.status === 'syncing' || sync.status === 'error') && sync.stage)
      ? `${statusBase} · ${sync.stage}` : statusBase;
    const role = currentRole();
    const roleBadge = role === 'client'
      ? `<span class="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-500">${t('Cliente')}</span>`
      : `<span class="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-accent/15 text-accent">${t('Proprietario')}</span>`;
    const verified = !!sync.user.emailVerified;
    const verifyRow = verified
      ? `<div class="mt-3 flex items-center gap-1.5 text-[12px] text-emerald-600 dark:text-emerald-400 font-bold"><span>✓</span> ${t('Identità verificata')}</div>`
      : `<div class="mt-3 flex items-center justify-between gap-2 text-[12px] text-ink-soft dark:text-zinc-400 font-medium">
           <span class="flex items-center gap-1.5"><span class="text-amber-500">⚠️</span> ${t('Indirizzo non verificato')}</span>
           <button id="a-verify" class="px-3 py-1.5 rounded-full border border-black/10 dark:border-white/10 hover:bg-black/[.03] dark:hover:bg-white/[.03] text-[12px] font-bold transition-soft">${t('Verifica ora')}</button>
         </div>`;
    const roleNote = role === 'client'
      ? `<p class="mt-3 text-[12px] text-ink-faint dark:text-zinc-500 font-medium">${t('L\'account del Cliente ha solo diritto di consultazione senza possibilità di sovrascrivere o eliminare sessioni.')}</p>`
      : '';
    return `
      <div class="bg-white dark:bg-darkCard rounded-xl2 border border-black/5 dark:border-darkBorder p-5 shadow-sm mb-4">
        <div class="text-[11px] uppercase tracking-wider text-ink-faint dark:text-zinc-500 mb-3">${t('Profilo Connesso')}</div>
        <div class="flex items-center justify-between gap-3">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <span class="text-[14px] font-bold truncate text-ink dark:text-white">${esc(sync.user.email || 'Account')}</span>
              ${roleBadge}
            </div>
            <div class="text-[12px] text-ink-soft dark:text-zinc-400 font-semibold mt-0.5">${esc(statusText)}</div>
          </div>
          <button id="a-signout" class="shrink-0 px-4 py-2 rounded-full border border-black/10 dark:border-white/10 hover:bg-black/[.03] dark:hover:bg-white/[.03] text-[13px] font-bold transition-soft">${t('Esci')}</button>
        </div>
        ${verifyRow}
        ${roleNote}
        <div class="mt-3 pt-3 border-t border-black/5 dark:border-white/5">
          <button id="a-passreset" class="text-[12px] font-bold text-accent hover:text-accent-hover transition-soft">${t('Cambia password')}</button>
          <span class="text-[11px] text-ink-faint dark:text-zinc-500 ml-2">${t('— riceverai un\'email per reimpostarla')}</span>
        </div>
      </div>`;
  }
  return `
    <div class="bg-white dark:bg-darkCard rounded-xl2 border border-black/5 dark:border-darkBorder p-5 shadow-sm mb-4">
      <div class="text-[11px] uppercase tracking-wider text-ink-faint dark:text-zinc-500 mb-3">${t('Autenticazione Cloud')}</div>
      <div class="space-y-3">
        <input id="a-email" type="email" autocomplete="email" class="field" placeholder="${esc(t('Indirizzo Email'))}" />
        <input id="a-pass" type="password" autocomplete="current-password" class="field" placeholder="${esc(t('Password (almeno 6 caratteri)'))}" />
        <div>
          <div class="text-[11px] font-bold text-ink-soft dark:text-zinc-400 mb-1.5">${t('Livello di Accesso')} <span class="text-ink-faint">${t('(solo per nuove registrazioni)')}</span></div>
          <div class="seg w-full text-[13px] font-bold" role="tablist" id="a-role">
            <button type="button" data-role="owner" role="tab" aria-selected="true" class="flex-1 py-2">${t('Proprietario')}</button>
            <button type="button" data-role="client" role="tab" aria-selected="false" class="flex-1 py-2">${t('Cliente')}</button>
          </div>
          <p class="text-[11px] text-ink-faint dark:text-zinc-500 mt-2 font-medium" id="a-role-hint">${t('Livello Proprietario: abilitazione modifiche, coordinate IBAN e tariffe.')}</p>
        </div>
        <div id="a-error" class="hidden text-[13px] font-bold text-[#ff3b30]"></div>
        <div class="flex gap-2 pt-1">
          <button id="a-signin" class="flex-1 px-4 py-2.5 rounded-full bg-accent hover:bg-accent-hover text-white text-[14px] font-bold transition-soft shadow-sm">${t('Entra')}</button>
          <button id="a-signup" class="px-4 py-2.5 rounded-full border border-black/10 dark:border-white/10 hover:bg-black/[.03] dark:hover:bg-white/[.03] text-[14px] font-bold transition-soft">${t('Registrati')}</button>
        </div>
      </div>
    </div>`;
}

/* ---------------------------------------------------------------------
   BOOTSTRAP PROCEDURAL (Auto-Recovery & Setup)
--------------------------------------------------------------------- */
// Event binding di base (nav, tema, logo): idempotente, così il percorso
// d'emergenza di boot() non registra listener duplicati su quelli già attivi.
let _coreEventsBound = false;
function bindCoreEvents() {
  if (_coreEventsBound) return;
  _coreEventsBound = true;

  $$('#nav button').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
  const navC = navScrollContainer();
  if (navC) navC.addEventListener('scroll', updateNavFade, { passive: true });
  window.addEventListener('resize', syncNavScroll);

  const themeBtn = $('#theme-toggle');
  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      const isCurrentlyDark = document.body.classList.contains('dark');
      const nextTheme = isCurrentlyDark ? 'light' : 'dark';
      state.settings.theme = nextTheme;
      try { dbPut('settings', state.settings); } catch (_) {}
      syncTheme(nextTheme);
    });
  }

  const homeLogo = $('#home-logo');
  if (homeLogo) homeLogo.addEventListener('click', () => setView('dashboard'));

  const langBtn = $('#lang-toggle');
  if (langBtn) langBtn.addEventListener('click', () => setLang(isEn() ? 'it' : 'en'));
  applyStaticI18n();
}

// Selettore lingua riusato nelle Impostazioni (Proprietario e Cliente).
function langSelectHTML() {
  return `
    <div class="mt-4">
      <label for="s-lang" class="block text-[13px] font-semibold text-ink-soft dark:text-zinc-400 mb-1.5">${t('Lingua')} <span class="text-ink-faint">· Language</span></label>
      <select id="s-lang" class="field">
        <option value="it" ${!isEn() ? 'selected' : ''}>Italiano</option>
        <option value="en" ${isEn() ? 'selected' : ''}>English</option>
      </select>
      <p class="text-[11px] text-ink-faint dark:text-zinc-500 mt-1 leading-snug">${t('Vale per l\'interfaccia e per i documenti generati (PDF della nota e dei preventivi, CSV). Salvata su questo dispositivo.')}</p>
    </div>`;
}
function bindLangSelect() {
  const sel = $('#s-lang');
  if (sel) sel.addEventListener('change', () => setLang(sel.value));
}

async function boot() {
  try {
    try { _db = await openDB(); } catch (dbErr) { initFallbackStorage(); }

    await seedIfEmpty();
    await loadState();

    bindCoreEvents();
    syncNavScroll();

    syncTheme(state.settings.theme || 'auto');
    bindAutoTheme();
    setView('dashboard');
    initSync();
    registerServiceWorker();
    setTimeout(checkDueReminders, 1200);
    
    if (_useFallback) {
      setTimeout(() => { toast(t('Esecuzione locale protetta attiva.'), 'warning'); }, 800);
    }
  } catch (err) {
    initFallbackStorage();
    state.settings = { ...DEFAULT_SETTINGS };
    state.projects = [
      { id: 'p1', name: 'Arcade BrickBoy', createdAt: '2026-06-17', hourlyRate: 30, clientId: 'c1' },
      { id: 'p2', name: 'GameBoy BrickBoy', createdAt: '2026-05-22', hourlyRate: null, clientId: 'c2' },
      { id: 'p3', name: 'Play station 1 BrickBoy', createdAt: '2026-03-30', hourlyRate: 35, clientId: 'c3' }
    ];
    state.clients = [
      { id: 'c1', name: 'Retrogames SRL', address: 'Via Roma 12, Milano', vatCode: 'IT01234567890', email: 'billing@retrogames.it', phone: '' },
      { id: 'c2', name: 'Console Club', address: 'Corso Sempione 8, Roma', vatCode: 'IT09876543210', email: 'amministrazione@consoleclub.it', phone: '' },
      { id: 'c3', name: 'Sony Fans', address: 'Piazza Duomo 3, Torino', vatCode: '', email: '', phone: '' }
    ];
    state.entries = [
      { id: 'e1', projectId: 'p1', spec: 'Seconda Iterazione Arcade', date: '2026-06-17', hours: 1.5 },
      { id: 'e2', projectId: 'p2', spec: 'Seconda Iterazione istruzioni', date: '2026-05-22', hours: 5 },
      { id: 'e3', projectId: 'p2', spec: 'Terza Iterazione istruzioni', date: '2026-06-11', hours: 2.25 },
      { id: 'e4', projectId: 'p3', spec: 'Realizzazione file studio Play Station 1', date: '2026-03-30', hours: 4.75 }
    ];
    state.activeTimer = null;

    bindCoreEvents();
    syncTheme('auto');
    setView('dashboard');

    setTimeout(() => { toast(t('Avvio in modalità d\'emergenza.'), 'warning'); }, 800);
  }
}

document.addEventListener('DOMContentLoaded', boot);
