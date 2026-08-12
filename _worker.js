// Lacre — API e regras do jogo num arquivo só.
// O upload pelo painel da Cloudflare não compila a pasta functions/,
// mas reconhece um _worker.js na raiz. Por isso tudo vive aqui.

const TOTAL_LOTES = 5;
const FICHAS_INICIAIS = 100;
const LOTES_PARA_VENCER = 3;
const BANCOS = { rapido: 180, diario: 43200 };
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

function json(dados, status = 200) {
  return new Response(JSON.stringify(dados), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
function erro(mensagem, status = 400) {
  return json({ erro: mensagem }, status);
}
const agora = () => Date.now();

function gerarCodigo() {
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  let c = '';
  for (let i = 0; i < 4; i++) c += ALFABETO[b[i] % ALFABETO.length];
  return c;
}
const gerarToken = () => crypto.randomUUID().replace(/-/g, '');
const limparNome = (n) => String(n || '').trim().slice(0, 16) || 'Jogador';

async function lerSala(db, codigo) {
  const linha = await db
    .prepare('SELECT codigo, estado FROM salas WHERE codigo = ?')
    .bind(codigo)
    .first();
  return linha ? { codigo: linha.codigo, estado: JSON.parse(linha.estado) } : null;
}
async function gravarSala(db, codigo, estado) {
  await db
    .prepare('UPDATE salas SET estado = ?, atualizada_em = ? WHERE codigo = ?')
    .bind(JSON.stringify(estado), agora(), codigo)
    .run();
}

function novoEstado(banco, aberta) {
  return {
    fase: 'aguardando',
    banco,
    aberta: aberta ? 1 : 0,
    lote: 1,
    loteAbertoEm: null,
    jogadores: [],
    lances: [null, null],
    historico: [],
    resultado: null,
    revanche: null,
  };
}
function novoJogador(nome) {
  return {
    token: gerarToken(),
    nome: limparNome(nome),
    fichas: FICHAS_INICIAIS,
    lotes: 0,
    tempo: null,
    visto: Date.now(),
  };
}

// Marca presença. Só grava se passou tempo suficiente, para não escrever
// no banco a cada 3 segundos de consulta.
function marcarVisto(estado, i, ts) {
  const j = estado.jogadores[i];
  if (!j) return false;
  if (j.visto && ts - j.visto < 15000) return false;
  j.visto = ts;
  return true;
}

function decorrido(estado, ts) {
  return estado.loteAbertoEm ? Math.floor((ts - estado.loteAbertoEm) / 1000) : 0;
}
function tempoRestante(estado, i, ts) {
  const j = estado.jogadores[i];
  if (!j || j.tempo === null) return null;
  if (estado.fase !== 'jogando') return j.tempo;
  if (estado.lances[i] !== null) return j.tempo;
  return Math.max(0, j.tempo - decorrido(estado, ts));
}
function aplicarRelogio(estado, ts) {
  if (estado.fase !== 'jogando') return false;
  for (let i = 0; i < 2; i++) {
    if (estado.lances[i] === null && tempoRestante(estado, i, ts) <= 0) {
      estado.jogadores[i].tempo = 0;
      estado.fase = 'fim';
      estado.resultado = { vencedor: 1 - i, motivo: 'tempo' };
      return true;
    }
  }
  return false;
}
function decidirVencedor(estado) {
  const [a, b] = estado.jogadores;
  if (a.lotes > b.lotes) return { vencedor: 0, motivo: 'lotes' };
  if (b.lotes > a.lotes) return { vencedor: 1, motivo: 'lotes' };
  if (a.fichas > b.fichas) return { vencedor: 0, motivo: 'fichas' };
  if (b.fichas > a.fichas) return { vencedor: 1, motivo: 'fichas' };
  return { vencedor: -1, motivo: 'empate' };
}
function resolverLote(estado, ts) {
  const [a, b] = estado.lances;
  estado.historico.push({ lote: estado.lote, lances: [a, b] });
  if (a > b) estado.jogadores[0].lotes++;
  else if (b > a) estado.jogadores[1].lotes++;
  // Leilão all-pay: os dois pagam, mesmo quem perde.
  estado.jogadores[0].fichas -= a;
  estado.jogadores[1].fichas -= b;
  const fechou =
    estado.jogadores[0].lotes >= LOTES_PARA_VENCER ||
    estado.jogadores[1].lotes >= LOTES_PARA_VENCER;
  if (fechou || estado.lote >= TOTAL_LOTES) {
    estado.fase = 'fim';
    estado.resultado = decidirVencedor(estado);
  } else {
    estado.lote++;
    estado.lances = [null, null];
    estado.loteAbertoEm = ts;
  }
}

// O lance do adversário nunca sai daqui antes dos dois lacrarem.
function visao(estado, codigo, meuIndice, ts) {
  const outro = 1 - meuIndice;
  const eu = estado.jogadores[meuIndice];
  const ele = estado.jogadores[outro] || null;
  const ultimo = estado.historico.length
    ? estado.historico[estado.historico.length - 1]
    : null;
  return {
    codigo,
    fase: estado.fase,
    lote: estado.lote,
    totalLotes: TOTAL_LOTES,
    lotesParaVencer: LOTES_PARA_VENCER,
    meuIndice,
    eu: {
      nome: eu.nome,
      fichas: eu.fichas,
      lotes: eu.lotes,
      tempo: tempoRestante(estado, meuIndice, ts),
      lacrou: estado.lances[meuIndice] !== null,
      lance: estado.lances[meuIndice],
    },
    ele: ele
      ? {
          nome: ele.nome,
          fichas: ele.fichas,
          lotes: ele.lotes,
          tempo: tempoRestante(estado, outro, ts),
          lacrou: estado.lances[outro] !== null,
          online: ele.visto ? ts - ele.visto < 45000 : false,
          vistoHa: ele.visto ? Math.floor((ts - ele.visto) / 1000) : null,
        }
      : null,
    ultimoLote: ultimo
      ? { lote: ultimo.lote, meu: ultimo.lances[meuIndice], dele: ultimo.lances[outro] }
      : null,
    historico: estado.historico.map((h) => ({
      lote: h.lote,
      meu: h.lances[meuIndice],
      dele: h.lances[outro],
    })),
    revelado: estado.lances[0] !== null && estado.lances[1] !== null,
    revanche: estado.revanche || null,
    resultado: estado.resultado
      ? {
          venci: estado.resultado.vencedor === meuIndice,
          empate: estado.resultado.vencedor === -1,
          motivo: estado.resultado.motivo,
        }
      : null,
  };
}
const acharJogador = (estado, token) =>
  estado.jogadores.findIndex((j) => j && j.token === token);

async function criarSala(request, env) {
  let corpo;
  try {
    corpo = await request.json();
  } catch {
    return erro('Corpo inválido');
  }
  const banco = BANCOS[corpo.banco] || BANCOS.diario;
  const estado = novoEstado(banco);
  const jogador = novoJogador(corpo.nome);
  estado.jogadores.push(jogador);

  for (let t = 0; t < 6; t++) {
    const codigo = gerarCodigo();
    const ts = agora();
    try {
      await env.DB.prepare(
        'INSERT INTO salas (codigo, estado, criada_em, atualizada_em) VALUES (?, ?, ?, ?)'
      )
        .bind(codigo, JSON.stringify(estado), ts, ts)
        .run();
      return json({ codigo, token: jogador.token });
    } catch (e) {
      if (!String(e).includes('UNIQUE')) throw e;
    }
  }
  return erro('Não foi possível criar a sala. Tente de novo.', 500);
}

async function entrarSala(request, env) {
  let corpo;
  try {
    corpo = await request.json();
  } catch {
    return erro('Corpo inválido');
  }
  const codigo = String(corpo.codigo || '').trim().toUpperCase();
  if (codigo.length !== 4) return erro('Código deve ter 4 letras');

  const sala = await lerSala(env.DB, codigo);
  if (!sala) return erro('Sala não encontrada', 404);

  const estado = sala.estado;
  if (estado.jogadores.length >= 2) return erro('Essa sala já tem dois jogadores');

  const jogador = novoJogador(corpo.nome);
  estado.jogadores.push(jogador);

  const ts = agora();
  estado.fase = 'jogando';
  estado.loteAbertoEm = ts;
  estado.jogadores[0].tempo = estado.banco;
  estado.jogadores[1].tempo = estado.banco;

  await gravarSala(env.DB, codigo, estado);
  return json({ codigo, token: jogador.token });
}

// Fila aberta: um link só para o grupo inteiro. Quem chega ou é emparelhado
// com alguém que já está esperando, ou vira o próximo da fila.
async function entrarNaFila(request, env) {
  let corpo;
  try {
    corpo = await request.json();
  } catch {
    return erro('Corpo inválido');
  }
  const banco = BANCOS[corpo.banco] || BANCOS.diario;
  const ts = agora();
  const limite = ts - 30 * 60 * 1000; // salas paradas há mais de 30 min não valem

  // Tenta entrar numa sala que já está esperando alguém.
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    const linha = await env.DB.prepare(
      `SELECT codigo, estado FROM salas
       WHERE json_extract(estado, '$.aberta') = 1
         AND json_extract(estado, '$.fase') = 'aguardando'
         AND criada_em > ?
       ORDER BY criada_em ASC LIMIT 1`
    )
      .bind(limite)
      .first();

    if (!linha) break;

    const estado = JSON.parse(linha.estado);
    if (estado.jogadores.length >= 2) continue; // alguém pegou antes, tenta de novo

    const jogador = novoJogador(corpo.nome);
    estado.jogadores.push(jogador);
    estado.fase = 'jogando';
    estado.loteAbertoEm = ts;
    estado.jogadores[0].tempo = estado.banco;
    estado.jogadores[1].tempo = estado.banco;

    // Só ocupa a vaga se a sala continuar aguardando neste instante.
    const r = await env.DB.prepare(
      `UPDATE salas SET estado = ?, atualizada_em = ?
       WHERE codigo = ? AND json_extract(estado, '$.fase') = 'aguardando'`
    )
      .bind(JSON.stringify(estado), ts, linha.codigo)
      .run();

    const mudou = r && r.meta && r.meta.changes;
    if (mudou) return json({ codigo: linha.codigo, token: jogador.token, pareado: true });
  }

  // Ninguém esperando: cria a sala e fica na fila.
  const estado = novoEstado(banco, true);
  const jogador = novoJogador(corpo.nome);
  estado.jogadores.push(jogador);

  for (let t = 0; t < 6; t++) {
    const codigo = gerarCodigo();
    try {
      await env.DB.prepare(
        'INSERT INTO salas (codigo, estado, criada_em, atualizada_em) VALUES (?, ?, ?, ?)'
      )
        .bind(codigo, JSON.stringify(estado), ts, ts)
        .run();
      return json({ codigo, token: jogador.token, pareado: false });
    } catch (e) {
      if (!String(e).includes('UNIQUE')) throw e;
    }
  }
  return erro('Não foi possível entrar na fila. Tente de novo.', 500);
}

// Revanche. O mesmo endpoint serve para quem chama e para quem aceita:
// se já existe uma revanche marcada, a pessoa entra nela.
async function revanche(request, env) {
  let corpo;
  try {
    corpo = await request.json();
  } catch {
    return erro('Corpo inválido');
  }
  const codigo = String(corpo.codigo || '').trim().toUpperCase();
  const token = String(corpo.token || '');

  const sala = await lerSala(env.DB, codigo);
  if (!sala) return erro('Sala não encontrada', 404);
  const estado = sala.estado;
  const i = acharJogador(estado, token);
  if (i < 0) return erro('Você não está nessa sala', 403);
  if (estado.fase !== 'fim') return erro('A partida ainda não acabou');

  const nome = estado.jogadores[i].nome;
  const ts = agora();

  // Alguém já chamou: entra na sala da revanche.
  if (estado.revanche) {
    const nova = await lerSala(env.DB, estado.revanche);
    if (!nova) return erro('A revanche não está mais disponível', 404);
    const e2 = nova.estado;
    if (e2.jogadores.length >= 2) return erro('A revanche já começou');

    const j = novoJogador(nome);
    e2.jogadores.push(j);
    e2.fase = 'jogando';
    e2.loteAbertoEm = ts;
    e2.jogadores[0].tempo = e2.banco;
    e2.jogadores[1].tempo = e2.banco;
    await gravarSala(env.DB, estado.revanche, e2);
    return json({ codigo: estado.revanche, token: j.token, aceitou: true });
  }

  // Ninguém chamou ainda: cria a sala nova e marca na antiga.
  const e2 = novoEstado(estado.banco, false);
  const j = novoJogador(nome);
  e2.jogadores.push(j);

  for (let t = 0; t < 6; t++) {
    const novoCodigo = gerarCodigo();
    try {
      await env.DB.prepare(
        'INSERT INTO salas (codigo, estado, criada_em, atualizada_em) VALUES (?, ?, ?, ?)'
      )
        .bind(novoCodigo, JSON.stringify(e2), ts, ts)
        .run();

      // Só marca se o outro não marcou primeiro.
      estado.revanche = novoCodigo;
      const r = await env.DB.prepare(
        `UPDATE salas SET estado = ?, atualizada_em = ?
         WHERE codigo = ? AND json_extract(estado, '$.revanche') IS NULL`
      )
        .bind(JSON.stringify(estado), ts, codigo)
        .run();

      if (r && r.meta && r.meta.changes) {
        return json({ codigo: novoCodigo, token: j.token, aceitou: false });
      }
      // O outro chamou no mesmo instante: entra na dele.
      return await revanche(
        new Request(request.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ codigo, token }),
        }),
        env
      );
    } catch (e) {
      if (!String(e).includes('UNIQUE')) throw e;
    }
  }
  return erro('Não foi possível criar a revanche.', 500);
}

