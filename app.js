// Lacre — cliente da temporada.
// A pessoa tem várias partidas abertas ao mesmo tempo. O painel é a casa;
// a mesa é onde se dá o lance. Nada aqui decide regra: o servidor decide.

const $ = (id) => document.getElementById(id);
const corpo = document.body;

let token = localStorage.getItem('lacre_token') || '';
let meuNome = localStorage.getItem('lacre_nome') || '';
let partidaId = null;
let vistaPartida = null;
let loteJaRevelado = 0;
let lance = 0;
let pesquisa = null;
let relogio = null;

function avisar(msg) {
  const el = $('aviso');
  if (!msg) { el.hidden = true; return; }
  el.textContent = msg;
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 4000);
}

async function api(caminho, opcoes) {
  const r = await fetch(caminho, opcoes);
  const d = await r.json().catch(() => ({ erro: 'Resposta inválida do servidor' }));
  if (!r.ok) throw new Error(d.erro || 'Deu problema na conexão');
  return d;
}


// Avatar sem upload e sem moderação: iniciais do nome, com uma cor que é
// sempre a mesma para o mesmo apelido. Dá cara ao adversário de graça.
function iniciais(nome) {
  const p = String(nome || '?').trim().split(/\s+/);
  const a = (p[0] || '?')[0] || '?';
  const b = p.length > 1 ? (p[p.length - 1][0] || '') : (p[0] || '')[1] || '';
  return (a + b).toUpperCase();
}
function corDoNome(nome) {
  let n = 0;
  const s = String(nome || '');
  for (let i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) % 360;
  return n;
}
function avatarHtml(nome, tamanho) {
  const h = corDoNome(nome);
  const cls = tamanho === 'p' ? 'avatar p' : 'avatar';
  return (
    '<span class="' + cls + '" style="background:hsl(' + h + ',42%,32%)">' +
    iniciais(nome) + '</span>'
  );
}

function tempoTexto(s) {
  if (s === null || s === undefined) return '';
  if (s <= 0) return 'acabou';
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h + 'h' + String(m).padStart(2, '0');
  }
  // Abaixo de 15 minutos os segundos passam a aparecer: é quando importa.
  if (s < 900) {
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m + ':' + String(r).padStart(2, '0');
  }
  return Math.floor(s / 60) + ' min';
}

// --- Entrada ---------------------------------------------------------------

$('btn-entrar').onclick = async () => {
  const nome = $('nome').value.trim();
  if (!nome) return avisar('Escreva um nome para aparecer no ranking.');
  try {
    const d = await api('/api/entrar', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nome, token }),
    });
    token = d.token;
    meuNome = d.nome;
    localStorage.setItem('lacre_token', token);
    localStorage.setItem('lacre_nome', meuNome);
    irParaPainel();
  } catch (e) {
    avisar(e.message);
  }
};

$('btn-sair').onclick = () => {
  pararPesquisa();
  prazosLocais = [];
  atualizarTitulo();
  localStorage.removeItem('lacre_token');
  token = '';
  partidaId = null;
  corpo.dataset.tela = 'inicio';
};

// --- Painel ----------------------------------------------------------------

function irParaPainel() {
  partidaId = null;
  vistaPartida = null;
  loteJaRevelado = 0;
  corpo.dataset.tela = 'painel';
  iniciarPesquisa(carregarPainel, 8000);
}

$('btn-voltar').onclick = irParaPainel;
$('btn-painel').onclick = irParaPainel;

