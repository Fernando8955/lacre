// Lacre — cliente. Sem framework: são cinco telas e quatro chamadas de API.

const $ = (id) => document.getElementById(id);
const corpo = document.body;

let sessao = carregarSessao();
let visao = null;
let loteJaRevelado = 0;
let lance = 0;
let relogio = null;
let pesquisa = null;

function carregarSessao() {
  try {
    return JSON.parse(localStorage.getItem('lacre') || 'null');
  } catch {
    return null;
  }
}
function salvarSessao(s) {
  sessao = s;
  if (s) localStorage.setItem('lacre', JSON.stringify(s));
  else localStorage.removeItem('lacre');
}

function avisar(msg) {
  const el = $('aviso');
  if (!msg) { el.hidden = true; return; }
  el.textContent = msg;
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 4000);
}

async function api(caminho, opcoes) {
  const r = await fetch(caminho, opcoes);
  const dados = await r.json().catch(() => ({ erro: 'Resposta inválida' }));
  if (!r.ok) throw new Error(dados.erro || 'Deu problema na conexão');
  return dados;
}

function tempoTexto(s) {
  if (s === null || s === undefined) return '';
  if (s >= 3600) return Math.floor(s / 3600) + 'h' + String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return m + ':' + String(r).padStart(2, '0');
}

// --- Início ---------------------------------------------------------------

$('btn-criar').onclick = async () => {
  const banco = document.querySelector('input[name="banco"]:checked').value;
  try {
    const d = await api('/api/sala', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nome: $('nome').value, banco }),
    });
    salvarSessao({ codigo: d.codigo, token: d.token });
    $('codigo-sala').textContent = d.codigo;
    corpo.dataset.tela = 'espera';
    iniciarPesquisa();
  } catch (e) {
    avisar(e.message);
  }
};

$('btn-entrar').onclick = async () => {
  const codigo = $('codigo').value.trim().toUpperCase();
  if (codigo.length !== 4) return avisar('O código tem 4 letras.');
  try {
    const d = await api('/api/entrar', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ codigo, nome: $('nome').value }),
    });
    salvarSessao({ codigo: d.codigo, token: d.token });
    iniciarPesquisa();
  } catch (e) {
    avisar(e.message);
  }
};

$('btn-copiar').onclick = async () => {
  const texto = `Bora jogar Lacre? Código da sala: ${sessao.codigo}\n${location.origin}`;
  try {
    if (navigator.share) await navigator.share({ text: texto });
    else { await navigator.clipboard.writeText(texto); avisar('Convite copiado.'); }
  } catch { /* usuário cancelou */ }
};

$('btn-novo').onclick = () => {
  salvarSessao(null);
  pararPesquisa();
  visao = null;
  loteJaRevelado = 0;
  corpo.dataset.tela = 'inicio';
};

// --- Lance ----------------------------------------------------------------

function mostrarLance(v) {
  lance = Math.max(0, Math.min(lance, v));
  $('lance-valor').textContent = lance;
  $('lance-slider').value = lance;
}

$('lance-slider').oninput = function () {
  lance = Number(this.value);
  $('lance-valor').textContent = lance;
};

document.querySelectorAll('.ajustes button').forEach((b) => {
  b.onclick = () => {
    const p = b.dataset.passo;
    const max = visao ? visao.eu.fichas : 0;
    lance = p === 'tudo' ? max : lance + Number(p);
    mostrarLance(max);
  };
});

$('btn-lacrar').onclick = async () => {
  if (!sessao) return;
  $('btn-lacrar').disabled = true;
  try {
    const d = await api('/api/lance', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ codigo: sessao.codigo, token: sessao.token, valor: lance }),
    });
    lance = 0;
    aplicar(d);
  } catch (e) {
    avisar(e.message);
  } finally {
    $('btn-lacrar').disabled = false;
  }
};

$('btn-seguir').onclick = () => {
  loteJaRevelado = visao.ultimoLote ? visao.ultimoLote.lote : loteJaRevelado;
  desenhar();
};

// --- Estado ---------------------------------------------------------------

function iniciarPesquisa() {
  pararPesquisa();
  buscar();
  pesquisa = setInterval(buscar, 3000);
}
function pararPesquisa() {
  if (pesquisa) clearInterval(pesquisa);
  pesquisa = null;
}

async function buscar() {
  if (!sessao) return;
  try {
    const d = await api(
      `/api/estado?codigo=${encodeURIComponent(sessao.codigo)}&token=${encodeURIComponent(sessao.token)}`
    );
    aplicar(d);
  } catch (e) {
    if (String(e.message).includes('não está') || String(e.message).includes('encontrada')) {
      salvarSessao(null);
      pararPesquisa();
      corpo.dataset.tela = 'inicio';
    }
  }
}

