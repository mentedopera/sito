// ============================================================
// MENTE D'OPERA — proxy assessment & preventivatore
// Server standalone (Node 18+, nessuna dipendenza esterna)
// Variabili d'ambiente richieste su Render:
//   GITHUB_TOKEN      token fine-grained con Contents RW sul repo dati
//   ANTHROPIC_API_KEY chiave API Anthropic
//   ASSESSMENT_KEY    chiave condivisa con i form del sito
//   REPO_DATI         es. "mentedopera/proxy" (default sotto)
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const tls = require('tls');

// --- Notifiche email (SMTP IONOS, nessuna dipendenza) ---
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.ionos.it';
const SMTP_PORT = +(process.env.SMTP_PORT || 465);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const NOTIFY_TO = process.env.NOTIFY_TO || SMTP_USER;

const REPO        = process.env.REPO_DATI || 'mentedopera/proxy';
const ASSESS_PATH = 'data/assessments.json';
const PREV_PATH   = 'data/preventivi.json';
const ASSESS_KEY  = process.env.ASSESSMENT_KEY || 'cambia-questa-chiave';
const ADMIN_KEY   = process.env.ADMIN_KEY || null; // chiave riservata: lista dati e preventivi
const TARIFFA_ORA = 200;
const PREV_MODEL  = 'claude-sonnet-4-20250514';
const PORT        = process.env.PORT || 10000;

async function ghJsonGet(path) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    headers: { 'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'mentedopera-proxy' }
  });
  if (r.status === 404) return { data: [], sha: null };
  if (!r.ok) throw new Error(`ghJsonGet ${path} ${r.status}`);
  const j = await r.json();
  return { data: JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')), sha: j.sha };
}

async function ghJsonSave(path, arr, sha, msg) {
  const body = { message: msg, content: Buffer.from(JSON.stringify(arr, null, 2)).toString('base64') };
  if (sha) body.sha = sha;
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'mentedopera-proxy', 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`ghJsonSave ${path} ${r.status}: ${await r.text()}`);
}