$('btn-nova').onclick = async () => {
  $('btn-nova').disabled = true;
  try {
    const d = await api('/api/nova', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (d.pareado) abrirPartida(d.id);
    else { avisar('Você entrou na fila. Assim que alguém aparecer, a partida começa.'); await carregarPainel(); }
  } catch (e) {
    avisar(e.message);
  } finally {
    $('btn-nova').disabled = false;
  }
};

$('btn-outra').onclick = async () => {
  $('btn-outra').disabled = true;
  try {
    const d = await api('/api/nova', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (d.pareado) abrirPartida(d.id);
    else { avisar('Você entrou na fila. Assim que alguém aparecer, a partida começa.'); irParaPainel(); }
  } catch (e) {
    avisar(e.message);
  } finally {
    $('btn-outra').disabled = false;
  }
};

async function carregarPainel() {
  if (!token) return;
  let p;
  try {
    p = await api('/api/painel?token=' + encodeURIComponent(token));
  } catch (e) {
    if (String(e.message).includes('não encontrado')) {
      localStorage.removeItem('lacre_token');
      token = '';
      pararPesquisa();
      corpo.dataset.tela = 'inicio';
    }
    return;
  }

  $('painel-nome').textContent = p.nome;
  $('painel-tempo').textContent = 'A temporada de hoje acaba em ' + tempoTexto(p.terminaEm);

  const feitas = Math.min(p.eu.partidas, p.meta);
  $('meta-feitas').textContent = p.eu.partidas;
  $('meta-total').textContent = '/ ' + p.meta;
  $('meta-barra').style.width = Math.round((feitas / p.meta) * 100) + '%';
  $('meta-pontos').textContent =
    p.eu.pontos + (p.eu.pontos === 1 ? ' ponto' : ' pontos') + ' · ' + p.eu.vitorias + ' vitórias';
  $('meta-posicao').textContent = p.eu.posicao ? p.eu.posicao + 'º lugar' : 'sem posição ainda';

  desenharOntem(p.ontem);
  desenharPartidas(p.partidas);
  desenharRanking(p.ranking);
}

// O prazo desce na tela segundo a segundo. O servidor continua sendo a
// verdade — isto é só para a pessoa sentir o tempo correndo.
let prazosLocais = [];
let tiquetaque = null;

function nivelUrgencia(s) {
  if (s === null || s === undefined) return 'calmo';
  if (s <= 300) return 'critico';
  if (s <= 900) return 'atencao';
  return 'calmo';
}

function iniciarTiquetaque() {
  if (tiquetaque) return;
  tiquetaque = setInterval(() => {
    let mudouNivel = false;
    for (const p of prazosLocais) {
      const antes = nivelUrgencia(p.prazo);
      p.prazo = Math.max(0, p.prazo - 1);
      if (nivelUrgencia(p.prazo) !== antes) mudouNivel = true;
      const el = document.querySelector('[data-prazo="' + p.id + '"]');
      if (el) el.textContent = p.rotulo + tempoTexto(p.prazo);
    }
    // Quando um cartão muda de faixa, redesenha para trocar a cor.
    if (mudouNivel && corpo.dataset.tela === 'painel') carregarPainel();
    atualizarTitulo();
  }, 1000);
}

// Quem deixa a aba aberta em segundo plano vê o aviso sem voltar ao site.
function atualizarTitulo() {
  const n = prazosLocais.filter((p) => p.suaVez).length;
  document.title = n ? '(' + n + ') Lacre — sua vez' : 'Lacre — leilão às cegas';
}

function desenharPartidas(lista) {
  const el = $('lista-partidas');
  // Mais apertadas primeiro: a que está prestes a estourar não pode ficar
  // escondida no fim da lista.
  const ordenada = lista.slice().sort((a, b) => {
    if (a.suaVez !== b.suaVez) return a.suaVez ? -1 : 1;
    if (a.fase === 'aguardando') return 1;
    if (b.fase === 'aguardando') return -1;
    return a.prazo - b.prazo;
  });

  prazosLocais = ordenada
    .filter((p) => p.fase !== 'aguardando')
    .map((p) => ({
      id: p.id,
      prazo: p.prazo,
      suaVez: p.suaVez,
      rotulo: p.suaVez ? 'Sua vez · ' : 'Ele tem ',
    }));
  iniciarTiquetaque();
  atualizarTitulo();

  if (!ordenada.length) {
    el.innerHTML =
      '<div class="bloco"><h2>Suas partidas</h2><div class="papel centro"><p class="apoio">Nenhuma partida aberta. Toque em <b>Nova partida</b> para começar.</p></div></div>';
    return;
  }

  const suaVez = ordenada.filter((p) => p.suaVez).length;
  let h = '<div class="bloco"><h2>Suas partidas</h2>';
  if (suaVez) h += '<div class="chamada">' + suaVez + ' esperando o seu lance</div>';
  h += '<div class="cartoes">';
  for (const p of ordenada) {
    const esperando = p.fase === 'aguardando';
    const nivel = esperando ? '' : ' ' + nivelUrgencia(p.prazo);
    const cls = esperando ? 'cartao aguardando' : (p.suaVez ? 'cartao vez' : 'cartao') + nivel;
    const quem = esperando
      ? '<span class="cartao-nome">Procurando adversário…</span>'
      : avatarHtml(p.adversario, 'p') + '<span class="cartao-nome">' + p.adversario + '</span>';
    const serie = p.confronto && (p.confronto.v || p.confronto.d || p.confronto.e)
      ? ' · <b class="serie">' + p.confronto.v + '—' + p.confronto.d + ' hoje</b>'
      : '';
    const detalhe = esperando
      ? 'Você entra na partida assim que alguém aparecer'
      : 'Lote ' + p.lote + ' · ' + p.meusLotes + ' — ' + p.lotesDele + ' · ' + p.fichas + ' fichas' + serie;
    const rotulo = p.suaVez ? 'Sua vez · ' : 'Ele tem ';
    const acao = esperando
      ? ''
      : '<div class="' + (p.suaVez ? 'cartao-acao' : 'cartao-espera') + '" data-prazo="' + p.id + '">' +
        rotulo + tempoTexto(p.prazo) + '</div>';
    h +=
      '<button class="' + cls + '" data-partida="' + p.id + '"' + (esperando ? ' disabled' : '') + '>' +
      '<div class="cartao-txt"><div class="cartao-topo">' + quem + '</div>' +
      '<div class="cartao-sub">' + detalhe + '</div></div>' + acao + '</button>';
  }
  el.innerHTML = h + '</div></div>';
  el.querySelectorAll('[data-partida]').forEach((b) => {
    b.onclick = () => abrirPartida(b.dataset.partida);
  });
}

// Fecho da temporada anterior. Some depois que a pessoa dispensa, para não
// competir com o dia de hoje.
function desenharOntem(o) {
  const el = $('fecho-ontem');
  if (!o || localStorage.getItem('lacre_viu_ontem') === o.dia) {
    el.innerHTML = '';
    return;
  }
  const medalhas = ['1º', '2º', '3º'];
  let h = '<div class="papel ontem"><div class="ontem-topo">' +
    '<span class="sobrescrito">Como terminou ontem</span>' +
    '<button class="fechar" id="btn-fecha-ontem" aria-label="Fechar">×</button></div>';

  h += '<div class="podio">';
  for (const p of o.podio) {
    h += '<div class="podio-linha' + (p.sou ? ' sou' : '') + '">' +
      '<span class="podio-pos">' + medalhas[p.posicao - 1] + '</span>' +
      avatarHtml(p.nome, 'p') +
      '<span class="podio-nome">' + p.nome + '</span>' +
      '<span class="podio-pts">' + p.pontos + '</span></div>';
  }
  h += '</div>';

  if (o.minhaPosicao) {
    const campeao = o.podio[0] && o.podio[0].sou;
    h += '<p class="apoio ontem-eu">' +
      (campeao
        ? 'Você foi o campeão de ontem, com ' + o.meusPontos + ' pontos em ' + o.minhasPartidas + ' partidas.'
        : 'Você terminou em ' + o.minhaPosicao + 'º de ' + o.total + ', com ' + o.meusPontos + ' pontos em ' + o.minhasPartidas + ' partidas.') +
      '</p>';
  } else {
    h += '<p class="apoio ontem-eu">Você não pontuou ontem. Hoje o placar está zerado para todo mundo.</p>';
  }

  el.innerHTML = h + '</div>';
  const b = $('btn-fecha-ontem');
  if (b) b.onclick = () => {
    localStorage.setItem('lacre_viu_ontem', o.dia);
    el.innerHTML = '';
  };
}

let posicaoAnterior = null;

function desenharRanking(lista) {
  const el = $('tabela-ranking');
  if (!lista.length) {
    el.innerHTML = '<p class="apoio">Ninguém pontuou ainda hoje. Seja o primeiro.</p>';
    return;
  }
  const eu = lista.find((r) => r.sou);
  // Subir no ranking é a informação mais motivadora do produto. Ela não pode
  // acontecer em silêncio.
  let subiu = null;
  if (eu && posicaoAnterior !== null && eu.posicao < posicaoAnterior) {
    const passou = lista.find((r) => r.posicao === eu.posicao + 1);
    subiu = passou ? 'Você passou ' + passou.nome + ' — agora é ' + eu.posicao + 'º' : 'Você subiu para ' + eu.posicao + 'º';
  }
  if (eu) posicaoAnterior = eu.posicao;

  let h = subiu ? '<div class="subiu">' + subiu + '</div>' : '';
  h += '<table class="rank"><tbody>';
  for (const r of lista) {
    h +=
      '<tr' + (r.sou ? ' class="sou"' : '') + '><td class="pos">' + r.posicao + '</td>' +
      '<td class="ava">' + avatarHtml(r.nome, 'p') + '</td>' +
      '<td class="nome">' + r.nome + '</td>' +
      '<td class="jogos">' + r.partidas + 'j</td>' +
      '<td class="pts">' + r.pontos + '</td></tr>';
  }
  el.innerHTML = h + '</tbody></table>';
}

// --- Mesa ------------------------------------------------------------------

function abrirPartida(id) {
  partidaId = id;
  loteJaRevelado = 0;
  lance = 0;
  iniciarPesquisa(carregarPartida, 4000);
}

async function carregarPartida() {
  if (!partidaId) return;
  try {
    const v = await api(
      '/api/partida?id=' + encodeURIComponent(partidaId) + '&token=' + encodeURIComponent(token)
    );
    vistaPartida = v;
    desenharPartida();
  } catch (e) {
    avisar(e.message);
    irParaPainel();
  }
}

function mostrarLance(max) {
  lance = Math.max(0, Math.min(lance, max));
  $('lance-valor').textContent = lance;
  $('lance-slider').value = lance;
}

$('lance-slider').oninput = function () {
  lance = Number(this.value);
  $('lance-valor').textContent = lance;
};

document.querySelectorAll('.ajustes button').forEach((b) => {
  b.onclick = () => {
    const max = vistaPartida ? vistaPartida.eu.fichas : 0;
    const p = b.dataset.passo;
    lance = p === 'tudo' ? max : lance + Number(p);
    mostrarLance(max);
  };
});

$('btn-lacrar').onclick = async () => {
  if (!partidaId) return;
  $('btn-lacrar').disabled = true;
  try {
    const v = await api('/api/lance', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: partidaId, token, valor: lance }),
    });
    lance = 0;
    vistaPartida = v;
    desenharPartida();
  } catch (e) {
    avisar(e.message);
  } finally {
    $('btn-lacrar').disabled = false;
  }
};

