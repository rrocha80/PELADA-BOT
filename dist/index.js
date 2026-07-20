import qrcode from 'qrcode-terminal';
import db from './database.js';
import pino from 'pino';
let makeWASocket;
let useMultiFileAuthState;
let DisconnectReason;
let fetchLatestBaileysVersion;
let Browsers;
let generateWAMessageFromContent;
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
// controla quem recebeu a pergunta do churrasco e ainda precisa responder quantidade
const pendingChurrasco = new Map(); // remoteJid -> set(senderJid)
// lista de churrasco por grupo e por usuario (senderJid -> nome/qtd)
const churrascoByGroup = new Map();
let reconnectAttempts = 0;
const CHURRASCO_TITULO = 'Churrasco - 24/07/2026';
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
function allowChurrascoQuantity(remoteJid, senderJid, ttlMs = 5 * 60 * 1000) {
    let set = pendingChurrasco.get(remoteJid);
    if (!set) {
        set = new Set();
        pendingChurrasco.set(remoteJid, set);
    }
    set.add(senderJid);
    setTimeout(() => {
        set.delete(senderJid);
        if (set.size === 0)
            pendingChurrasco.delete(remoteJid);
    }, ttlMs);
}
function upsertChurrasco(remoteJid, senderJid, nome, qtd) {
    let groupList = churrascoByGroup.get(remoteJid);
    if (!groupList) {
        groupList = new Map();
        churrascoByGroup.set(remoteJid, groupList);
    }
    // evita duplicidade por nome no mesmo grupo; se repetir, atualiza a quantidade
    const nomeNormalizado = nome.trim().toLowerCase();
    for (const [existingJid, existing] of groupList.entries()) {
        if (existingJid !== senderJid && existing.nome.trim().toLowerCase() === nomeNormalizado) {
            groupList.delete(existingJid);
        }
    }
    groupList.set(senderJid, { nome, qtd });
}
function formatarListaChurrasco(remoteJid) {
    const groupList = churrascoByGroup.get(remoteJid);
    let texto = `${CHURRASCO_TITULO}\n\n`;
    if (!groupList || groupList.size === 0) {
        texto += 'Nenhuma resposta registrada.';
        return texto;
    }
    const entries = Array.from(groupList.values());
    entries.forEach((item, i) => {
        texto += `${i + 1}- ${item.nome} (${item.qtd})\n`;
    });
    return texto.trim();
}
function removerDoChurrasco(remoteJid, senderJid) {
    const groupList = churrascoByGroup.get(remoteJid);
    if (!groupList)
        return false;
    const removed = groupList.delete(senderJid);
    if (groupList.size === 0) {
        churrascoByGroup.delete(remoteJid);
    }
    return removed;
}
async function conectarBot() {
    const authDir = process.env.AUTH_DIR || 'auth';
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const phoneForPairing = (process.env.PAIRING_PHONE || '').replace(/\D/g, '');
    let pairingCodeIssued = false;
    let pairingCodeInFlight = false;
    let pairingAttempts = 0;
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
        printQRInTerminal: false,
        version,
        // alguns ambientes rejeitam assinatura Desktop/macOS; Chrome em Linux costuma ser mais estavel
        browser: Browsers?.ubuntu ? Browsers.ubuntu('Chrome') : ['Ubuntu', 'Chrome', '120.0.0.0'],
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        retryRequestDelayMs: 1500,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false
    });
    const requestPairingCode = async () => {
        if (!phoneForPairing || state?.creds?.registered || pairingCodeIssued || pairingCodeInFlight)
            return;
        pairingCodeInFlight = true;
        pairingAttempts += 1;
        try {
            const code = await sock.requestPairingCode(phoneForPairing);
            const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
            pairingCodeIssued = true;
            logger.info({ phoneForPairing }, 'Pareamento por codigo habilitado');
            console.log('Codigo de pareamento:', formatted);
        }
        catch (e) {
            logger.error({ e, pairingAttempts }, 'Falha ao gerar codigo de pareamento');
            if (pairingAttempts < 5) {
                setTimeout(() => {
                    requestPairingCode().catch(err => logger.error({ err }, 'Nova tentativa de pareamento por codigo falhou'));
                }, 2000);
            }
        }
        finally {
            pairingCodeInFlight = false;
        }
    };
    // opcional: pareamento por codigo numerico (evita problemas de leitura de QR)
    if (phoneForPairing && !state?.creds?.registered) {
        if (!/^55\d{10,11}$/.test(phoneForPairing)) {
            logger.warn({ phoneForPairing }, 'PAIRING_PHONE parece invalido. Use apenas digitos no formato 55DDDNUMERO.');
        }
        else {
            logger.info({ phoneForPairing }, 'Pareamento por codigo sera solicitado assim que a conexao iniciar.');
        }
    }
    else if (!state?.creds?.registered) {
        logger.info('Defina PAIRING_PHONE=55DDDNUMERO para parear por codigo numerico e evitar falhas no QR.');
    }
    sock.ev.on('creds.update', saveCreds);
    const sendPeladaListMenu = async (jid) => {
        const paramsJson = JSON.stringify({
            title: 'Ver opcoes',
            sections: [
                {
                    title: 'Acoes da pelada',
                    rows: [
                        {
                            id: 'pelada_add',
                            title: '✅ Colocar meu nome na lista',
                            description: 'Confirmar presenca na pelada'
                        },
                        {
                            id: 'pelada_remove',
                            title: '❌ Retirar meu nome da lista',
                            description: 'Remover presenca da lista'
                        },
                        {
                            id: 'pelada_show',
                            title: '📋 Exibir a lista da pelada',
                            description: 'Mostrar mensalistas e convidados'
                        },
                        {
                            id: 'pelada_guest',
                            title: '👤 Incluir convidado',
                            description: 'Adicionar convidado para esta pelada'
                        }
                    ]
                }
            ]
        });
        const content = {
            buttonsMessage: {
                contentText: `⚽ Pelada ${DATA_PELADA}`,
                footerText: 'Toque para selecionar um item.',
                headerType: 1,
                buttons: [
                    {
                        buttonId: 'pelada_menu',
                        type: 2,
                        nativeFlowInfo: {
                            name: 'single_select',
                            paramsJson
                        }
                    }
                ]
            }
        };
        const msg = generateWAMessageFromContent(jid, content, {
            userJid: sock.user?.id
        });
        await sock.relayMessage(jid, msg.message, { messageId: msg.key.id });
    };
    // substitua o handler atual por este (mais verboso e com reconexão)
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            if (phoneForPairing && !state?.creds?.registered && !pairingCodeIssued) {
                requestPairingCode().catch(e => logger.error({ e }, 'Falha ao solicitar codigo de pareamento no evento QR'));
            }
            // mostra ASCII no terminal
            qrcode.generate(qr, { small: true });
            // string bruta do QR (para ambientes onde o ASCII nao aparece bem)
            console.log('QR (url):', qr);
            console.log('Escaneie o QR no app WhatsApp > Dispositivos conectados. Nao cole a string QR (url).');
            logger.info('QR generated');
        }
        logger.info({ connection, lastDisconnect }, 'connection.update');
        if (connection === 'connecting' && phoneForPairing && !state?.creds?.registered && !pairingCodeIssued) {
            setTimeout(() => {
                requestPairingCode().catch(e => logger.error({ e }, 'Falha ao solicitar codigo de pareamento no evento connecting'));
            }, 1500);
        }
        if (connection === 'open') {
            reconnectAttempts = 0;
            logger.info('Bot conectado com sucesso!');
        }
        if (connection === 'close') {
            const err = lastDisconnect?.error;
            logger.warn({ err }, 'connection closed');
            const statusCode = err?.output?.statusCode;
            const conflictType = err?.data?.content?.[0]?.attrs?.type;
            const errMessage = err?.message || err?.toString?.() || '';
            const isLoggedOut = statusCode === DisconnectReason?.loggedOut;
            if (statusCode === 515) {
                logger.info('WhatsApp pediu restart da conexao (515). Reconectando...');
            }
            if (conflictType === 'device_removed' || statusCode === 401) {
                logger.error({ authDir }, 'Dispositivo removido pelo WhatsApp. Remova a sessao em auth e pareie novamente.');
                logger.info('Opcional: use codigo numerico definindo PAIRING_PHONE=55DDDNUMERO.');
                return;
            }
            if (!isLoggedOut) {
                reconnectAttempts += 1;
                const delayMs = Math.min(30000, 2000 * reconnectAttempts);
                logger.warn({ statusCode, errMessage, reconnectAttempts, delayMs }, 'Conexao caiu. Tentando reconectar...');
                if (errMessage.toLowerCase().includes('websocket')) {
                    logger.warn('Falha de WebSocket detectada. Verifique rede/VPN/proxy; o bot continuara tentando reconectar automaticamente.');
                }
                setTimeout(() => conectarBot().catch(e => logger.error({ e }, 'reconnect failed')), delayMs);
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
        const runPeladaAction = async (actionId) => {
            if (actionId === 'pelada_add') {
                adicionarParticipante(msg.pushName || 'Sem Nome', async () => {
                    const lista = await obterLista();
                    await sock.sendMessage(remoteJid, { text: formatarLista(lista) });
                });
                return;
            }
            if (actionId === 'pelada_remove') {
                removerParticipante(msg.pushName || 'Sem Nome', async () => {
                    const lista = await obterLista();
                    await sock.sendMessage(remoteJid, { text: formatarLista(lista) });
                });
                return;
            }
            if (actionId === 'pelada_show') {
                const lista = await obterLista();
                await sock.sendMessage(remoteJid, { text: formatarLista(lista) });
                return;
            }
            if (actionId === 'pelada_guest') {
                pendingConvidado.set(remoteJid, senderJid);
                await sock.sendMessage(remoteJid, { text: 'Digite o nome do convidado:' });
            }
        };
        // tratar clique em template quick reply
        const templateResp = msg.message?.templateButtonReplyMessage;
        if (templateResp) {
            const selectedId = templateResp.selectedId;
            const display = (templateResp.selectedDisplayText || '').toLowerCase();
            const allowed = pendingPelada.get(remoteJid);
            if (!allowed || !allowed.has(senderJid)) {
                await sock.sendMessage(remoteJid, { text: 'Para confirmar, primeiro digite "pelada".' });
                return;
            }
            allowed.delete(senderJid);
            if (allowed.size === 0)
                pendingPelada.delete(remoteJid);
            if (selectedId === 'pelada_add' || display.includes('colocar meu nome na lista')) {
                await runPeladaAction('pelada_add');
            }
            else if (selectedId === 'pelada_remove' || display.includes('retirar meu nome da lista') || display.includes('retiar meu nome da lista')) {
                await runPeladaAction('pelada_remove');
            }
            else if (selectedId === 'pelada_show' || display.includes('exibir a lista da pelada')) {
                await runPeladaAction('pelada_show');
            }
            else if (selectedId === 'pelada_guest' || display.includes('incluir convidado')) {
                await runPeladaAction('pelada_guest');
            }
            return;
        }
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
                await runPeladaAction('pelada_add');
            }
            else if (selectedId === 'pelada_remove' || display.includes('retirar meu nome da lista') || display.includes('retiar meu nome da lista') || selectedId === 'pelada_nao' || display.includes('não') || display.includes('nao')) {
                await runPeladaAction('pelada_remove');
            }
            else if (selectedId === 'pelada_show' || display.includes('exibir a lista da pelada')) {
                await runPeladaAction('pelada_show');
            }
            else if (selectedId === 'pelada_guest' || display.includes('incluir convidado')) {
                await runPeladaAction('pelada_guest');
            }
            return;
        }
        // tratar selecao de lista interativa (listResponseMessage)
        const listResp = msg.message?.listResponseMessage;
        if (listResp) {
            const selectedId = listResp.singleSelectReply?.selectedRowId;
            const selectedTitle = ((listResp.title || '') + ' ' + (listResp.description || '')).toLowerCase();
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
                await runPeladaAction('pelada_add');
            }
            else if (selectedId === 'pelada_remove' || selectedTitle.includes('retirar meu nome da lista') || selectedTitle.includes('retiar meu nome da lista')) {
                await runPeladaAction('pelada_remove');
            }
            else if (selectedId === 'pelada_show' || selectedTitle.includes('exibir a lista da pelada')) {
                await runPeladaAction('pelada_show');
            }
            else if (selectedId === 'pelada_guest' || selectedTitle.includes('incluir convidado')) {
                await runPeladaAction('pelada_guest');
            }
            return;
        }
        // tratar selecao em native flow (single_select)
        const nativeFlowResp = msg.message?.interactiveResponseMessage?.nativeFlowResponseMessage;
        if (nativeFlowResp) {
            const paramsJson = nativeFlowResp.paramsJson || '';
            let selectedId = '';
            try {
                const payload = JSON.parse(paramsJson);
                selectedId =
                    payload?.id ||
                        payload?.selected_id ||
                        payload?.selectedId ||
                        payload?.rowId ||
                        payload?.response_json?.id ||
                        '';
            }
            catch {
                const m = paramsJson.match(/pelada_(add|remove|show|guest)/);
                selectedId = m ? m[0] : '';
            }
            const allowed = pendingPelada.get(remoteJid);
            if (!allowed || !allowed.has(senderJid)) {
                await sock.sendMessage(remoteJid, { text: 'Para confirmar, primeiro digite "pelada".' });
                return;
            }
            allowed.delete(senderJid);
            if (allowed.size === 0)
                pendingPelada.delete(remoteJid);
            if (selectedId === 'pelada_add') {
                await runPeladaAction('pelada_add');
            }
            else if (selectedId === 'pelada_remove') {
                await runPeladaAction('pelada_remove');
            }
            else if (selectedId === 'pelada_show') {
                await runPeladaAction('pelada_show');
            }
            else if (selectedId === 'pelada_guest') {
                await runPeladaAction('pelada_guest');
            }
            return;
        }
        const texto = rawText.toLowerCase();
        const participante = msg.pushName || 'Sem Nome';
        if (texto === 'churrasco') {
            allowChurrascoQuantity(remoteJid, senderJid);
            await sock.sendMessage(remoteJid, { text: 'Quantos convidados voce vai levar?' });
            return;
        }
        if (texto === 'sair churrasco') {
            const removed = removerDoChurrasco(remoteJid, senderJid);
            if (!removed) {
                await sock.sendMessage(remoteJid, { text: 'Voce nao esta na lista do churrasco.' });
                return;
            }
            await sock.sendMessage(remoteJid, { text: formatarListaChurrasco(remoteJid) });
            return;
        }
        if (texto === 'listar churrasco') {
            await sock.sendMessage(remoteJid, { text: formatarListaChurrasco(remoteJid) });
            return;
        }
        const allowedChurrasco = pendingChurrasco.get(remoteJid);
        if (allowedChurrasco && allowedChurrasco.has(senderJid)) {
            const qtd = Number.parseInt(rawText.trim(), 10);
            if (!Number.isFinite(qtd) || qtd < 0) {
                await sock.sendMessage(remoteJid, { text: 'Resposta invalida. Digite apenas um numero de convidados (ex.: 3).' });
                return;
            }
            allowedChurrasco.delete(senderJid);
            if (allowedChurrasco.size === 0)
                pendingChurrasco.delete(remoteJid);
            upsertChurrasco(remoteJid, senderJid, participante, qtd);
            await sock.sendMessage(remoteJid, { text: formatarListaChurrasco(remoteJid) });
            return;
        }
        // quando alguem digita "pelada" envia menu de acoes clicaveis
        if (texto === 'pelada') {
            allowPeladaConfirmation(remoteJid, senderJid);
            try {
                await sendPeladaListMenu(remoteJid);
            }
            catch (e) {
                logger.warn({ e }, 'Falha ao enviar menu native flow. Enviando botoes simples como fallback.');
                await sock.sendMessage(remoteJid, {
                    text: `⚽ Pelada ${DATA_PELADA}`,
                    footer: 'Clique em uma opcao:',
                    buttons: [
                        { buttonId: 'pelada_add', buttonText: { displayText: '✅ Colocar meu nome na lista' }, type: 1 },
                        { buttonId: 'pelada_remove', buttonText: { displayText: '❌ Retirar meu nome da lista' }, type: 1 },
                        { buttonId: 'pelada_show', buttonText: { displayText: '📋 Exibir a lista da pelada' }, type: 1 }
                    ]
                });
                await sock.sendMessage(remoteJid, {
                    text: 'Mais opcoes:',
                    footer: 'Clique em uma opcao:',
                    buttons: [
                        { buttonId: 'pelada_guest', buttonText: { displayText: '👤 Incluir convidado' }, type: 1 }
                    ]
                });
            }
            await sock.sendMessage(remoteJid, {
                text: 'Se os botoes nao aparecerem no seu WhatsApp, responda com:\n' +
                    '1 - Colocar meu nome na lista\n' +
                    '2 - Retirar meu nome da lista\n' +
                    '3 - Exibir a lista da pelada\n' +
                    '4 - Incluir convidado'
            });
            return;
        }
        const allowedByNumber = pendingPelada.get(remoteJid);
        if (allowedByNumber && allowedByNumber.has(senderJid) && ['1', '2', '3', '4'].includes(texto)) {
            allowedByNumber.delete(senderJid);
            if (allowedByNumber.size === 0)
                pendingPelada.delete(remoteJid);
            if (texto === '1') {
                await runPeladaAction('pelada_add');
            }
            else if (texto === '2') {
                await runPeladaAction('pelada_remove');
            }
            else if (texto === '3') {
                await runPeladaAction('pelada_show');
            }
            else if (texto === '4') {
                await runPeladaAction('pelada_guest');
            }
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
    // se hoje for sexta, mantém hoje; senão, usa a próxima sexta
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
            Browsers,
            generateWAMessageFromContent
        } = baileys);
        await conectarBot();
        console.log('Bot iniciado');
    }
    catch (err) {
        console.error('Erro ao iniciar o bot:', err);
        process.exit(1);
    }
})();
