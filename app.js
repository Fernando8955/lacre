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

// O apelido fica guardado à parte da sessão: é o que faz a pessoa não
// precisar se apresentar de novo a cada partida, sem exigir cadastro.
function lembrarNome(n) {
  const limpo = String(n || '').trim();
  if (limpo) localStorage.setItem('lacre_nome', limpo);
  return limpo;
}
function nomeSalvo() {
  try {
    return localStorage.getItem('lacre_nome') || '';
  } catch {
    return '';
  }
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
      body: JSON.stringify({ nome: lembrarNome($('nome').value), banco }),
    });
    salvarSessao({ codigo: d.codigo, token: d.token });
    $('codigo-sala').textContent = d.codigo;
    corpo.dataset.tela = 'espera';
    iniciarPesquisa();
  } catch (e) {
    avisar(e.message);
  }
};

let modoConvite = 'sala';

async function entrarNaFila(nome) {
  const d = await api('/api/fila', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nome: lembrarNome(nome), banco: 'rapido' }),
  });
  salvarSessao({ codigo: d.codigo, token: d.token, fila: true });
  history.replaceState(null, '', location.pathname);
  iniciarPesquisa();
}

$('btn-fila').onclick = async () => {
  try {
    await entrarNaFila($('nome').value);
  } catch (e) {
    avisar(e.message);
  }
};

async function entrarNaSala(codigo, nome) {
  const d = await api('/api/entrar', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ codigo, nome: lembrarNome(nome) }),
  });
  salvarSessao({ codigo: d.codigo, token: d.token });
  // Tira o ?sala= da barra de endereço para o refresh não voltar ao convite.
  history.replaceState(null, '', location.pathname);
  iniciarPesquisa();
}

$('btn-entrar').onclick = async () => {
  const codigo = $('codigo').value.trim().toUpperCase();
  if (codigo.length !== 4) return avisar('O código tem 4 letras.');
  try {
    await entrarNaSala(codigo, $('nome').value);
  } catch (e) {
    avisar(e.message);
  }
};

$('btn-convite-entrar').onclick = async () => {
  try {
    if (modoConvite === 'fila') {
      await entrarNaFila($('convite-nome').value);
    } else {
      const codigo = $('convite-codigo').textContent.trim().toUpperCase();
      await entrarNaSala(codigo, $('convite-nome').value);
    }
  } catch (e) {
    avisar(e.message);
  }
};

$('btn-copiar').onclick = async () => {
  // Numa sala privada o link leva à sala. Na fila, o link é aberto:
  // pode ser jogado no grupo e serve para todo mundo.
  const link = sessao.fila
    ? `${location.origin}/?jogar=1`
    : `${location.origin}/?sala=${sessao.codigo}`;
  const texto = sessao.fila
    ? `Partida de Lacre valendo. Clica e entra na fila — leva 2 minutos:\n${link}`
    : `Te chamei pra uma partida de Lacre. É rápido, cinco lotes:\n${link}`;
  try {
    if (navigator.share) await navigator.share({ text: texto });
    else { await navigator.clipboard.writeText(texto); avisar('Convite copiado.'); }
  } catch { /* usuário cancelou */ }
};

// Sair da sala de espera. Precisa limpar a sessão salva, senão o app
// devolve a pessoa para a mesma sala travada quando ela voltar.
$('btn-cancelar').onclick = () => {
  salvarSessao(null);
  pararPesquisa();
  visao = null;
  loteJaRevelado = 0;
  corpo.dataset.tela = 'inicio';
};

$('btn-revanche').onclick = async () => {
  if (!sessao) return;
  $('btn-revanche').disabled = true;
  try {
    const d = await api('/api/revanche', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ codigo: sessao.codigo, token: sessao.token }),
    });
    loteJaRevelado = 0;
    salvarSessao({ codigo: d.codigo, token: d.token, fila: false });
    iniciarPesquisa();
  } catch (e) {
    avisar(e.message);
  } finally {
    $('btn-revanche').disabled = false;
  }
};

// Notificação pobre e eficaz: abre o WhatsApp com a mensagem pronta.
// Funciona em qualquer aparelho e não depende de permissão de push.
$('btn-cutucar').onclick = () => {
  if (!sessao) return;
  const link = `${location.origin}/?sala=${sessao.codigo}`;
  const texto = `Já lacrei meu lance no Lacre. É a sua vez:\n${link}`;
  window.open('https://api.whatsapp.com/send?text=' + encodeURIComponent(texto), '_blank');
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
  desenhar();
}