$('btn-seguir').onclick = () => {
  if (vistaPartida && vistaPartida.ultimoLote) loteJaRevelado = vistaPartida.ultimoLote.lote;
  desenharPartida();
};

$('btn-outras').onclick = irParaPainel;

// Reinicia a animação a cada lote: sem isso ela só rodaria na primeira vez.
function abrirEnvelopes() {
  const palco = $('rev-palco');
  const tela = document.querySelector('.tela[data-para="revelacao"]');
  palco.classList.remove('abrir');
  tela.classList.remove('revelou');
  void palco.offsetWidth;
  palco.classList.add('abrir');
  tela.classList.add('revelou');
}

function listaHistorico(el, h) {
  if (!h || !h.length) { el.innerHTML = ''; return; }
  let s = '<h2>Lotes revelados</h2><ul>';
  for (const l of h) {
    const cls = l.meu > l.dele ? 'venci' : l.meu < l.dele ? 'perdi' : '';
    s += '<li class="' + cls + '"><span class="rotulo">Lote ' + l.lote + '</span><span>' + l.meu + ' — <b>' + l.dele + '</b></span></li>';
  }
  el.innerHTML = s + '</ul>';
}

function ladoHtml(j, nome) {
  return (
    '<div class="quem">' + avatarHtml(nome, 'p') + '<span>' + nome + '</span></div>' +
    '<div class="fichas">' + j.fichas + '</div>' +
    '<div class="abaixo"><b>' + j.lotes + '</b> lote' + (j.lotes === 1 ? '' : 's') + '</div>'
  );
}

