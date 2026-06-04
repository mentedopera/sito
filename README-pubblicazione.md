# Sito Mente d'Opera — istruzioni di pubblicazione

## Contenuto
- `index.html` — homepage completa (one-page con ancore)
- `assessment.html` — questionario fase 1+2 col brand (invio al proxy)
- `questionario-tecnico.html` — fase 3 col brand (invio al proxy)
- `privacy.html`, `cookie.html` — segnaposto da sostituire con iubenda
- `logo/` — logo SVG (positivo, negativo, orizzontale, marchio-apostrofo/favicon)

## Prima di pubblicare
1. In `assessment.html` e `questionario-tecnico.html` imposta `API_KEY` (stessa
   `ASSESSMENT_KEY` configurata su Render) all'inizio dello `<script>`.
2. In `index.html` sostituisci telefono e P.IVA segnaposto.

## Pubblicazione su GitHub Pages (gratis)
1. Crea un repo nuovo, es. `mentedopera-sito` (account separato da Yespresso consigliato).
2. Carica TUTTI i file di questa cartella nella root del repo.
3. Settings → Pages → Source: `main` / root → Save. Il sito è su
   `https://<utente>.github.io/mentedopera-sito/`.
4. Sempre in Settings → Pages → Custom domain: scrivi `mentedopera.it` e salva
   (crea il file CNAME). Spunta "Enforce HTTPS" quando disponibile.

## DNS su IONOS (Area clienti → Domini → mentedopera.it → DNS)
Record per GitHub Pages:
- `A`     @    185.199.108.153
- `A`     @    185.199.109.153
- `A`     @    185.199.110.153
- `A`     @    185.199.111.153
- `CNAME` www  <utente>.github.io.

Il dominio .com: aggiungi un inoltro/redirect verso https://mentedopera.it
(IONOS → Domini → mentedopera.com → Reindirizzamento).

La propagazione DNS richiede da pochi minuti a qualche ora. HTTPS si attiva
automaticamente dopo la verifica del dominio.

## Alternativa: Cloudflare Pages
Stesso risultato, deploy collegando il repo; utile se in futuro vuoi
Cloudflare Access per l'area riservata (admin.mentedopera.it).