// Reinicia a animação a cada lote: sem isso ela só rodaria na primeira vez.
function abrirEnvelopes() {
  const palco = $('rev-palco');
  const tela = document.querySelector('.tela[data-para="revelacao"]');
  palco.classList.remove('abrir');
  tela.classList.remove('revelou');
  void palco.offsetWidth; // força o navegador a reprocessar antes de reanimar
  palco.classList.add('abrir');
  tela.classList.add('revelou');
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
    const naFila = sessao && sessao.fila;
    $('codigo-sala').textContent = v.codigo;
    $('codigo-sala').hidden = !!naFila;
    $('espera-titulo').textContent = naFila ? 'Na fila' : 'Sala criada';
    $('espera-instrucao').textContent = naFila
      ? 'Chame mais gente: o link serve para todo mundo do grupo.'
      : 'Mande esse código para quem vai jogar com você.';
    $('espera-status').textContent = naFila
      ? 'Procurando adversário…'
      : 'Esperando o segundo jogador…';
    $('btn-cancelar').textContent = naFila ? 'Sair da fila' : 'Cancelar sala';
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
    const chamou = !!v.revanche;
    $('revanche-aviso').hidden = !chamou;
    if (chamou) {
      $('revanche-aviso').textContent =
        (v.ele ? v.ele.nome : 'Seu adversário') + ' quer jogar de novo.';
      $('btn-revanche').textContent = 'Aceitar revanche';
    } else {
      $('btn-revanche').textContent = 'Jogar de novo';
    }
    listaHistorico($('historico-fim'), v.historico);
    corpo.dataset.tela = 'fim';
    return;
  }

  // Revelação pendente de um lote que ainda não mostramos.
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

  // Mesa.
  $('lote-num').textContent = v.lote;
  $('lado-eu').innerHTML = lado(v.eu, 'Você', true);
  $('lado-ele').innerHTML = v.ele ? lado(v.ele, v.ele.nome, false) : '';
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
    // A dica aparece uma vez só, no lote 1 da primeira partida da pessoa.
    const novato = !localStorage.getItem('lacre_jogou');
    $('dica-primeira').hidden = !(novato && v.lote === 1);
    if (v.lote > 1) localStorage.setItem('lacre_jogou', '1');
  }

  listaHistorico($('historico'), v.historico);
  corpo.dataset.tela = 'mesa';
  tocarRelogio();
}

function presenca(j) {
  if (j.online === undefined) return '';
  if (j.online) return '<span class="ponto on"></span>online';
  if (j.vistoHa === null) return '';
  if (j.vistoHa < 3600) return '<span class="ponto"></span>há ' + Math.max(1, Math.floor(j.vistoHa / 60)) + ' min';
  return '<span class="ponto"></span>há ' + Math.floor(j.vistoHa / 3600) + 'h';
}

function lado(j, nome, eu) {
  return (
    `<div class="quem">${nome}</div>` +
    `<div class="fichas">${j.fichas}</div>` +
    `<div class="abaixo"><b>${j.lotes}</b> lote${j.lotes === 1 ? '' : 's'} · <span data-relogio>${tempoTexto(j.tempo)}</span></div>` +
    (eu ? '' : `<div class="presenca">${presenca(j)}</div>`)
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

// Quem chega por link vê a regra antes de entrar. Dois tipos de link:
// ?sala=ABCD leva a uma partida específica; ?jogar=1 é o link aberto do grupo.
// Demonstração de dez segundos. Ninguém lê tutorial de jogo, mas todo mundo
// entende assistindo uma mão — é o jeito que se aprende truco na mesa.
const ROTEIRO = [
  { topo: 'Lote 1 de 5', a: '?', b: '?', ganhou: null, texto: 'Cada um tem 100 fichas para os 5 lotes. Os lances são secretos.', ms: 2200 },
  { topo: 'Lote 1 de 5', a: '27', b: '19', ganhou: 'a', texto: 'Maior lance leva o lote. <b>Mas os dois pagam.</b>', ms: 2600 },
  { topo: 'Fichas restantes', a: '73', b: '81', ganhou: null, texto: 'Você levou o lote, e mesmo assim gastou mais que ele.', ms: 2400 },
  { topo: 'Lote 2 de 5', a: '0', b: '12', ganhou: 'b', texto: 'Dar <b>0</b> é jogada: entrega o lote de graça e guarda fichas.', ms: 2600 },
  { topo: 'Placar', a: '1', b: '1', ganhou: null, texto: 'Quem levar <b>3 lotes</b> vence a partida.', ms: 2200 },
];

function montarDemo(caixa) {
  const topo = caixa.querySelector('[data-demo-topo]');
  const a = caixa.querySelector('[data-demo-a]');
  const b = caixa.querySelector('[data-demo-b]');
  const legenda = caixa.querySelector('[data-demo-legenda]');
  let i = 0;
  let timer = null;

  function passo() {
    const q = ROTEIRO[i];
    topo.textContent = q.topo;
    a.querySelector('b').textContent = q.a;
    b.querySelector('b').textContent = q.b;
    a.classList.toggle('ganhou', q.ganhou === 'a');
    b.classList.toggle('ganhou', q.ganhou === 'b');
    legenda.innerHTML = q.texto;
    i = (i + 1) % ROTEIRO.length;
    timer = setTimeout(passo, q.ms);
  }
  passo();
  return () => clearTimeout(timer);
}

document.querySelectorAll('[data-demo]').forEach((el) => montarDemo(el));

const params = new URLSearchParams(location.search);
const salaDoLink = params.get('sala');
const meuNome = nomeSalvo();
if (meuNome) {
  $('nome').value = meuNome;
  $('convite-nome').value = meuNome;
}
if (sessao) {
  iniciarPesquisa();
} else if (salaDoLink && salaDoLink.length === 4) {
  modoConvite = 'sala';
  $('convite-codigo').textContent = salaDoLink.toUpperCase();
  corpo.dataset.tela = 'convite';
} else if (params.get('jogar')) {
  modoConvite = 'fila';
  $('convite-chamada').textContent = 'Entre na fila e jogue contra quem estiver esperando';
  $('btn-convite-entrar').textContent = 'Jogar agora';
  $('convite-rodape').hidden = true;
  corpo.dataset.tela = 'convite';
}