function desenharPartida() {
  const v = vistaPartida;
  if (!v) return;

  if (v.fase === 'fim') {
    const r = v.resultado || {};
    const t = $('fim-titulo');
    t.className = 'veredito grande ' + (r.empate ? '' : r.venci ? 'ganhei' : 'perdi');
    t.textContent = r.empate ? 'Empate' : r.venci ? 'Você venceu' : 'Você perdeu';
    const motivos = {
      lotes: 'Decidido nos lotes.',
      fichas: 'Empate nos lotes — decidiu quem guardou mais fichas.',
      abandono: 'A partida acabou por prazo estourado.',
      empate: 'Mesmos lotes, mesmas fichas.',
      'sem-adversario': 'Ninguém entrou nessa partida.',
    };
    $('fim-motivo').textContent = motivos[r.motivo] || '';
    if (r.licao) {
      $('fim-licao').textContent = r.licao;
      $('fim-licao').hidden = false;
    } else {
      $('fim-licao').hidden = true;
    }
    $('fim-meus-lotes').textContent = v.eu.lotes;
    $('fim-minhas-fichas').textContent = v.eu.fichas;
    listaHistorico($('historico-fim'), v.historico);
    corpo.dataset.tela = 'fim';
    pararPesquisa();
    prazosLocais = [];
    atualizarTitulo();
    return;
  }

  if (v.ultimoLote && v.ultimoLote.lote > loteJaRevelado) {
    const u = v.ultimoLote;
    $('rev-lote').textContent = 'Lote ' + u.lote;
    const ve = $('rev-veredito');
    if (u.meu > u.dele) { ve.className = 'veredito surge ganhei'; ve.textContent = 'Você levou o lote'; }
    else if (u.meu < u.dele) { ve.className = 'veredito surge perdi'; ve.textContent = (v.ele ? v.ele.nome : 'Ele') + ' levou o lote'; }
    else { ve.className = 'veredito surge'; ve.textContent = 'Lance igual — ninguém leva'; }
    $('rev-meu').textContent = u.meu;
    $('rev-dele').textContent = u.dele;
    $('rev-nome-dele').textContent = v.ele ? v.ele.nome : 'Ele';
    $('rev-env-meu').classList.toggle('venceu', u.meu > u.dele);
    $('rev-env-dele').classList.toggle('venceu', u.dele > u.meu);
    corpo.dataset.tela = 'revelacao';
    abrirEnvelopes();
    return;
  }

  $('lote-num').textContent = v.lote;
  $('lado-eu').innerHTML = ladoHtml(v.eu, 'Você');
  $('lado-ele').innerHTML = v.ele ? ladoHtml(v.ele, v.ele.nome) : '';
  const rotuloMesa = v.eu.lacrou ? 'Ele tem ' : 'Você tem ';
  const alvo = $('mesa-prazo');
  alvo.textContent = rotuloMesa + tempoTexto(v.prazo);
  alvo.className = 'sub prazo ' + nivelUrgencia(v.prazo);
  // O mesmo tique-taque do painel cuida do relógio da mesa.
  prazosLocais = [{ id: 'mesa', prazo: v.prazo, suaVez: !v.eu.lacrou, rotulo: rotuloMesa }];
  alvo.setAttribute('data-prazo', 'mesa');
  iniciarTiquetaque();
  atualizarTitulo();

  if (v.eu.lacrou) {
    $('painel-lance').hidden = true;
    $('painel-lacrado').hidden = false;
    $('lacrado-quem').textContent = 'Esperando ' + (v.ele ? v.ele.nome : 'o adversário') + '.';
  } else {
    $('painel-lance').hidden = false;
    $('painel-lacrado').hidden = true;
    $('lance-slider').max = Math.max(v.eu.fichas, 1);
    mostrarLance(v.eu.fichas);
    const novato = !localStorage.getItem('lacre_jogou');
    $('dica-primeira').hidden = !(novato && v.lote === 1);
    if (v.lote > 1) localStorage.setItem('lacre_jogou', '1');
  }

  listaHistorico($('historico'), v.historico);
  corpo.dataset.tela = 'mesa';
}