async function lerEstado(url, env) {
  const codigo = String(url.searchParams.get('codigo') || '').trim().toUpperCase();
  const token = String(url.searchParams.get('token') || '');
  const sala = await lerSala(env.DB, codigo);
  if (!sala) return erro('Sala não encontrada', 404);

  const estado = sala.estado;
  const i = acharJogador(estado, token);
  if (i < 0) return erro('Você não está nessa sala', 403);

  const ts = agora();
  const mudouVisto = marcarVisto(estado, i, ts);
  if (aplicarRelogio(estado, ts) || mudouVisto) await gravarSala(env.DB, codigo, estado);
  return json(visao(estado, codigo, i, ts));
}

async function darLance(request, env) {
  let corpo;
  try {
    corpo = await request.json();
  } catch {
    return erro('Corpo inválido');
  }
  const codigo = String(corpo.codigo || '').trim().toUpperCase();
  const token = String(corpo.token || '');

  const sala = await lerSala(env.DB, codigo);
  if (!sala) return erro('Sala não encontrada', 404);

  const estado = sala.estado;
  const i = acharJogador(estado, token);
  if (i < 0) return erro('Você não está nessa sala', 403);

  const ts = agora();
  if (aplicarRelogio(estado, ts)) {
    await gravarSala(env.DB, codigo, estado);
    return json(visao(estado, codigo, i, ts));
  }
  if (estado.fase !== 'jogando') return erro('A partida não está em andamento');
  if (estado.lances[i] !== null) return erro('Você já lacrou o lance deste lote');

  // O servidor nunca confia no número que chega do navegador.
  const valor = Math.floor(Number(corpo.valor));
  if (!Number.isFinite(valor) || valor < 0) return erro('Lance inválido');
  if (valor > estado.jogadores[i].fichas) return erro('Você não tem essas fichas');

  estado.jogadores[i].tempo = Math.max(0, tempoRestante(estado, i, ts));
  estado.jogadores[i].visto = ts;
  estado.lances[i] = valor;

  if (estado.lances[0] !== null && estado.lances[1] !== null) resolverLote(estado, ts);

  await gravarSala(env.DB, codigo, estado);
  return json(visao(estado, codigo, i, ts));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      if (!env.DB) {
        return erro('O banco não está ligado ao site. Falta o binding DB.', 500);
      }
      try {
        if (url.pathname === '/api/sala' && request.method === 'POST') {
          return await criarSala(request, env);
        }
        if (url.pathname === '/api/entrar' && request.method === 'POST') {
          return await entrarSala(request, env);
        }
        if (url.pathname === '/api/fila' && request.method === 'POST') {
          return await entrarNaFila(request, env);
        }
        if (url.pathname === '/api/revanche' && request.method === 'POST') {
          return await revanche(request, env);
        }
        if (url.pathname === '/api/estado' && request.method === 'GET') {
          return await lerEstado(url, env);
        }
        if (url.pathname === '/api/lance' && request.method === 'POST') {
          return await darLance(request, env);
        }
        return erro('Rota não encontrada', 404);
      } catch (e) {
        return erro('Erro no servidor: ' + String(e && e.message ? e.message : e), 500);
      }
    }

    return env.ASSETS.fetch(request);
  },
};
