// LaTeX in the browser (latex.js, BusyTeX): the model writes the sources as chat
// files and latex_compile turns them into a PDF in the library — Spanish babel
// fixed on its own (provide=*), BibTeX run automatically, errors reported with
// their line, and «Preguntar» asks before saving. Downloads TeX Live (~230 MB)
// the first time, so it is not part of run-ci.sh; run it by hand.
const { chromium } = require('playwright');
const { openApp, send, idle } = require('./mock.cjs');
const check = (label, ok, extra) => console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 600) : ''));

const MAIN = String.raw`\documentclass[11pt]{article}
\usepackage[T1]{fontenc}
\usepackage{lmodern}
\usepackage[spanish]{babel}
\usepackage{amsmath,amssymb}
\usepackage{booktabs}
\usepackage{tikz}
\title{Apuntes de cinemática}
\author{Inhouse Learn}
\begin{document}
\maketitle
\tableofcontents
\section{Tiro parabólico}\label{sec:tiro}
La altura máxima es $h=\dfrac{v_0^2\sin^2\theta}{2g}$, como explica \cite{tipler}.
\begin{center}\begin{tikzpicture}\draw[->] (0,0) -- (3,0); \draw[blue,thick] (0,0) parabola bend (1.5,1.2) (3,0);\end{tikzpicture}\end{center}
\begin{tabular}{lr}\toprule Magnitud & Valor\\\midrule $g$ & $9{,}8$\\\bottomrule\end{tabular}
Véase la sección~\ref{sec:tiro}.
\bibliographystyle{plain}
\bibliography{refs}
\end{document}
`;
const BIB = '@book{tipler, title={Física}, author={Tipler, Paul}, year={2010}, publisher={Reverté}}';
const BAD = '\\documentclass{article}\n\\begin{document}\nHola.\n\\comandoquenoexiste\n\\end{document}\n';

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const { page, errors } = await openApp(browser, { viewport: { width: 1100, height: 900 } });
  await page.evaluate(() => { getActiveChat().approvalMode = 'auto'; });

  // 1. Write the sources and compile: PDF in the library, card under the answer.
  await page.evaluate(({ main, bib }) => window.__replies.push(
    { text: '', tools: [{ name: 'write_file', args: { path: 'apuntes.tex', content: main } }, { name: 'write_file', args: { path: 'refs.bib', content: bib } }] },
    { text: '', tools: [{ name: 'latex_compile', args: { main: 'apuntes.tex' } }] },
    { text: 'Tus apuntes en PDF.' }), { main: MAIN, bib: BIB });
  const t0 = Date.now();
  await send(page, 'Hazme unos apuntes en LaTeX');
  await idle(page, 600000);
  const made = await page.evaluate(async () => {
    const chat = getActiveChat();
    const m = chat.messages.slice(-1)[0];
    const step = m.toolSteps.find((s) => s.name === 'latex_compile');
    const docs = await InhouseLibrary.list(chat.id);
    const pdf = docs.find((d) => d.path === 'apuntes.pdf');
    const text = pdf ? (await InhouseLibrary.read(chat.id, pdf.ref)).text : '';
    return { status: step && step.status, output: step && step.output, pdf: pdf && { ref: pdf.ref, pages: pdf.totalPages }, text: text.slice(0, 1500), card: (document.querySelector('#thread .message:last-child .msg-doc b') || {}).textContent };
  });
  check('latex_compile turns the chat\'s .tex into a PDF in the library, shown under the answer', made.status === 'done' && made.pdf && made.pdf.pages >= 1 && made.card === 'apuntes.pdf' && /PDF listo/.test(made.output), { made, seconds: Math.round((Date.now() - t0) / 1000) });
  check('…in Spanish (babel, T1 accents), with the table of contents and \\ref resolved', /Índice/.test(made.text) && /Tiro parabólico/.test(made.text) && /sección 1/.test(made.text), made.text.slice(0, 400));
  check('…and BibTeX ran: the citation and the bibliography are there', /\[1\]/.test(made.text) && /Tipler/.test(made.text) && /Referencias|Bibliografía/.test(made.text), made.text.slice(-500));

  // 2. Errors come back with their line so the model can fix them.
  await page.evaluate((bad) => window.__replies.push(
    { text: '', tools: [{ name: 'write_file', args: { path: 'malo.tex', content: bad } }, { name: 'latex_compile', args: { main: 'malo.tex' } }] },
    { text: 'Hay un error.' }), BAD);
  await send(page, 'Compila esto');
  await idle(page, 300000);
  const bad = await page.evaluate(() => { const step = getActiveChat().messages.slice(-1)[0].toolSteps.find((s) => s.name === 'latex_compile'); return { status: step.status, output: step.output }; });
  check('an error comes back with its line (malo.tex línea 4: Undefined control sequence)', bad.status === 'error' && /línea 4/.test(bad.output) && /Undefined control sequence/.test(bad.output) && /comandoquenoexiste/.test(bad.output), bad);

  // 3. XeLaTeX (fontspec, Unicode) works too.
  await page.evaluate(() => window.__replies.push(
    { text: '', tools: [{ name: 'write_file', args: { path: 'xe.tex', content: '\\documentclass{article}\n\\usepackage{fontspec}\n\\begin{document}\nUnicode directo: ñandú, α≈β.\n\\end{document}\n' } }, { name: 'latex_compile', args: { main: 'xe.tex', engine: 'xelatex' } }] },
    { text: 'Hecho con XeLaTeX.' }));
  await send(page, 'Ahora con xelatex');
  await idle(page, 300000);
  const xe = await page.evaluate(async () => { const step = getActiveChat().messages.slice(-1)[0].toolSteps.find((s) => s.name === 'latex_compile'); const docs = await InhouseLibrary.list(getActiveChat().id); return { status: step.status, output: step.output.slice(0, 300), pdf: docs.some((d) => d.path === 'xe.pdf') }; });
  check('xelatex with fontspec compiles too', xe.status === 'done' && xe.pdf, xe);

  // 4. «Preguntar»: saving the PDF asks first.
  await page.evaluate(() => { getActiveChat().approvalMode = 'ask'; window.__replies.push({ text: '', tools: [{ name: 'latex_compile', args: { main: 'xe.tex', engine: 'xelatex' } }] }, { text: 'Vale.' }); });
  await send(page, 'Compílalo otra vez');
  await page.waitForSelector('.dock-approve', { timeout: 120000 }).catch(() => null);
  const card = await page.evaluate(() => (document.querySelector('.dock-approve') || {}).innerText || '');
  if (card) await page.click('.dock-approve [data-dock="reject"]');
  await idle(page, 120000);
  check('in «Preguntar» saving the compiled PDF asks first', /xe\.pdf/.test(card), card);

  console.log('errors', JSON.stringify(errors.filter((e) => !/initScript/.test(e))));
  await browser.close();
})();
