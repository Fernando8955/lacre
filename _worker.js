// Lacre — temporada de um dia com partidas simultâneas.
//
// Ideias centrais:
// - Uma pessoa tem várias partidas abertas ao mesmo tempo. Nunca fica travada
//   esperando um adversário específico.
// - Cada lote tem prazo de 1 hora. Estourou, perde o lote. Estourou duas
//   vezes na mesma partida, perde a partida.
// - A temporada termina à meia-noite. O que estiver em aberto é decidido
//   pelos lotes já ganhos.
// - O lance de um jogador nunca sai do servidor antes dos dois lacrarem.

const TOTAL_LOTES = 5;
const FICHAS_INICIAIS = 100;
const LOTES_PARA_VENCER = 3;
const META_DIARIA = 15;
const PRAZO_LOTE = 60 * 60 * 1000; // 1 hora
const ESTOUROS_PARA_PERDER = 2;
const FUSO = -3 * 60 * 60 * 1000; // horário de Brasília

const json = (d, s = 200) =>
  new Response(JSON.stringify(d), {
    status: s,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
const erro = (m, s = 400) => json({ erro: m }, s);
const agora = () => Date.now();

function diaDe(ts) {
  return new Date(ts + FUSO).toISOString().slice(0, 10);
}
function fimDoDia(dia) {
  return Date.parse(dia + 'T00:00:00.000Z') - FUSO + 24 * 60 * 60 * 1000;
}
function novoId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}
const limparNome = (n) => String(n || '').trim().slice(0, 16) || 'Jogador';

async function registrar(env, dia, token, tipo, extra) {
  try {
    await env.DB.prepare(
      'INSERT INTO eventos (dia, token, tipo, extra, em) VALUES (?, ?, ?, ?, ?)'
    )
      .bind(dia, token || null, tipo, extra ? String(extra) : null, agora())
      .run();
  } catch {
    // registro de evento nunca pode derrubar o jogo
  }
}

// --- Jogador ---------------------------------------------------------------

async function acharJogador(env, token) {
  if (!token) return null;
  return await env.DB.prepare('SELECT * FROM jogadores WHERE token = ?').bind(token).first();
}

async function entrarTemporada(request, env) {
  let corpo;
  try {
    corpo = await request.json();
  } catch {
    return erro('Corpo inválido');
  }
  const ts = agora();
  const dia = diaDe(ts);
  const nome = limparNome(corpo.nome);
  let token = String(corpo.token || '');

  const existente = await acharJogador(env, token);
  if (existente) {
    await env.DB.prepare('UPDATE jogadores SET nome = ?, visto_em = ? WHERE token = ?')
      .bind(nome, ts, token)
      .run();
  } else {
    token = novoId() + novoId();
    await env.DB.prepare(
      'INSERT INTO jogadores (token, nome, criado_em, visto_em) VALUES (?, ?, ?, ?)'
    )
      .bind(token, nome, ts, ts)
      .run();
    await registrar(env, dia, token, 'entrou');
  }
  return json({ token, nome });
}

// --- Partida ---------------------------------------------------------------

function novaPartidaEstado(dia, jogador, ts) {
  return {
    dia,
    lote: 1,
    loteAbertoEm: ts,
    jogadores: [
      { token: jogador.token, nome: jogador.nome, fichas: FICHAS_INICIAIS, lotes: 0, estouros: 0 },
    ],
    lances: [null, null],
    historico: [],
    resultado: null,
  };
}

function prazoDoLote(estado, ts) {
  const limite = Math.min(estado.loteAbertoEm + PRAZO_LOTE, fimDoDia(estado.dia));
  return Math.max(0, limite - ts);
}

function decidir(estado) {
  const [a, b] = estado.jogadores;
  if (a.estouros >= ESTOUROS_PARA_PERDER) return { vencedor: 1, motivo: 'abandono' };
  if (b.estouros >= ESTOUROS_PARA_PERDER) return { vencedor: 0, motivo: 'abandono' };
  if (a.lotes > b.lotes) return { vencedor: 0, motivo: 'lotes' };
  if (b.lotes > a.lotes) return { vencedor: 1, motivo: 'lotes' };
  if (a.fichas > b.fichas) return { vencedor: 0, motivo: 'fichas' };
  if (b.fichas > a.fichas) return { vencedor: 1, motivo: 'fichas' };
  return { vencedor: -1, motivo: 'empate' };
}

function fecharPartida(estado) {
  estado.fase = 'fim';
  estado.resultado = decidir(estado);
}

function resolverLote(estado, ts) {
  const [a, b] = estado.lances;
  estado.historico.push({ lote: estado.lote, lances: [a, b] });
  if (a > b) estado.jogadores[0].lotes++;
  else if (b > a) estado.jogadores[1].lotes++;
  // Leilão all-pay: os dois pagam o que ofereceram.
  estado.jogadores[0].fichas -= a;
  estado.jogadores[1].fichas -= b;

  const fechou =
    estado.jogadores[0].lotes >= LOTES_PARA_VENCER ||
    estado.jogadores[1].lotes >= LOTES_PARA_VENCER;

  if (fechou || estado.lote >= TOTAL_LOTES) {
    fecharPartida(estado);
  } else {
    estado.lote++;
    estado.lances = [null, null];
    estado.loteAbertoEm = ts;
  }
}

// Aplica os dois relógios. Retorna true se algo mudou e precisa gravar.
function aplicarPrazos(estado, ts) {
  if (estado.fase === 'fim') return false;
  if (estado.jogadores.length < 2) {
    // Sala ainda esperando adversário: some no fim do dia.
    if (ts >= fimDoDia(estado.dia)) {
      estado.fase = 'fim';
      estado.resultado = { vencedor: -1, motivo: 'sem-adversario' };
      return true;
    }
    return false;
  }

  let mudou = false;
  // Pode ter passado mais de um prazo se ninguém abriu o app por horas.
  for (let volta = 0; volta < TOTAL_LOTES + 1; volta++) {
    if (estado.fase === 'fim') break;
    if (prazoDoLote(estado, ts) > 0) break;

    const faltou = [estado.lances[0] === null, estado.lances[1] === null];
    if (!faltou[0] && !faltou[1]) break; // não deveria acontecer

    for (let i = 0; i < 2; i++) {
      if (faltou[i]) {
        estado.jogadores[i].estouros++;
        estado.lances[i] = 0; // quem não lançou, não paga nada
      }
    }
    resolverLote(estado, ts);
    mudou = true;

    if (
      estado.fase !== 'fim' &&
      (estado.jogadores[0].estouros >= ESTOUROS_PARA_PERDER ||
        estado.jogadores[1].estouros >= ESTOUROS_PARA_PERDER)
    ) {
      fecharPartida(estado);
    }
  }

  // Virou o dia com partida em aberto: decide pelo que já foi ganho.
  if (estado.fase !== 'fim' && ts >= fimDoDia(estado.dia)) {
    fecharPartida(estado);
    mudou = true;
  }
  return mudou;
}

async function gravarPartida(env, id, estado, ts) {
  await env.DB.prepare(
    'UPDATE partidas SET estado = ?, fase = ?, atualizada_em = ? WHERE id = ?'
  )
    .bind(JSON.stringify(estado), estado.fase, ts, id)
    .run();
}

async function lerPartida(env, id) {
  const linha = await env.DB.prepare('SELECT * FROM partidas WHERE id = ?').bind(id).first();
  if (!linha) return null;
  const estado = JSON.parse(linha.estado);
  estado.fase = linha.fase;
  return { linha, estado };
}

// Contabiliza a partida encerrada no placar do dia, respeitando a cota.
async function contabilizar(env, estado) {
  const dia = estado.dia;
  for (let i = 0; i < estado.jogadores.length; i++) {
    const j = estado.jogadores[i];
    const r = estado.resultado;
    let pontos = 0;
    let v = 0;
    let e = 0;
    let d = 0;
    if (r.vencedor === -1) { pontos = 1; e = 1; }
    else if (r.vencedor === i) { pontos = 3; v = 1; }
    else { d = 1; }

    const atual = await env.DB.prepare('SELECT partidas FROM placar WHERE dia = ? AND token = ?')
      .bind(dia, j.token)
      .first();
    const jaTem = atual ? atual.partidas : 0;
    // Passou da cota: a partida continua valendo como jogo, mas não pontua.
    const contaPonto = jaTem < META_DIARIA;

    await env.DB.prepare(
      `INSERT INTO placar (dia, token, nome, partidas, vitorias, empates, derrotas, pontos, fichas)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
       ON CONFLICT(dia, token) DO UPDATE SET
         nome = excluded.nome,
         partidas = placar.partidas + 1,
         vitorias = placar.vitorias + excluded.vitorias,
         empates = placar.empates + excluded.empates,
         derrotas = placar.derrotas + excluded.derrotas,
         pontos = placar.pontos + excluded.pontos,
         fichas = placar.fichas + excluded.fichas`
    )
      .bind(
        dia, j.token, j.nome,
        contaPonto ? v : 0,
        contaPonto ? e : 0,
        contaPonto ? d : 0,
        contaPonto ? pontos : 0,
        contaPonto ? Math.max(0, j.fichas) : 0
      )
      .run();
  }
  await registrar(env, dia, null, 'partida-fim', estado.resultado.motivo);
}

// Garante que uma partida encerrada seja contabilizada uma única vez.
async function encerrarSeNecessario(env, id, estado, antes, ts) {
  if (estado.fase === 'fim' && antes !== 'fim') {
    await gravarPartida(env, id, estado, ts);
    if (estado.jogadores.length === 2) await contabilizar(env, estado);
    return true;
  }
  return false;
}

// --- Emparelhamento --------------------------------------------------------

async function novaPartida(request, env) {
  let corpo;
  try {
    corpo = await request.json();
  } catch {
    return erro('Corpo inválido');
  }
  const jogador = await acharJogador(env, String(corpo.token || ''));
  if (!jogador) return erro('Jogador não encontrado. Entre de novo.', 403);

  const ts = agora();
  const dia = diaDe(ts);

  // Com quem eu já tenho partida aberta? Não vale duplicar adversário.
  const abertas = await env.DB.prepare(
    `SELECT jog_a, jog_b FROM partidas
     WHERE dia = ? AND fase != 'fim' AND (jog_a = ? OR jog_b = ?)`
  )
    .bind(dia, jogador.token, jogador.token)
    .all();
  const ocupados = new Set([jogador.token]);
  let minhasAbertas = 0;
  for (const p of abertas.results || []) {
    minhasAbertas++;
    if (p.jog_a) ocupados.add(p.jog_a);
    if (p.jog_b) ocupados.add(p.jog_b);
  }
  if (minhasAbertas >= 8) {
    return erro('Você já tem muitas partidas abertas. Resolva algumas antes.', 409);
  }

  // Tenta ocupar a vaga de alguém que está esperando.
  const esperando = await env.DB.prepare(
    `SELECT id, jog_a, estado FROM partidas
     WHERE dia = ? AND fase = 'aguardando'
     ORDER BY criada_em ASC LIMIT 12`
  )
    .bind(dia)
    .all();

  for (const p of esperando.results || []) {
    if (ocupados.has(p.jog_a)) continue;
    const estado = JSON.parse(p.estado);
    if (estado.jogadores.length >= 2) continue;

    estado.jogadores.push({
      token: jogador.token,
      nome: jogador.nome,
      fichas: FICHAS_INICIAIS,
      lotes: 0,
      estouros: 0,
    });
    estado.fase = 'jogando';
    estado.loteAbertoEm = ts;

    const r = await env.DB.prepare(
      `UPDATE partidas SET jog_b = ?, fase = 'jogando', estado = ?, atualizada_em = ?
       WHERE id = ? AND fase = 'aguardando'`
    )
      .bind(jogador.token, JSON.stringify(estado), ts, p.id)
      .run();

    if (r && r.meta && r.meta.changes) {
      await registrar(env, dia, jogador.token, 'pareou');
      return json({ id: p.id, pareado: true });
    }
  }

  // Ninguém disponível: abre uma partida e espera.
  const id = novoId();
  const estado = novaPartidaEstado(dia, jogador, ts);
  estado.fase = 'aguardando';
  await env.DB.prepare(
    `INSERT INTO partidas (id, dia, jog_a, jog_b, fase, estado, criada_em, atualizada_em)
     VALUES (?, ?, ?, NULL, 'aguardando', ?, ?, ?)`
  )
    .bind(id, dia, jogador.token, JSON.stringify(estado), ts, ts)
    .run();
  await registrar(env, dia, jogador.token, 'abriu-partida');
  return json({ id, pareado: false });
}

// --- Visões ----------------------------------------------------------------

function visaoPartida(estado, id, meu, ts) {
  const outro = 1 - meu;
  const eu = estado.jogadores[meu];
  const ele = estado.jogadores[outro] || null;
  const ultimo = estado.historico.length ? estado.historico[estado.historico.length - 1] : null;

  return {
    id,
    fase: estado.fase,
    lote: estado.lote,
    totalLotes: TOTAL_LOTES,
    prazo: Math.floor(prazoDoLote(estado, ts) / 1000),
    eu: {
      nome: eu.nome,
      fichas: eu.fichas,
      lotes: eu.lotes,
      estouros: eu.estouros,
      lacrou: estado.lances[meu] !== null,
      lance: estado.lances[meu],
    },
    ele: ele
      ? {
          nome: ele.nome,
          fichas: ele.fichas,
          lotes: ele.lotes,
          estouros: ele.estouros,
          lacrou: estado.lances[outro] !== null,
          // O lance dele não sai daqui enquanto os dois não lacrarem.
        }
      : null,
    ultimoLote: ultimo
      ? { lote: ultimo.lote, meu: ultimo.lances[meu], dele: ultimo.lances[outro] }
      : null,
    historico: estado.historico.map((h) => ({
      lote: h.lote,
      meu: h.lances[meu],
      dele: h.lances[outro],
    })),
    resultado: estado.resultado
      ? {
          venci: estado.resultado.vencedor === meu,
          empate: estado.resultado.vencedor === -1,
          motivo: estado.resultado.motivo,
        }
      : null,
  };
}

async function verPartida(url, env) {
  const id = String(url.searchParams.get('id') || '');
  const token = String(url.searchParams.get('token') || '');
  const p = await lerPartida(env, id);
  if (!p) return erro('Partida não encontrada', 404);

  const meu = p.estado.jogadores.findIndex((j) => j.token === token);
  if (meu < 0) return erro('Você não está nessa partida', 403);

  const ts = agora();
  const antes = p.estado.fase;
  if (aplicarPrazos(p.estado, ts)) {
    if (!(await encerrarSeNecessario(env, id, p.estado, antes, ts))) {
      await gravarPartida(env, id, p.estado, ts);
    }
  }
  return json(visaoPartida(p.estado, id, meu, ts));
}

async function darLance(request, env) {
  let corpo;
  try {
    corpo = await request.json();
  } catch {
    return erro('Corpo inválido');
  }
  const id = String(corpo.id || '');
  const token = String(corpo.token || '');
  const p = await lerPartida(env, id);
  if (!p) return erro('Partida não encontrada', 404);

  const estado = p.estado;
  const meu = estado.jogadores.findIndex((j) => j.token === token);
  if (meu < 0) return erro('Você não está nessa partida', 403);

  const ts = agora();
  const antes = estado.fase;
  if (aplicarPrazos(estado, ts)) {
    if (!(await encerrarSeNecessario(env, id, estado, antes, ts))) {
      await gravarPartida(env, id, estado, ts);
    }
    return json(visaoPartida(estado, id, meu, ts));
  }

  if (estado.fase !== 'jogando') return erro('A partida não está em andamento');
  if (estado.lances[meu] !== null) return erro('Você já lacrou o lance deste lote');

  // O servidor nunca confia no número que chega do navegador.
  const valor = Math.floor(Number(corpo.valor));
  if (!Number.isFinite(valor) || valor < 0) return erro('Lance inválido');
  if (valor > estado.jogadores[meu].fichas) return erro('Você não tem essas fichas');

  estado.lances[meu] = valor;
  if (estado.lances[0] !== null && estado.lances[1] !== null) resolverLote(estado, ts);

  if (!(await encerrarSeNecessario(env, id, estado, antes, ts))) {
    await gravarPartida(env, id, estado, ts);
  }
  return json(visaoPartida(estado, id, meu, ts));
}

// --- Painel ----------------------------------------------------------------

async function painel(url, env) {
  const token = String(url.searchParams.get('token') || '');
  const jogador = await acharJogador(env, token);
  if (!jogador) return erro('Jogador não encontrado. Entre de novo.', 403);

  const ts = agora();
  const dia = diaDe(ts);

  const abertas = await env.DB.prepare(
    `SELECT id, jog_a, jog_b, fase, estado FROM partidas
     WHERE dia = ? AND fase != 'fim' AND (jog_a = ? OR jog_b = ?)
     ORDER BY atualizada_em ASC`
  )
    .bind(dia, token, token)
    .all();

  const lista = [];
  for (const p of abertas.results || []) {
    const estado = JSON.parse(p.estado);
    estado.fase = p.fase;
    const antes = estado.fase;
    if (aplicarPrazos(estado, ts)) {
      if (!(await encerrarSeNecessario(env, p.id, estado, antes, ts))) {
        await gravarPartida(env, p.id, estado, ts);
      }
    }
    if (estado.fase === 'fim') continue;

    const meu = estado.jogadores.findIndex((j) => j.token === token);
    if (meu < 0) continue;
    const ele = estado.jogadores[1 - meu] || null;
    lista.push({
      id: p.id,
      fase: estado.fase,
      adversario: ele ? ele.nome : null,
      lote: estado.lote,
      meusLotes: estado.jogadores[meu].lotes,
      lotesDele: ele ? ele.lotes : 0,
      fichas: estado.jogadores[meu].fichas,
      suaVez: estado.fase === 'jogando' && estado.lances[meu] === null,
      prazo: Math.floor(prazoDoLote(estado, ts) / 1000),
    });
  }

  const meu = await env.DB.prepare('SELECT * FROM placar WHERE dia = ? AND token = ?')
    .bind(dia, token)
    .first();

  const ranking = await env.DB.prepare(
    `SELECT token, nome, partidas, vitorias, pontos, fichas FROM placar
     WHERE dia = ? ORDER BY pontos DESC, fichas DESC, partidas ASC LIMIT 20`
  )
    .bind(dia)
    .all();

  const tabela = (ranking.results || []).map((r, i) => ({
    posicao: i + 1,
    nome: r.nome,
    partidas: r.partidas,
    vitorias: r.vitorias,
    pontos: r.pontos,
    sou: r.token === token,
  }));

  return json({
    nome: jogador.nome,
    dia,
    meta: META_DIARIA,
    terminaEm: Math.floor((fimDoDia(dia) - ts) / 1000),
    eu: {
      partidas: meu ? meu.partidas : 0,
      vitorias: meu ? meu.vitorias : 0,
      pontos: meu ? meu.pontos : 0,
      posicao: tabela.find((t) => t.sou) ? tabela.find((t) => t.sou).posicao : null,
    },
    partidas: lista,
    ranking: tabela,
  });
}

// --- Admin -----------------------------------------------------------------

async function admin(url, env) {
  const senha = String(url.searchParams.get('senha') || '');
  if (!env.SENHA_ADMIN || senha !== env.SENHA_ADMIN) return erro('Senha inválida', 403);

  const dia = String(url.searchParams.get('dia') || diaDe(agora()));

  const eventos = await env.DB.prepare(
    'SELECT tipo, COUNT(*) AS total FROM eventos WHERE dia = ? GROUP BY tipo'
  )
    .bind(dia)
    .all();

  const jogadores = await env.DB.prepare(
    `SELECT nome, partidas, vitorias, pontos FROM placar
     WHERE dia = ? ORDER BY pontos DESC, partidas DESC`
  )
    .bind(dia)
    .all();

  const resumo = await env.DB.prepare(
    `SELECT COUNT(*) AS pessoas,
            SUM(partidas) AS partidas,
            SUM(CASE WHEN partidas >= 15 THEN 1 ELSE 0 END) AS completaram,
            SUM(CASE WHEN partidas = 1 THEN 1 ELSE 0 END) AS so_uma
     FROM placar WHERE dia = ?`
  )
    .bind(dia)
    .first();

  return json({
    dia,
    resumo: resumo || {},
    eventos: eventos.results || [],
    jogadores: jogadores.results || [],
  });
}

// --- Roteador --------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (!env.DB) return erro('O banco não está ligado ao site. Falta o binding DB.', 500);

    try {
      const m = request.method;
      if (url.pathname === '/api/entrar' && m === 'POST') return await entrarTemporada(request, env);
      if (url.pathname === '/api/nova' && m === 'POST') return await novaPartida(request, env);
      if (url.pathname === '/api/partida' && m === 'GET') return await verPartida(url, env);
      if (url.pathname === '/api/lance' && m === 'POST') return await darLance(request, env);
      if (url.pathname === '/api/painel' && m === 'GET') return await painel(url, env);
      if (url.pathname === '/api/admin' && m === 'GET') return await admin(url, env);
      return erro('Rota não encontrada', 404);
    } catch (e) {
      return erro('Erro no servidor: ' + String(e && e.message ? e.message : e), 500);
    }
  },
};