function aplicar(d) {
  visao = d;
  if (d.fase === 'fim') pararPesquisa();
  desenhar();
}

function listaHistorico(el, h) {
  if (!h.length) { el.innerHTML = ''; return; }
  const itens = h
    .map((l) => {
      const cls = l.meu > l.dele ? 'venci' : l.meu < l.dele ? 'perdi' : '';
      return `<li class="${cls}"><span class="rotulo">Lote ${l.lote}</span><span>${l.meu} — <b>${l.dele}</b></span></li>`;
    })
    .join('');
  el.innerHTML = `<h2>Lotes revelados</h2><ul>${itens}</ul>`;
}

function desenhar() {
  if (!visao) return;
  const v = visao;

  if (v.fase === 'aguardando') {
    $('codigo-sala').textContent = v.codigo;
    corpo.dataset.tela = 'espera';
    return;
  }

  if (v.fase === 'fim') {
    const r = v.resultado || {};
    const t = $('fim-titulo');
    t.className = 'veredito grande ' + (r.empate ? '' : r.venci ? 'ganhei' : 'perdi');
    t.textContent = r.empate ? 'Empate' : r.venci ? 'Você venceu' : 'Você perdeu';
    const motivos = {
      lotes: 'Decidido nos lotes.',
      fichas: 'Empate nos lotes — decidiu quem guardou mais fichas.',
      tempo: 'Alguém estourou o banco de tempo.',
      empate: 'Mesmos lotes, mesmas fichas.',
    };
    $('fim-motivo').textContent = motivos[r.motivo] || '';
    $('fim-meus-lotes').textContent = v.eu.lotes;
    $('fim-minhas-fichas').textContent = v.eu.fichas;
    listaHistorico($('historico-fim'), v.historico);
    corpo.dataset.tela = 'fim';
    return;
  }

  // Revelação pendente de um lote que ainda não mostramos.
  if (v.ultimoLote && v.ultimoLote.lote > loteJaRevelado) {
    const u = v.ultimoLote;
    $('rev-lote').textContent = 'Lote ' + u.lote;
    const ve = $('rev-veredito');
    if (u.meu > u.dele) { ve.className = 'veredito ganhei'; ve.textContent = 'Você levou o lote'; }
    else if (u.meu < u.dele) { ve.className = 'veredito perdi'; ve.textContent = (v.ele ? v.ele.nome : 'Ele') + ' levou o lote'; }
    else { ve.className = 'veredito'; ve.textContent = 'Lance igual — ninguém leva'; }
    $('rev-meu').textContent = u.meu;
    $('rev-dele').textContent = u.dele;
    $('rev-nome-dele').textContent = v.ele ? v.ele.nome : 'Ele';
    corpo.dataset.tela = 'revelacao';
    return;
  }

  // Mesa.
  $('lote-num').textContent = v.lote;
  $('lado-eu').innerHTML = lado(v.eu, 'Você');
  $('lado-ele').innerHTML = v.ele ? lado(v.ele, v.ele.nome) : '';
  $('lado-ele').className = 'lado' + (v.ele && v.ele.lacrou ? '' : '');

  if (v.eu.lacrou) {
    $('painel-lance').hidden = true;
    $('painel-lacrado').hidden = false;
    $('lacrado-quem').textContent = 'Esperando ' + (v.ele ? v.ele.nome : 'o outro jogador') + '.';
  } else {
    $('painel-lance').hidden = false;
    $('painel-lacrado').hidden = true;
    $('lance-slider').max = Math.max(v.eu.fichas, 1);
    mostrarLance(v.eu.fichas);
  }

  listaHistorico($('historico'), v.historico);
  corpo.dataset.tela = 'mesa';
  tocarRelogio();
}

function lado(j, nome) {
  return (
    `<div class="quem">${nome}</div>` +
    `<div class="fichas">${j.fichas}</div>` +
    `<div class="abaixo"><b>${j.lotes}</b> lote${j.lotes === 1 ? '' : 's'} · <span data-relogio>${tempoTexto(j.tempo)}</span></div>`
  );
}

// Conta o tempo localmente entre uma leitura e outra do servidor.
function tocarRelogio() {
  if (relogio) clearInterval(relogio);
  relogio = setInterval(() => {
    if (!visao || visao.fase !== 'jogando') return;
    if (!visao.eu.lacrou && visao.eu.tempo > 0) visao.eu.tempo--;
    if (visao.ele && !visao.ele.lacrou && visao.ele.tempo > 0) visao.ele.tempo--;
    const els = document.querySelectorAll('[data-relogio]');
    if (els[0]) els[0].textContent = tempoTexto(visao.eu.tempo);
    if (els[1] && visao.ele) els[1].textContent = tempoTexto(visao.ele.tempo);
  }, 1000);
}

// Retoma a partida se a pessoa fechou e voltou.
if (sessao) iniciarPesquisa();