function smtpSend(subject, text) {
  return new Promise((resolve, reject) => {
    if (!SMTP_USER || !SMTP_PASS) return resolve(false); // notifiche non configurate
    const sogg = '=?UTF-8?B?' + Buffer.from(subject).toString('base64') + '?=';
    const corpo = Buffer.from(text).toString('base64').replace(/(.{76})/g, '$1\r\n');
    const msg = [
      `From: Mente d'Opera <${SMTP_USER}>`,
      `To: <${NOTIFY_TO}>`,
      `Subject: ${sogg}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '', corpo, '.'
    ].join('\r\n');
    const passi = [
      'EHLO mentedopera-proxy',
      'AUTH LOGIN',
      Buffer.from(SMTP_USER).toString('base64'),
      Buffer.from(SMTP_PASS).toString('base64'),
      `MAIL FROM:<${SMTP_USER}>`,
      `RCPT TO:<${NOTIFY_TO}>`,
      'DATA',
      msg,
      'QUIT'
    ];
    let i = -1, buf = '';
    const sock = tls.connect(SMTP_PORT, SMTP_HOST, { servername: SMTP_HOST });
    sock.setTimeout(15000, () => { sock.destroy(); reject(new Error('smtp timeout')); });
    sock.on('error', reject);
    sock.on('data', d => {
      buf += d.toString();
      if (!/\r\n$/.test(buf)) return;
      const righe = buf.trim().split('\r\n');
      const ultima = righe[righe.length - 1];
      buf = '';
      if (/^[45]/.test(ultima)) { sock.destroy(); return reject(new Error('smtp: ' + ultima)); }
      i += 1;
      if (i < passi.length) sock.write(passi[i] + '\r\n');
      else { sock.end(); resolve(true); }
    });
  });
}

function inviaNotifica(r) {
  const chi = r.azienda || r.email || 'sconosciuto';
  const fase = r.fase || '?';
  const sogg = `Nuovo check-up — fase ${fase} — ${chi}`;
  const righe = [
    `Nuova compilazione ricevuta (fase ${fase})`,
    '',
    `Azienda: ${r.azienda || 'n.d.'}`,
    `Nome: ${r.nome || 'n.d.'}`,
    `Email: ${r.email || 'n.d.'}`,
    `Telefono: ${r.telefono || 'n.d.'}`,
    r.settore ? `Settore: ${r.settore}` : '',
    r.cluster ? `Cluster: ${r.cluster}` : '',
    r.punteggi ? `Punteggi: automazione ${r.punteggi.automazione}/100 · prontezza ${r.punteggi.prontezza}/100` : '',
    r.profili ? `Profili: ${[].concat(r.profili).join(', ')}` : '',
    r.risparmio_annuo_stimato ? `Risparmio annuo stimato: ${r.risparmio_annuo_stimato}` : '',
    '',
    'Apri il preventivatore: https://mentedopera-proxy.onrender.com/admin',
    '',
    'Consiglio: ricontatta entro un\u2019ora \u2014 i lead caldi valgono il triplo.'
  ].filter(x => x !== '');
  return smtpSend(sogg, righe.join('\n'));
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-assessment-key');
}

function leggiBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1e6) { reject(new Error('payload troppo grande')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const PREV_SYSTEM = `Sei il motore preventivi di Mente d'Opera, società di consulenza AI per PMI italiane.
Ricevi i dati di un potenziale cliente (assessment fase 1/2, questionario tecnico fase 3, note interne del consulente) e produci un preventivo di implementazione realistico e prudente.

REGOLE:
- Tariffa oraria: ${TARIFFA_ORA} euro/ora. Stima le ore per ogni intervento in modo realistico (un agente email con integrazione gestionale: 30-60 ore; un chatbot semplice: 15-25 ore; lettura documenti con inserimento a gestionale: 40-80 ore; integrazioni complesse o sistemi chiusi aumentano le ore).
- Interventi in PRODUZIONE/OPERATIONS: pianificazione o schedulazione produzione 50-100 ore; controllo qualità con analisi di foto/schede 60-120 ore; gestione scorte e riordino fornitori 40-80 ore; raccolta dati da macchine SOLO se le macchine sono già connesse o i dati esistono in digitale, altrimenti indicalo nelle assunzioni come prerequisito (la connessione macchine non è compresa); tracciabilità lotti 40-80 ore. Se i dati di reparto sono su carta, prevedi un intervento di digitalizzazione propedeutica.
- Se i sistemi del cliente non hanno API o accesso admin, prevedi ore aggiuntive o segnala il rischio nelle assunzioni.
- "prerequisiti_cliente" = lista della spesa lato cliente: account e servizi da attivare con costo mensile stimato in euro (es. API Anthropic stimata sui volumi, WhatsApp Business API, helpdesk, hosting). Numeri realistici e prudenti.
- "attivita_fornitore" = cosa mettiamo noi: sviluppo, ambienti di test, monitoraggio, formazione.
- "costi_ricorrenti" = canoni mensili stimati a regime (consumo API in base ai volumi dichiarati, hosting, manutenzione se prevista).
- Dai priorità a ciò che il cliente ha indicato come prioritario e a ciò che le note interne suggeriscono.
- Massimo 6 interventi: se le richieste sono tante, accorpa o sposta in "esclusioni" come fase 2.
- Aggiungi una sezione "strategia_commerciale" AD USO INTERNO del consulente (non verrà mostrata al cliente): se il totale supera 25.000 euro proponi una fasizzazione con valore per fase, partendo dalla fase con il ROI più immediato; 3-4 argomenti di vendita concreti basati sui pain e sui volumi dichiarati dal cliente (cita i suoi numeri); 2-3 obiezioni probabili con la risposta consigliata; le leve di upsell (le esclusioni sono fasi future da seminare).
- Scrivi tutto in italiano, tono professionale e concreto.
- LINGUAGGIO: mai parlare di "sostituire", "rimpiazzare" o "ridurre" il personale. L'AI LIBERA le persone dal lavoro ripetitivo e le valorizza su attività di maggior valore; l'azienda cresce senza aumentare il carico sul team. Usa sempre questa cornice in sintesi, descrizioni e argomenti di vendita.

Rispondi SOLO con JSON valido, senza testo prima o dopo, senza backtick, con questo schema esatto:
{"titolo":string,"sintesi":string,"interventi":[{"nome":string,"descrizione":string,"ore":number}],"prerequisiti_cliente":[{"voce":string,"descrizione":string,"costo_mensile_stimato":number}],"attivita_fornitore":[{"voce":string,"descrizione":string}],"costi_ricorrenti":[{"voce":string,"costo_mensile":number}],"durata_settimane":number,"assunzioni":[string],"esclusioni":[string],"strategia_commerciale":{"fasi_consigliate":[{"fase":string,"contenuto":string,"valore_euro":number}],"argomenti_vendita":[string],"possibili_obiezioni":[{"obiezione":string,"risposta":string}],"leve_upsell":[string]}}`;

async function generaPreventivo(records, note, perimetro) {
  let perimetroMsg = '';
  if (perimetro) {
    if (perimetro.interventi && perimetro.interventi.length) {
      perimetroMsg += `\n\nPERIMETRO DEFINITO DAL CONSULENTE${perimetro.vincolante ? ' (VINCOLANTE: usa ESCLUSIVAMENTE questi interventi, nello stesso ordine, senza aggiungerne altri; puoi solo dettagliarne le descrizioni)' : ' (orientativo: parti da questi, integra solo se chiaramente necessario)'}: \n` +
        perimetro.interventi.map((i, n) => `${n + 1}. ${i.nome}${i.ore ? ` — ore stabilite dal consulente: ${i.ore} (USA QUESTE ORE, non stimarle)` : ''}${i.descrizione ? ` — ${i.descrizione}` : ''}`).join('\n');
    }
    if (perimetro.budget_max) perimetroMsg += `\n\nVINCOLO DI BUDGET: il totale implementazione non deve superare ${perimetro.budget_max} euro. Se necessario riduci il perimetro spostando voci in "esclusioni".`;
    if (perimetro.scadenza) perimetroMsg += `\nVINCOLO DI SCADENZA: ${perimetro.scadenza}.`;
  }
  const userMsg = `DATI CLIENTE (compilati dal cliente: trattali come indicativi, possono essere incompleti):\n${JSON.stringify(records, null, 2)}\n\nNOTE INTERNE DEL CONSULENTE (prevalgono sui dati cliente):\n${note || 'nessuna'}${perimetroMsg}`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: PREV_MODEL, max_tokens: 4000, temperature: 0.2, system: PREV_SYSTEM, messages: [{ role: 'user', content: userMsg }] })
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${await r.text()}`);
  const j = await r.json();
  const txt = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const p = JSON.parse(txt.replace(/```json|```/g, '').trim());

  // Totali ricalcolati lato server; le ore del consulente prevalgono
  p.interventi = (p.interventi || []).map(i => ({ ...i, ore: Math.round(+i.ore || 0) }));
  if (perimetro && perimetro.vincolante && perimetro.interventi && perimetro.interventi.length === p.interventi.length) {
    p.interventi = p.interventi.map((i, n) => perimetro.interventi[n].ore ? { ...i, ore: Math.round(perimetro.interventi[n].ore) } : i);
  }
  p.interventi = p.interventi.map(i => ({ ...i, prezzo: i.ore * TARIFFA_ORA }));
  p.totale_ore = p.interventi.reduce((s, i) => s + i.ore, 0);
  p.totale_implementazione = p.totale_ore * TARIFFA_ORA;
  p.tariffa_oraria = TARIFFA_ORA;
  return p;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/' || req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, servizio: 'mentedopera-proxy' }));
    }

    if (req.method === 'GET' && req.url === '/admin') {
      // Preventivatore via browser: la pagina e' pubblica ma inerte senza ADMIN_KEY
      const fp = path.join(__dirname, 'admin.html');
      if (!fs.existsSync(fp)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('admin.html non presente nel repository');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow' });
      return res.end(fs.readFileSync(fp));
    }

    if (req.url.startsWith('/assessment')) {
      cors(res);
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      const chiave = req.headers['x-assessment-key'];
      const isAdmin = ADMIN_KEY && chiave === ADMIN_KEY;
      // submit: basta la chiave pubblica dei form; lista e preventivi: SOLO chiave admin
      if (req.url === '/assessment/submit') {
        if (chiave !== ASSESS_KEY && !isAdmin) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
        }
      } else if (!isAdmin) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'admin key richiesta' }));
      }

      if (req.method === 'POST' && req.url === '/assessment/submit') {
        const payload = await leggiBody(req);
        const { data, sha } = await ghJsonGet(ASSESS_PATH);
        const record = { ...payload, ricevuto: new Date().toISOString() };
        const idx = data.findIndex(a => a.email === payload.email && a.fase === 1 &&
          (Date.now() - new Date(a.ricevuto).getTime()) < 2 * 3600 * 1000);
        if (payload.fase === 2 && idx >= 0) data[idx] = record; else data.push(record);
        await ghJsonSave(ASSESS_PATH, data, sha, `assessment fase ${payload.fase} ${payload.email || ''}`);
        inviaNotifica(record).then(ok => { if (ok) console.log('notifica inviata', record.email || ''); })
          .catch(e => console.error('notifica email fallita:', e.message));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, totale: data.length }));
      }

      if (req.method === 'GET' && req.url === '/assessment/list') {
        const { data } = await ghJsonGet(ASSESS_PATH);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(data));
      }

      if (req.method === 'POST' && req.url === '/assessment/preventivo') {
        const { email, note, perimetro } = await leggiBody(req);
        const { data } = await ghJsonGet(ASSESS_PATH);
        const records = data.filter(r2 => r2.email === email);
        if (!records.length) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'nessuna compilazione per questa email' }));
        }
        const preventivo = await generaPreventivo(records, note, perimetro);
        const { data: prevs, sha } = await ghJsonGet(PREV_PATH);
        prevs.push({ email, note: note || '', perimetro: perimetro || null, generato: new Date().toISOString(), preventivo });
        await ghJsonSave(PREV_PATH, prevs, sha, `preventivo ${email}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(preventivo));
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'not found' }));
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
  } catch (e) {
    console.error(req.method, req.url, e.message);
    cors(res);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
});

server.listen(PORT, () => console.log(`mentedopera-proxy in ascolto sulla porta ${PORT}`));
