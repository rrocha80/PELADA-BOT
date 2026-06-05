import qrcode from 'qrcode-terminal';
import db from './database.js';
import pino from 'pino';
let makeWASocket;
let useMultiFileAuthState;
let DisconnectReason;
let fetchLatestBaileysVersion;
let Browsers;
const logger = pino({ level: process.env.DEBUG ? 'debug' : 'info' });
// novo: controla fluxo de pedir nome do convidado por grupo
// agora guarda remoteJid -> inviterJid (quem pediu), para só aceitar resposta desse usuário
const pendingConvidado = new Map(); // remoteJid -> inviterJid
// novo: controla pedidos de apagar listas (remoteJid -> { type, requester })
const pendingDelete = new Map();
// novo: controla pedido de apagar um convidado específico (remoteJid -> { requesterJid, requesterName })
const pendingDeleteSingle = new Map();
// novo: controla pedido de apagar um mensalista específico (remoteJid -> { requesterJid, requesterName })
const pendingDeleteSingleMensalista = new Map();
// controla quem pode clicar no menu logo apos pedir "pelada"
const pendingPelada = new Map(); // remoteJid -> set(senderJid)
function allowPeladaConfirmation(remoteJid, senderJid, ttlMs = 2 * 60 * 1000) {
    let set = pendingPelada.get(remoteJid);
    if (!set) {
        set = new Set();
        pendingPelada.set(remoteJid, set);
    }
    set.add(senderJid);
    setTimeout(() => {
        set.delete(senderJid);
        if (set.size === 0)
            pendingPelada.delete(remoteJid);
    }, ttlMs);
}
async function conectarBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth');
    let version;
    try {
        if (fetchLatestBaileysVersion) {
            const latest = await fetchLatestBaileysVersion();
            version = latest?.version;
            logger.info({ version, isLatest: latest?.isLatest }, 'Baileys version info');
        }
    }
    catch (e) {
        logger.warn({ e }, 'Nao foi possivel obter versao mais recente do WhatsApp Web');
    }
    const sock = makeWASocket({
        auth: state,
        logger,
        printQRInTerminal: true,
        version,
        browser: Browsers?.macOS ? Browsers.macOS('Desktop') : ['Pelada Bot', 'Desktop', '1.0.0'],
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false
    });
    // opcional: pareamento por codigo numerico (evita problemas de leitura de QR)
    const phoneForPairing = (process.env.PAIRING_PHONE || '').replace(/\D/g, '');
    if (phoneForPairing && !state?.creds?.registered) {
        try {
            const code = await sock.requestPairingCode(phoneForPairing);
            const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
            logger.info({ phoneForPairing }, 'Pareamento por codigo habilitado');
            console.log('Codigo de pareamento:', formatted);
        }
        catch (e) {
            logger.error({ e }, 'Falha ao gerar codigo de pareamento');
        }
    }
    sock.ev.on('creds.update', saveCreds);
    // substitua o handler atual por este (mais verboso e com reconexão)
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            // mostra ASCII no terminal
            qrcode.generate(qr, { small: true });
            // string bruta do QR (para ambientes onde o ASCII nao aparece bem)
            console.log('QR (url):', qr);
            logger.info('QR generated');
        }
        logger.info({ connection, lastDisconnect }, 'connection.update');
        if (connection === 'open') {
            logger.info('Bot conectado com sucesso!');
        }
        if (connection === 'close') {
            const err = lastDisconnect?.error;
            logger.warn({ err }, 'connection closed');
            const isLoggedOut = err?.output?.statusCode === DisconnectReason?.loggedOut;
            if (!isLoggedOut) {
                logger.info('Tentando reconectar em 3s...');
                setTimeout(() => conectarBot().catch(e => logger.error({ e }, 'reconnect failed')), 3000);
            }
            else {
                logger.info('Sessão foi desconectada (logged out). Apague auth/ e reautentique.');
            }
        }
    });
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages?.[0];
        if (!msg?.message)
            return;
        const remoteJid = msg.key.remoteJid;
        if (!remoteJid || !remoteJid.includes('@g.us'))
            return;
        const senderJid = msg.key.participant || msg.key.remoteJid; // quem enviou a mensagem
        const rawText = (msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            '').trim();
        // tratar clique em botao (baileys buttonsResponseMessage)
        const btnResp = msg.message?.buttonsResponseMessage;
        if (btnResp) {
            const selectedId = btnResp.selectedButtonId;
            const display = (btnResp.selectedDisplayText || '').toLowerCase();
            const allowed = pendingPelada.get(remoteJid);
            if (!allowed || !allowed.has(senderJid)) {
                await sock.sendMessage(remoteJid, { text: 'Para confirmar, primeiro digite "pelada".' });
                return;
            }
            // remove permissão após uso
            allowed.delete(senderJid);
            if (allowed.size === 0)
                pendingPelada.delete(remoteJid);
            if (selectedId === 'pelada_add' || display.includes('colocar meu nome na lista') || selectedId === 'pelada_sim' || display.includes('sim')) {
                adicionarParticipante(msg.pushName || 'Sem Nome', async () => {
                    const lista = await obterLista();
                    await sock.sendMessage(remoteJid, { text: formatarLista(lista) });
                });
            }
            else if (selectedId === 'pelada_remove' || display.includes('retirar meu nome da lista') || display.includes('retiar meu nome da lista') || selectedId === 'pelada_nao' || display.includes('não') || display.includes('nao')) {
                removerParticipante(msg.pushName || 'Sem Nome', async () => {
                    const lista = await obterLista();
                    await sock.sendMessage(remoteJid, { text: formatarLista(lista) });
                });
            }
            else if (selectedId === 'pelada_show' || display.includes('exibir a lista da pelada')) {
                const lista = await obterLista();
                await sock.sendMessage(remoteJid, { text: formatarLista(lista) });
            }
            else if (selectedId === 'pelada_guest' || display.includes('incluir convidado')) {
                pendingConvidado.set(remoteJid, senderJid);
                await sock.sendMessage(remoteJid, { text: 'Digite o nome do convidado:' });
            }
            return;
        }
        // tratar selecao de lista interativa (listResponseMessage)
        const listResp = msg.message?.listResponseMessage;
        if (listResp) {
            const selectedId = listResp.singleSelectReply?.selectedRowId;
            const selectedTitle = (listResp.title || '').toLowerCase();
            const allowed = pendingPelada.get(remoteJid);
            if (!allowed || !allowed.has(senderJid)) {
                await sock.sendMessage(remoteJid, { text: 'Para confirmar, primeiro digite "pelada".' });
                return;
            }
            // remove permissão após uso
            allowed.delete(senderJid);
            if (allowed.size === 0)
                pendingPelada.delete(remoteJid);
            if (selectedId === 'pelada_add' || selectedTitle.includes('colocar meu nome na lista')) {
                adicionarParticipante(msg.pushName || 'Sem Nome', async () => {
                    const lista = await obterLista();
                    await sock.sendMessage(remoteJid, { text: formatarLista(lista) });
                });
            }
            else if (selectedId === 'pelada_remove' || selectedTitle.includes('retirar meu nome da lista') || selectedTitle.includes('retiar meu nome da lista')) {
                removerParticipante(msg.pushName || 'Sem Nome', async () => {
                    const lista = await obterLista();
                    await sock.sendMessage(remoteJid, { text: formatarLista(lista) });
                });
            }
            else if (selectedId === 'pelada_show' || selectedTitle.includes('exibir a lista da pelada')) {
                const lista = await obterLista();
                await sock.sendMessage(remoteJid, { text: formatarLista(lista) });
            }
            else if (selectedId === 'pelada_guest' || selectedTitle.includes('incluir convidado')) {
                pendingConvidado.set(remoteJid, senderJid);
                await sock.sendMessage(remoteJid, { text: 'Digite o nome do convidado:' });
            }
            return;
        }
        const texto = rawText.toLowerCase();
        const participante = msg.pushName || 'Sem Nome';
        // quando alguem digita "pelada" envia menu de acoes clicaveis
        if (texto === 'pelada') {
            allowPeladaConfirmation(remoteJid, senderJid);
            await sock.sendMessage(remoteJid, {
                poll: {
                    name: `⚽ Pelada ${DATA_PELADA} - escolha uma opcao`,
                    selectableCount: 1,
                    values: [
                        '1 - Colocar meu nome na lista',
                        '2 - Retirar meu nome da lista',
                        '3 - Exibir a lista da pelada',
                        '4 - Incluir convidado'
                    ]
                }
            });
            await sock.sendMessage(remoteJid, {
                text: 'Toque na enquete (clicavel). Se preferir, responda com: 1, 2, 3 ou 4.'
            });
            return;
        }
        if (texto === '1') {
            adicionarParticipante(participante, async () => {
                const lista = await obterLista();
                await sock.sendMessage(remoteJid, { text: formatarLista(lista) });
            });
            return;
        }
        if (texto === '2') {
            removerParticipante(participante, async () => {
                const lista = await obterLista();
                await sock.sendMessage(remoteJid, { text: formatarLista(lista) });
            });
            return;
        }
        if (texto === '3') {
            const lista = await obterLista();
            await sock.sendMessage(remoteJid, { text: formatarLista(lista) });
            return;
        }
        if (texto === '4') {
            pendingConvidado.set(remoteJid, senderJid);
            await sock.sendMessage(remoteJid, { text: 'Digite o nome do convidado:' });
            return;
        }
        // início do fluxo: registra quem pediu (inviterJid) no map
        if (texto === 'convidado' || texto === 'convidade') {
            pendingConvidado.set(remoteJid, senderJid);
            await sock.sendMessage(remoteJid, { text: 'Digite o nome do convidado:' });
            return;
        }
        // resposta ao pedido de convidado: só aceita se quem respondeu for quem pediu
        const inviterJid = pendingConvidado.get(remoteJid);
        if (inviterJid && inviterJid === senderJid) {
            // esta mensagem é o nome do convidado enviada pelo próprio quem pediu
            pendingConvidado.delete(remoteJid);
            const nomeConvidado = rawText.trim();
            if (!nomeConvidado) {
                // solicita novamente se vazio
                pendingConvidado.set(remoteJid, inviterJid);
                await sock.sendMessage(remoteJid, { text: 'Nome inválido. Digite o nome do convidado:' });
                return;
            }
            // verifica se já existe convidado com esse nome (case-insensitive)
            db.get(`SELECT 1 FROM convidados WHERE nome = ? COLLATE NOCASE`, [nomeConvidado], async (err, row) => {
                if (err) {
                    await sock.sendMessage(remoteJid, { text: 'Erro ao verificar convidado.' });
                    return;
                }
                if (row) {
                    await sock.sendMessage(remoteJid, { text: `Convidado "${nomeConvidado}" já está na lista.` });
                    return;
                }
                // não existe -> adiciona
                adicionarConvidado(nomeConvidado, participante, async (err2) => {
                    if (err2) {
                        await sock.sendMessage(remoteJid, { text: 'Erro ao adicionar convidado.' });
                        return;
                    }
                    const lista = await obterLista();
                    await sock.sendMessage(remoteJid, { text: formatarLista(lista) });
                });
            });
            return;
        }
        // se existir pending mas quem respondeu não é o convidador, ignore o pending e prossiga normalmente
        if (['sim', 's', 'bora', 'dentro'].includes(texto)) {
            adicionarParticipante(participante, async () => {
                const lista = await obterLista();
                await sock.sendMessage(remoteJid, { text: formatarLista(lista) });
            });
        }
        if (['nao', 'não', 'n', 'fora'].includes(texto)) {
            removerParticipante(participante, async () => {
                const lista = await obterLista();
                await sock.sendMessage(remoteJid, { text: formatarLista(lista) });
            });
        }
        if (texto === 'colocar meu nome na lista') {
            adicionarParticipante(participante, async () => {
                const lista = await obterLista();
                await sock.sendMessage(remoteJid, { text: formatarLista(lista) });
            });
            return;
        }
        if (texto === 'retirar meu nome da lista' || texto === 'retiar meu nome da lista') {
            removerParticipante(participante, async () => {
                const lista = await obterLista();
                await sock.sendMessage(remoteJid, { text: formatarLista(lista) });
            });
            return;
        }
        if (texto === 'exibir a lista da pelada') {
            const lista = await obterLista();
            await sock.sendMessage(remoteJid, { text: formatarLista(lista) });
            return;
        }
        if (texto === 'incluir convidado') {
            pendingConvidado.set(remoteJid, senderJid);
            await sock.sendMessage(remoteJid, { text: 'Digite o nome do convidado:' });
            return;
        }
        // fluxo de confirmação por senha para apagar listas
        const pending = pendingDelete.get(remoteJid);
        if (pending && pending.requester === senderJid) {
            // trata a mensagem atual como senha
            pendingDelete.delete(remoteJid);
            const senha = rawText.trim();
            if (!senha) {
                pendingDelete.set(remoteJid, pending);
                await sock.sendMessage(remoteJid, { text: 'Senha vazia. Digite a senha:' });
                return;
            }
            // envia apenas asteriscos para não expor a senha no grupo
            await sock.sendMessage(remoteJid, { text: '*'.repeat(senha.length) });
            if (senha === 'marrada') {
                if (pending.type === 'convidados') {
                    apagarConvidados(async (err) => {
                        if (err) {
                            await sock.sendMessage(remoteJid, { text: 'Erro ao apagar convidados.' });
                            return;
                        }
                        const lista = await obterLista();
                        await sock.sendMessage(remoteJid, { text: 'Lista de convidados apagada.' });
                        await sock.sendMessage(remoteJid, { text: formatarLista(lista) });
                    });
                }
                else {
                    apagarMensalistas(async (err) => {
                        if (err) {
                            await sock.sendMessage(remoteJid, { text: 'Erro ao apagar mensalistas.' });
                            return;
                        }
                        const lista = await obterLista();
                        await sock.sendMessage(remoteJid, { text: 'Lista de mensalistas apagada.' });
                        await sock.sendMessage(remoteJid, { text: formatarLista(lista) });
                    });
                }
            }
            else {
                await sock.sendMessage(remoteJid, { text: 'Senha incorreta.' });
            }
            return;
        }
        // iniciar fluxo de apagar listas: pede senha
        if (texto === 'apagar convidados') {
            pendingDelete.set(remoteJid, { type: 'convidados', requester: senderJid });
            await sock.sendMessage(remoteJid, { text: 'Digite a senha:' });
            return;
        }
        if (texto === 'apagar mensalistas') {
            pendingDelete.set(remoteJid, { type: 'mensalistas', requester: senderJid });
            await sock.sendMessage(remoteJid, { text: 'Digite a senha:' });
            return;
        }
        // iniciar fluxo para apagar um convidado específico
        if (texto === 'apagar convidado') {
            pendingDeleteSingle.set(remoteJid, { requesterJid: senderJid, requesterName: participante });
            await sock.sendMessage(remoteJid, { text: 'Digite o nome do convidado a apagar:' });
            return;
        }
        // resposta ao pedido de apagar convidado: só aceita se quem respondeu for quem pediu
        const pendingSingle = pendingDeleteSingle.get(remoteJid);
        if (pendingSingle && pendingSingle.requesterJid === senderJid) {
            pendingDeleteSingle.delete(remoteJid);
            const nomeToDelete = rawText.trim();
            if (!nomeToDelete) {
                // solicita novamente se vazio
                pendingDeleteSingle.set(remoteJid, pendingSingle);
                await sock.sendMessage(remoteJid, { text: 'Nome inválido. Digite o nome do convidado a apagar:' });
                return;
            }
            // verifica existência e quem convidou
            db.get(`SELECT convidado_por FROM convidados WHERE nome = ?`, [nomeToDelete], async (err, row) => {
                if (err) {
                    await sock.sendMessage(remoteJid, { text: 'Erro ao verificar convidado.' });
                    return;
                }
                if (!row) {
                    await sock.sendMessage(remoteJid, { text: 'Convidado não encontrado.' });
                    return;
                }
                if (row.convidado_por !== pendingSingle.requesterName) {
                    await sock.sendMessage(remoteJid, { text: 'Você não é o convidador deste convidado.' });
                    return;
                }
                // apaga apenas o convidado com esse nome e convidador
                db.run(`DELETE FROM convidados WHERE nome = ? AND convidado_por = ?`, [nomeToDelete, pendingSingle.requesterName], async (err2) => {
                    if (err2) {
                        await sock.sendMessage(remoteJid, { text: 'Erro ao apagar convidado.' });
                        return;
                    }
                    const lista = await obterLista();
                    await sock.sendMessage(remoteJid, { text: `Convidado ${nomeToDelete} apagado.` });
                    await sock.sendMessage(remoteJid, { text: formatarLista(lista) });
                });
            });
            return;
        }
        // iniciar fluxo para apagar um mensalista específico
        if (texto === 'apagar mensalista') {
            pendingDeleteSingleMensalista.set(remoteJid, { requesterJid: senderJid, requesterName: participante });
            await sock.sendMessage(remoteJid, { text: 'Digite o nome do mensalista a apagar:' });
            return;
        }
        // resposta ao pedido de apagar mensalista: só aceita se quem respondeu for quem pediu
        const pendingMens = pendingDeleteSingleMensalista.get(remoteJid);
        if (pendingMens && pendingMens.requesterJid === senderJid) {
            pendingDeleteSingleMensalista.delete(remoteJid);
            const nomeToDelete = rawText.trim();
            if (!nomeToDelete) {
                // solicita novamente se vazio
                pendingDeleteSingleMensalista.set(remoteJid, pendingMens);
                await sock.sendMessage(remoteJid, { text: 'Nome inválido. Digite o nome do mensalista a apagar:' });
                return;
            }
            // verifica existência (case-insensitive)
            db.get(`SELECT 1 FROM participantes WHERE nome = ? COLLATE NOCASE`, [nomeToDelete], async (err, row) => {
                if (err) {
                    await sock.sendMessage(remoteJid, { text: 'Erro ao verificar mensalista.' });
                    return;
                }
                if (!row) {
                    await sock.sendMessage(remoteJid, { text: 'Mensalista não encontrado.' });
                    return;
                }
                // apaga o mensalista
                db.run(`DELETE FROM participantes WHERE nome = ? COLLATE NOCASE`, [nomeToDelete], async (err2) => {
                    if (err2) {
                        await sock.sendMessage(remoteJid, { text: 'Erro ao apagar mensalista.' });
                        return;
                    }
                    const lista = await obterLista();
                    await sock.sendMessage(remoteJid, { text: `Mensalista ${nomeToDelete} apagado.` });
                    await sock.sendMessage(remoteJid, { text: formatarLista(lista) });
                });
            });
            return;
        }
    });
}
// novas funções para convidados
function adicionarConvidado(nome, convidadoPor, callback) {
    db.run(`INSERT INTO convidados(nome, convidado_por) VALUES(?, ?)`, [nome, convidadoPor], callback);
}
function removerConvidado(nome, callback) {
    db.run(`DELETE FROM convidados WHERE nome = ?`, [nome], callback);
}
// <<< inserir as funções abaixo para participantes >>>
function adicionarParticipante(nome, callback) {
    db.run(`INSERT OR IGNORE INTO participantes(nome) VALUES(?)`, [nome], callback);
}
function removerParticipante(nome, callback) {
    db.run(`DELETE FROM participantes WHERE nome = ?`, [nome], callback);
}
// <<< fim inserção >>>
// novas funções para apagar listas
function apagarConvidados(callback) {
    db.run(`DELETE FROM convidados`, [], callback);
}
function apagarMensalistas(callback) {
    db.run(`DELETE FROM participantes`, [], callback);
}
// atualizar obterLista para retornar ambas as listas
function obterLista() {
    return new Promise(async (resolve, reject) => {
        try {
            db.all(`SELECT nome FROM participantes ORDER BY id`, [], (err, rows1) => {
                if (err)
                    return reject(err);
                db.all(`SELECT nome, convidado_por FROM convidados ORDER BY id`, [], (err2, rows2) => {
                    if (err2)
                        return reject(err2);
                    resolve({ participantes: rows1 || [], convidados: rows2 || [] });
                });
            });
        }
        catch (e) {
            reject(e);
        }
    });
}
// formata com Mensalistas e Convidados (ex.: José (Rodrigo))
function formatarLista(data) {
    const { participantes, convidados } = data;
    let texto = `⚽ Lista da Pelada - ${DATA_PELADA}\n\n`;
    texto += 'Mensalistas\n';
    if (!participantes || participantes.length === 0) {
        texto += 'Nenhum participante confirmado.\n\n';
    }
    else {
        participantes.forEach((p, i) => {
            texto += `${i + 1}- ${p.nome}\n`;
        });
        texto += '\n';
    }
    texto += 'Convidados\n';
    if (!convidados || convidados.length === 0) {
        texto += 'Nenhum convidado.\n';
    }
    else {
        convidados.forEach((c, i) => {
            texto += `${i + 1}- ${c.nome} (${c.convidado_por})\n`;
        });
    }
    return texto.trim();
}
function pad(n) { return n.toString().padStart(2, '0'); }
function getNextFriday() {
    const today = new Date();
    const day = today.getDay(); // 0=Sun ... 5=Fri, 6=Sat
    const target = 5; // Friday
    let diff = (target - day + 7) % 7;
    // garante que seja sempre no futuro (próxima sexta)
    if (diff === 0)
        diff = 7;
    const next = new Date(today);
    next.setDate(today.getDate() + diff);
    const d = pad(next.getDate());
    const m = pad(next.getMonth() + 1);
    const y = next.getFullYear();
    return `${d}/${m}/${y}`;
}
const DATA_PELADA = getNextFriday();
// import dinâmico para pacotes ESM
(async () => {
    try {
        const baileys = await import('@whiskeysockets/baileys');
        ({
            default: makeWASocket,
            useMultiFileAuthState,
            DisconnectReason,
            fetchLatestBaileysVersion,
            Browsers
        } = baileys);
        await conectarBot();
        console.log('Bot iniciado');
    }
    catch (err) {
        console.error('Erro ao iniciar o bot:', err);
        process.exit(1);
    }
})();