// --- Consulta periódica ----------------------------------------------------

function iniciarPesquisa(fn, ms) {
  pararPesquisa();
  fn();
  pesquisa = setInterval(fn, ms);
}
function pararPesquisa() {
  if (pesquisa) clearInterval(pesquisa);
  pesquisa = null;
}

// --- Demonstração ----------------------------------------------------------

const ROTEIRO = [
  { topo: 'Lote 1 de 5', a: '?', b: '?', ganhou: null, texto: 'Cada um tem 100 fichas para os 5 lotes. Os lances são secretos.', ms: 2200 },
  { topo: 'Lote 1 de 5', a: '27', b: '19', ganhou: 'a', texto: 'Maior lance leva o lote. <b>Mas os dois pagam.</b>', ms: 2600 },
  { topo: 'Fichas restantes', a: '73', b: '81', ganhou: null, texto: 'Você levou o lote, e mesmo assim gastou mais que ele.', ms: 2400 },
  { topo: 'Lote 2 de 5', a: '0', b: '12', ganhou: 'b', texto: 'Dar <b>0</b> é jogada: entrega o lote e guarda fichas.', ms: 2600 },
  { topo: 'Placar', a: '1', b: '1', ganhou: null, texto: 'Quem levar <b>3 lotes</b> vence a partida.', ms: 2200 },
];

function montarDemo(caixa) {
  const topo = caixa.querySelector('[data-demo-topo]');
  const a = caixa.querySelector('[data-demo-a]');
  const b = caixa.querySelector('[data-demo-b]');
  const legenda = caixa.querySelector('[data-demo-legenda]');
  let i = 0;
  function passo() {
    const q = ROTEIRO[i];
    topo.textContent = q.topo;
    a.querySelector('b').textContent = q.a;
    b.querySelector('b').textContent = q.b;
    a.classList.toggle('ganhou', q.ganhou === 'a');
    b.classList.toggle('ganhou', q.ganhou === 'b');
    legenda.innerHTML = q.texto;
    i = (i + 1) % ROTEIRO.length;
    setTimeout(passo, q.ms);
  }
  passo();
}
document.querySelectorAll('[data-demo]').forEach((el) => montarDemo(el));

// --- Partida ---------------------------------------------------------------

if (meuNome) $('nome').value = meuNome;
if (token) irParaPainel();
