import qrcode from 'qrcode-terminal';
import db from './database';
let makeWASocket;
let useMultiFileAuthState;
let DisconnectReason;
const GRUPO_NOME = 'PELADA';
const DATA_PELADA = '15/05/2026';
async function conectarBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth');
    const sock = makeWASocket({
        auth: state
    });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', ({ connection, qr }) => {
        if (qr)
            qrcode.generate(qr, { small: true });
        if (connection === 'open')
            console.log('Bot conectado com sucesso!');
    });
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages?.[0];
        if (!msg?.message)
            return;
        const remoteJid = msg.key.remoteJid;
        if (!remoteJid || !remoteJid.includes('@g.us'))
            return;
        const texto = (msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            '').trim().toLowerCase();
        const participante = msg.pushName || 'Sem Nome';
        if (texto === 'pelada') {
            await sock.sendMessage(remoteJid, {
                text: `⚽ Confirme participação na pelada do dia ${DATA_PELADA}

Digite:
SIM
ou
NÃO`
            });
            return;
        }
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
    });
}
function adicionarParticipante(nome, callback) {
    db.run(`INSERT OR IGNORE INTO participantes(nome) VALUES(?)`, [nome], callback);
}
function removerParticipante(nome, callback) {
    db.run(`DELETE FROM participantes WHERE nome = ?`, [nome], callback);
}
function obterLista() {
    return new Promise((resolve, reject) => {
        db.all(`SELECT nome FROM participantes ORDER BY id`, [], (err, rows) => {
            if (err)
                reject(err);
            else
                resolve(rows);
        });
    });
}
function formatarLista(lista) {
    let texto = `⚽ Lista da Pelada — ${DATA_PELADA}\n\n`;
    if (!lista || lista.length === 0) {
        texto += 'Nenhum participante confirmado.';
        return texto;
    }
    lista.forEach((p, index) => {
        texto += `${index + 1}. ${p.nome}\n`;
    });
    return texto;
}
// import dinâmico para pacotes ESM
(async () => {
    try {
        const baileys = await import('@whiskeysockets/baileys');
        ({ default: makeWASocket, useMultiFileAuthState, DisconnectReason } = baileys);
        await conectarBot();
        console.log('Bot iniciado');
    }
    catch (err) {
        console.error('Erro ao iniciar o bot:', err);
        process.exit(1);
    }
})();
