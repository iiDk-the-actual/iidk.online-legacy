const http = require('http');
const https = require('https');
const fs = require('fs').promises;
const WebSocket = require('ws');
const crypto = require('crypto');
const { exec, execFile } = require('child_process');
const flite = require('flite');
const util = require('util');
const sqlite3 = require("sqlite3").verbose();

const execPromise = util.promisify(exec);
const execFilePromise = util.promisify(execFile);

const db = new sqlite3.Database("/mnt/external/site-data/records.db");
const dbGet = util.promisify(db.get.bind(db));
const dbAll = util.promisify(db.all.bind(db));
const dbRun = util.promisify(db.run.bind(db));

db.configure("busyTimeout", 1000);
db.on('profile', (sql, time) => {
    if (time > 300) {
        console.log(`Slow SQL (${time}ms)`);
    }
});

let bannedIds = [];
let DISCORD_WEBHOOK_URL = '';
let SYNCDATA_WEBHOOK_URL = '';
let BANDATA_WEBHOOK_URL = '';
let SECRET_KEY = '';
let HASH_KEY = '';
let votesObj = { "a-votes": [], "b-votes": [] };
let serverData = '{"error":"No data"}';
let playerIdMap = {};

const filePath = '/home/iidk/site/votes.json';

async function initializeFriendDatabase() {
    await dbRun(`
        CREATE TABLE IF NOT EXISTS user_data (
            ip_hash TEXT PRIMARY KEY,
            userid TEXT NOT NULL,
            last_seen INTEGER NOT NULL
        )
    `);
    
    await dbRun(`
        CREATE INDEX IF NOT EXISTS idx_userid ON user_data(userid)
    `);
    
    await dbRun(`
        CREATE TABLE IF NOT EXISTS friendships (
            user_hash TEXT NOT NULL,
            friend_hash TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('friend', 'outgoing', 'incoming')),
            created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
            PRIMARY KEY (user_hash, friend_hash, status)
        )
    `);
    
    await dbRun(`
        CREATE INDEX IF NOT EXISTS idx_friend_lookup ON friendships(friend_hash, status)
    `);

    // del old friend data
    const oneMonthAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    
    try {
        const result = await dbRun(`
            DELETE FROM friendships 
            WHERE created_at < ?
        `, [oneMonthAgo]);
        
        console.log(`Cleaned up old friendships (older than 1 month)`);
    } catch (err) {
        console.error('Error cleaning up old friendships:', err.message);
    }
}

async function areFriends(userHash, friendHash) {
    try {
        const friendship = await dbGet(`
            SELECT 1 FROM friendships 
            WHERE user_hash = ? AND friend_hash = ? AND status = 'friend'
            LIMIT 1
        `, [userHash, friendHash]);
        
        return !!friendship;
    } catch (err) {
        console.error('Error checking friendship:', err.message);
        return false;
    }
}

async function initialize() {
    try {
        DISCORD_WEBHOOK_URL = (await fs.readFile('/home/iidk/site/webhook.txt', 'utf8')).trim();
        console.log('Set webhook');
    } catch (e) {
        console.log('Webhook file does not exist.');
    }

    try {
        SYNCDATA_WEBHOOK_URL = (await fs.readFile('/home/iidk/site/syncwebhook.txt', 'utf8')).trim();
        console.log('Set syncwebhook');
    } catch (e) {
        console.log('Syncwebhook file does not exist.');
    }
    
    try {
        BANDATA_WEBHOOK_URL = (await fs.readFile('/home/iidk/site/banwebhook.txt', 'utf8')).trim();
        console.log('Set banwebhook');
    } catch (e) {
        console.log('Banwebhook file does not exist.');
    }

    try {
        SECRET_KEY = (await fs.readFile('/home/iidk/site/secret.txt', 'utf8')).trim();
        console.log('Set secret');
    } catch (e) {
        console.log('Secret file does not exist.');
    }

    try {
        HASH_KEY = (await fs.readFile('/home/iidk/site/hashsecret.txt', 'utf8')).trim();
        console.log('Set hash');
    } catch (e) {
        console.log('Hash file does not exist.');
    }
    
    try {
        const votes = (await fs.readFile(filePath, 'utf8')).trim();
        votesObj = JSON.parse(votes);
        console.log('Set votes');
    } catch (e) {
        console.log('Votes file does not exist or is invalid, initializing.');
        votesObj = { "a-votes": [], "b-votes": [] };
    }

    async function writeVotesToFile() {
        try {
            await fs.writeFile(filePath, JSON.stringify(votesObj, null, 2), 'utf8');
            console.log(`File written successfully at ${new Date().toLocaleTimeString()}`);
        } catch (error) {
            console.error('Error writing file:', error);
        }
    }

    setInterval(writeVotesToFile, 60000);

    function cleanupOldTimestamps() {
        const now = Date.now();
        const oneHour = 60 * 60 * 1000;
        
        console.log('Running hourly cleanup...');

        for (const ip in ipRequestTimestamps) {
            if (now - ipRequestTimestamps[ip] > oneHour) {
                delete ipRequestTimestamps[ip];
            }
        }

        for (const ip in syncDataRequestTimestamps) {
            if (now - syncDataRequestTimestamps[ip] > oneHour) {
                delete syncDataRequestTimestamps[ip];
            }
        }

        for (const ip in voteDelay) {
            if (now - voteDelay[ip] > (2 * oneHour)) {
                delete voteDelay[ip];
            }
        }

        for (const ip in ttsRequestTimestamps) {
            if (now - ttsRequestTimestamps[ip] > oneHour) {
                delete ttsRequestTimestamps[ip];
            }
        }

        for (const ip in getFriendTime) {
            if (now - getFriendTime[ip] > oneHour) {
                delete getFriendTime[ip];
            }
        }

        for (const ip in friendModifyTime) {
            if (now - friendModifyTime[ip] > oneHour) {
                delete friendModifyTime[ip];
            }
        }

        for (const ip in bannedIps) {
            if (now - bannedIps[ip] > oneHour) {
                delete bannedIps[ip];
            }
        }

        for (const dir in activeRooms) {
            if (now - activeRooms[dir].timestamp > (30 * 60 * 1000)) {
                delete activeRooms[dir];
            }
        }

        for (const dir in activeUserData) {
            if (now - activeUserData[dir].timestamp > (30 * 60 * 1000)) {
                delete activeUserData[dir];
            }
        }

        for (const ipHash in ipTelemetryLock) {
            if (now - ipTelemetryLock[ipHash].timestamp > (2 * oneHour)) {
                delete ipTelemetryLock[ipHash];
            }
        }

        for (const ip in socketDelay) {
            if (now - socketDelay[ip] > oneHour) {
                delete socketDelay[ip];
            }
        }

        for (const ip in joinDelay) {
            if (now - joinDelay[ip] > oneHour) {
                delete joinDelay[ip];
            }
        }
        
        console.log('Hourly cleanup completed');
    }

    setInterval(cleanupOldTimestamps, 60 * 60 * 1000);

    await updateServerData();

    try {
        const fileContent = (await fs.readFile('/home/iidk/site/playerids.txt', 'utf8')).trim();
        const lines = fileContent.split('\n');
        for (const line of lines) {
            const [id, name] = line.split(';');
            if (id && name) {
                playerIdMap[id.trim()] = name.trim();
            }
        }
        console.log('Loaded playerIdMap');
    } catch (e) {
        console.log('Player IDs file does not exist.');
    }
    
    try {
        const fileContent = (await fs.readFile('/home/iidk/site/bannedids.txt', 'utf8')).trim();
        bannedIds = fileContent.split('\n').filter(id => id);
        console.log('Loaded banned ids');
    } catch (e) {
        console.log('Banned IDs file does not exist.');
    }

    await initializeFriendDatabase();
    console.log('Friend database initialized');
}

async function incrementVote(option, userId) {
    if (option !== 'a-votes' && option !== 'b-votes') {
        throw new Error('Must be "a-votes" or "b-votes"');
    }

    if (votesObj['a-votes'].includes(userId) || votesObj['b-votes'].includes(userId)) {
        console.log(`User ${userId} has already voted.`);
        return false;
    }

    const totalVotes = votesObj['a-votes'].length + votesObj['b-votes'].length;
    if (totalVotes < 10000) {
        votesObj[option].push(userId);
    }

    console.log(`User ${userId} voted for ${option}`);
    return true;
}

async function resetVotes() {
    votesObj = { "a-votes": [], "b-votes": [] };
    console.log('Votes have been reset');
}

function getVoteCounts() {
    return JSON.stringify({
        "a-votes": votesObj["a-votes"].length,
        "b-votes": votesObj["b-votes"].length
    });
}

function hashIpAddr(ip) { // TODO: salt
    const h = crypto.createHmac('sha256', HASH_KEY).update(ip).digest();
    return h.toString('hex');
}

async function updateServerData() {
    try {
        serverData = await fs.readFile('/home/iidk/site/serverdata.json', 'utf8');
        console.log('Loaded serverdata');
    } catch (e) {
        serverData = '{"error":"No data"}';
        console.log('serverdata.json not found, using default.');
    }
}

const ipRequestTimestamps = {};
const syncDataRequestTimestamps = {};
const voteDelay = {};
const ttsRequestTimestamps = {};
const getFriendTime = {};
const friendModifyTime = {};
const bannedIps = {};
const activeRooms = {};
const activeUserData = {};

function cleanAndFormatData(data) {
    const cleanedData = {};
    cleanedData.directory = data.directory.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 12);
    cleanedData.identity = data.identity.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 12);
    cleanedData.region = data.region.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 3);
    cleanedData.userid = data.userid.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 20);
    cleanedData.isPrivate = data.isPrivate;
    cleanedData.playerCount = Math.min(Math.max(data.playerCount, -1), 10);
    cleanedData.gameMode = data.gameMode.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 128);
    cleanedData.consoleVersion = data.consoleVersion.slice(0, 8);
    cleanedData.menuName = data.menuName.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
    cleanedData.menuVersion = data.menuVersion.slice(0, 8);
    return cleanedData;
}

async function cleanAndFormatSyncData(data) {
    const cleanedData = {};
    cleanedData.directory = data.directory.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 12);
    cleanedData.region = data.region.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 3);
    cleanedData.data = {};
    let count = 0;

    for (let userId in data.data) {
        if (count >= 20) break;
        const user = data.data[userId];
        const newUserId = userId.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 20);
        user.nickname = user.nickname.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 12);
        user.cosmetics = user.cosmetics.toUpperCase().slice(0, 12000);
        let color = user.color !== undefined ? user.color : "NULL";
        user.color = color.slice(0, 20);
        let platform = user.platform !== undefined ? user.platform : "NULL";
        user.platform = platform.slice(0, 5);
        cleanedData.data[newUserId] = user;
        count++;
    }

    for (const userId in cleanedData.data) {
        if (isInvalidId(userId))
            return;
        
        const user = cleanedData.data[userId];
        writeRecordAutoRaw(userId, user.nickname, cleanedData.directory, user.cosmetics, user.color, user.platform, Date.now());

        try {
            const cosmeticsMap = {
                "LBADE.": "FINGER PAINTER BADGE", "LBAAK.": "MOD STICK", "LBAAD.": "ADMINISTRATOR BADGE",
                "LBAGS.": "ILLUSTRATOR BADGE", "LMAPY.": "FOREST GUIDE MOD STICK", "LBANI.": "AA CREATOR BADGE"
            };
            const substrings = Object.keys(cosmeticsMap);
            const foundSubstrings = substrings.filter(sub => user.cosmetics.includes(sub));

            if (foundSubstrings.length > 0) {
                const foundString = foundSubstrings.map(sub => `${sub} : ${cosmeticsMap[sub]}`).join(", ");
                sendToSyncWebhook(cleanedData.directory, userId, foundString, user.cosmetics, user.nickname, user.color, user.platform);
            }
            if (playerIdMap[userId]) {
                sendToSyncWebhookID(cleanedData.directory, userId, playerIdMap[userId], user.nickname, user.color, user.platform);
            }
        } catch (err) {
            console.error('Error checking for special cosmetics:', err.message);
        }
    }
    return cleanedData;
}

async function addAdmin(name, userId) {
    try {
        const rawData = await fs.readFile("/home/iidk/site/serverdata.json", "utf8");
        const serverdata = JSON.parse(rawData);
        if (!Array.isArray(serverdata.admins)) return false;
        serverdata.admins.push({ name, "user-id": userId });
        await fs.writeFile("/home/iidk/site/serverdata.json", JSON.stringify(serverdata, null, 2), "utf8");
        await updateServerData();
        return true;
    } catch (err) {
        console.log(err.toString());
        return false;
    }
}

async function removeAdmin(userId) {
    try {
        const rawData = await fs.readFile("/home/iidk/site/serverdata.json", "utf8");
        const serverdata = JSON.parse(rawData);
        if (!Array.isArray(serverdata.admins)) return false;
        const originalLength = serverdata.admins.length;
        serverdata.admins = serverdata.admins.filter(admin => admin["user-id"] !== userId);
        if (serverdata.admins.length === originalLength) return false;
        await fs.writeFile("/home/iidk/site/serverdata.json", JSON.stringify(serverdata, null, 2), "utf8");
        await updateServerData();
        return true;
    } catch (err) {
        return false;
    }
}

async function addPatreon(userId, discordId, name, icon) {
    try {
        const rawData = await fs.readFile("/home/iidk/site/serverdata.json", "utf8");
        const serverdata = JSON.parse(rawData);
        if (!Array.isArray(serverdata.patreon)) return false;

        const newEntry = {
            "user-id": userId,
            "discord-id": discordId,
            name,
            "photo": icon
        };

        const index = serverdata.patreon.findIndex(
            p => p["discord-id"] === discordId
        );

        if (index !== -1) {
            serverdata.patreon[index] = newEntry;
        } else {
            serverdata.patreon.push(newEntry);
        }

        await fs.writeFile(
            "/home/iidk/site/serverdata.json",
            JSON.stringify(serverdata, null, 2),
            "utf8"
        );

        await updateServerData();
        return true;
    } catch (err) {
        console.log(err.toString());
        return false;
    }
}

async function removePatreon(discordId) {
    try {
        const rawData = await fs.readFile("/home/iidk/site/serverdata.json", "utf8");
        const serverdata = JSON.parse(rawData);
        if (!Array.isArray(serverdata.patreon)) return false;
        const originalLength = serverdata.patreon.length;
        serverdata.patreon = serverdata.patreon.filter(admin => admin["discord-id"] !== discordId);
        if (serverdata.patreon.length === originalLength) return false;
        await fs.writeFile("/home/iidk/site/serverdata.json", JSON.stringify(serverdata, null, 2), "utf8");
        await updateServerData();
        return true;
    } catch (err) {
        return false;
    }
}

async function setPoll(poll, a, b) {
    try {
        const rawData = await fs.readFile("/home/iidk/site/serverdata.json", "utf8");
        const serverdata = JSON.parse(rawData);
        serverdata.poll = poll;
        serverdata["option-a"] = a;
        serverdata["option-b"] = b;
        await fs.writeFile("/home/iidk/site/serverdata.json", JSON.stringify(serverdata, null, 2), "utf8");
        await updateServerData();
        await resetVotes();
        return true;
    } catch (err) {
        console.log(err.toString());
        return false;
    }
}

/*
async function processBanData(data, ipHash) {
    const cleanedData = {};
    cleanedData.error = data.error.replace(/[^a-zA-Z0-9 ]/g, '').toUpperCase().slice(0, 512);
    cleanedData.version = data.version.slice(0, 8);
    cleanedData.data = [];
    let count = 0;
    for (let i = 0; i < data.data.length; i++) {
        if (count >= 512) break;
        let value = data.data[i].replace(/[^a-zA-Z0-9 ]/g, '').toUpperCase().slice(0, 128);
        cleanedData.data.push(value);
    }
    if (!cleanedData.error.includes("YOUR ACCOUNT")) return;
    try {
        sendToBanWebhook(cleanedData.error, cleanedData.version, cleanedData.data, ipHash);
    } catch (err) {
        console.error('Error sending ban report:', err.message);
    }
    return cleanedData;
}
    */

function isInvalidId(id) {
  const isShort = id.length <= 10;
  const hasLowercase = /[a-z]/.test(id);
  const hasInvalidChars = /[^0-9A-F]/.test(id);

  return isShort || hasLowercase || hasInvalidChars;
}

function isAdmin(id) {
    try {
        const parsedServerData = JSON.parse(serverData);
        return Array.isArray(parsedServerData?.admins) &&
            parsedServerData.admins.some(admin => admin["user-id"] === id);
    } catch {
        return false;
    }
}

function formatTimestamp(timestamp) {
    const date = new Date(timestamp);
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const monthName = months[date.getMonth()];
    const day = date.getDate();
    const year = date.getFullYear();
    let hours = date.getHours();
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12;
    return `${monthName} ${day}, ${year} at ${hours}:${minutes}:${seconds} ${ampm}`;
}

let syncDataDelay = Date.now();
let syncStringAddon = "";
function sendToDiscordWebhook(data) {
    if (isInvalidId(data.userid))
        return;
    
    const targetText = `New connection received\n> Room Data: \`${data.directory}\` \`${data.region}\` \`${data.gameMode}\` \`${data.isPrivate ? "Public" : "Private"}\` \`${data.playerCount.toString()} Players\`\n> User Data: \`${data.identity}\` \`${data.userid}\` \`Console ${data.consoleVersion}\` \`${data.menuName} ${data.menuVersion}\``;
    if (Date.now() - syncDataDelay < 5000) {
        syncStringAddon += targetText + "\n\n";
    } else {
        syncDataDelay = Date.now();
        let content = syncStringAddon ? `${targetText}\n\n${syncStringAddon}` : targetText;
        syncStringAddon = "";
        const webhookData = JSON.stringify({ content });
        const url = new URL(DISCORD_WEBHOOK_URL);
        const options = { hostname: url.hostname, path: url.pathname + url.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': webhookData.length } };
        const req = https.request(options, res => res.on('data', chunk => console.log(`Response: ${chunk.toString()}`)));
        req.on('error', error => console.error(`Error sending to webhook: ${error.message}`));
        req.write(webhookData);
        req.end();
    }
}

let syncDataDelay2 = Date.now();
let syncStringAddon2 = "";
function sendToSyncWebhook(room, uidfound, cosmeticfound, concat, nickfound, color, platform) {
    if (isAdmin(uidfound) || bannedIds.includes(uidfound) || bannedIds.includes(nickfound)) return;
    const targetText = concat.length >= 6277 ? `-# Cosmetx user ${nickfound} found in ${room} : ${cosmeticfound} ${concat.length}` : `# Special User Found\n> Room Data: \`${room}\`\n> User Data: \`Name: ${nickfound}\` \`User ID: ${uidfound}\` \`Color: ${color}\` \`Platform: ${platform}\` \`Cosmetics: ${cosmeticfound} (concat length: ${concat.length})\`\n||<@&1189695503399649280>||`;
    if (Date.now() - syncDataDelay2 < 5000) {
        syncStringAddon2 += targetText + "\n\n";
    } else {
        syncDataDelay2 = Date.now();
        let content = syncStringAddon2 ? `${targetText}\n\n${syncStringAddon2}` : targetText;
        syncStringAddon2 = "";
        const webhookData = JSON.stringify({ content });
        const url = new URL(SYNCDATA_WEBHOOK_URL);
        const options = { hostname: url.hostname, path: url.pathname + url.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': webhookData.length } };
        const req = https.request(options, res => res.on('data', chunk => console.log(`Response: ${chunk.toString()}`)));
        req.on('error', error => console.error(`Error sending to webhook: ${error.message}`));
        req.write(webhookData);
        req.end();
    }
}

function sendToSyncWebhookID(room, uidfound, userfound, nickfound, color, platform) {
    const targetText = `# ${userfound} Found\n> Room Data: \`${room}\`\n> User Data: \`Name: ${nickfound}\` \`User ID: ${uidfound}\` \`Color: ${color}\` \`Platform: ${platform}\`\n||<@&1189695503399649280>||`;
    if (Date.now() - syncDataDelay2 < 5000) {
        syncStringAddon2 += targetText + "\n\n";
    } else {
        syncDataDelay2 = Date.now();
        let content = syncStringAddon2 ? `${targetText}\n\n${syncStringAddon2}` : targetText;
        syncStringAddon2 = "";
        const webhookData = JSON.stringify({ content });
        const url = new URL(SYNCDATA_WEBHOOK_URL);
        const options = { hostname: url.hostname, path: url.pathname + url.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': webhookData.length } };
        const req = https.request(options, res => res.on('data', chunk => console.log(`Response: ${chunk.toString()}`)));
        req.on('error', error => console.error(`Error sending to webhook: ${error.message}`));
        req.write(webhookData);
        req.end();
    }
}

/*
function sendToBanWebhook(error, version, data, ipHash) {
    const targetText = `# Ban Report\n> Ban Message: ${error}\n> Version: ${version}\n-# Enabled Mods: ${data.toString().slice(0, 1024)}${data.toString().length >= 1024 ? "..." : ""}\n-# Report Request ID: ${ipHash}`;
    const webhookData = JSON.stringify({ content: targetText });
    const url = new URL(BANDATA_WEBHOOK_URL);
    const options = { hostname: url.hostname, path: url.pathname + url.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': webhookData.length } };
    const req = https.request(options, res => res.on('data', chunk => console.log(`Response: ${chunk.toString()}`)));
    req.on('error', error => console.error(`Error sending to webhook: ${error.message}`));
    req.write(webhookData);
    req.end();
}
    */

const recordCache = [];
const MAX_CACHE_SIZE = 100;

function writeRecordAutoRaw(id, nickname, room, cosmetics, color = null, platform = null, timestamp = null) {
    if (!timestamp) timestamp = Date.now();
    const record = { id, nickname, room, cosmetics, color, platform, timestamp };
    record.raw_json = JSON.stringify(record);
    recordCache.push(record);
    if (recordCache.length >= MAX_CACHE_SIZE) {
        flushCacheToDB();
    }
}

let isFlushing = false;
async function flushCacheToDB() {
    if (!recordCache || recordCache.length === 0 || isFlushing) return;

    console.log("Attempting to flush cache");

    const records = [...recordCache];
    recordCache.length = 0;

    isFlushing = true;
    try {
        const stmt = db.prepare(`
            INSERT INTO records (id, nickname, room, cosmetics, color, platform, timestamp, raw_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id, room) DO UPDATE SET
                nickname = excluded.nickname, cosmetics = excluded.cosmetics, color = excluded.color,
                platform = excluded.platform, timestamp = excluded.timestamp, raw_json = excluded.raw_json
        `);
        const stmtRun = util.promisify(stmt.run.bind(stmt));
        const stmtFinalize = util.promisify(stmt.finalize.bind(stmt));

        try {
            await dbRun("BEGIN TRANSACTION");
            for (const r of records) {
                // console.log("Adding data ",r.nickname,r.id);
                await stmtRun([r.id, r.nickname, r.room, r.cosmetics, r.color, r.platform, r.timestamp, r.raw_json]);
            }
            await stmtFinalize();
            await dbRun("COMMIT");
            console.log(`Flushed ${records.length} records to the database.`);
        } catch (err) {
            console.error("SQLite transaction error:", err.message);
            await dbRun("ROLLBACK").catch(e => console.error("Rollback failed:", e.message));
        }
    } catch (err) {
        console.error("SQlite pre transaction error:", err.message);
    }

    isFlushing = false;
}

setInterval(() => {
    if (recordCache.length > 0) {
        const cacheToFlush = [...recordCache];
        recordCache.length = 0;
        flushCacheToDB(cacheToFlush);
    }
}, 30000);

process.on('exit', () => flushCacheToDB(recordCache));
process.on('SIGINT', () => { flushCacheToDB(recordCache).then(() => process.exit(0)); });
process.on('SIGTERM', () => { flushCacheToDB(recordCache).then(() => process.exit(0)); });

const cache = {};
const CACHE_TTL = 60 * 1000;

async function getLatestRecordById(id) {
    const now = Date.now();
    if (cache[id] && (now - cache[id].timestamp < CACHE_TTL)) {
        return cache[id].data;
    }
    const sql = `SELECT raw_json FROM records WHERE id = ? ORDER BY timestamp DESC LIMIT 1`;
    try {
        const row = await dbGet(sql, [id]);
        if (!row) return null;
        const parsed = JSON.parse(row.raw_json);
        cache[id] = { timestamp: now, data: parsed };
        return parsed;
    } catch (err) {
        console.error("SQLite error:", err.message);
        return null;
    }
}

async function getLatestRecordsByIds(ids) {
    const now = Date.now();
    const results = {};
    const idsToQuery = [];
    ids.forEach(id => {
        if (cache[id] && (now - cache[id].timestamp < CACHE_TTL)) {
            results[id] = cache[id].data;
        } else {
            idsToQuery.push(id);
        }
    });

    if (idsToQuery.length === 0) return results;

    const placeholders = idsToQuery.map(() => '?').join(',');
    const sql = `
        SELECT r1.id, r1.raw_json FROM records r1
        INNER JOIN (SELECT id, MAX(timestamp) AS max_ts FROM records WHERE id IN (${placeholders}) GROUP BY id) r2
        ON r1.id = r2.id AND r1.timestamp = r2.max_ts`;

    try {
        const rows = await dbAll(sql, idsToQuery);
        rows.forEach(row => {
            try {
                const parsed = JSON.parse(row.raw_json);
                results[row.id] = parsed;
                cache[row.id] = { timestamp: now, data: parsed };
            } catch (e) {
                results[row.id] = null;
            }
        });
        idsToQuery.forEach(id => { if (!(id in results)) results[id] = null; });
        return results;
    } catch (err) {
        console.error("SQLite error:", err.message);
        idsToQuery.forEach(id => results[id] = null);
        return results;
    }
}

const ipTelemetryLock = {};
const telemTimeout = 60 * 60 * 1000; // 1hr

function canWriteTelemData(ipHash, userId) {
    const now = Date.now();
    const lock = ipTelemetryLock[ipHash];
    if (lock && (now - lock.timestamp < telemTimeout) && lock.userId !== userId) {
        return false;
    }
    ipTelemetryLock[ipHash] = { userId, timestamp: now };
    return true;
}

const userDataCache = new Map();
const friendshipCache = new Map();
const userDataWriteQueue = [];
const MAX_USER_DATA_QUEUE = 100;
const USER_DATA_CACHE_TTL = 5 * 60 * 1000;

setInterval(async () => {
    if (userDataWriteQueue.length > 0) {
        await flushUserDataQueue();
    }
}, 15000);

process.on('exit', () => flushUserDataQueue());
process.on('SIGINT', () => { flushUserDataQueue().then(() => process.exit(0)); });
process.on('SIGTERM', () => { flushUserDataQueue().then(() => process.exit(0)); });

async function flushUserDataQueue() {
    if (userDataWriteQueue.length === 0 || isFlushing) return;

    console.log("Attempting to flush user data");

    isFlushing = true;
    const queueToFlush = [...userDataWriteQueue];
    userDataWriteQueue.length = 0;

    try {
        const stmt = db.prepare(`
            INSERT INTO user_data (ip_hash, userid, last_seen)
            VALUES (?, ?, ?)
            ON CONFLICT(ip_hash) DO UPDATE SET
                userid = excluded.userid,
                last_seen = excluded.last_seen
        `);
        const stmtRun = util.promisify(stmt.run.bind(stmt));
        const stmtFinalize = util.promisify(stmt.finalize.bind(stmt));

        await dbRun("BEGIN TRANSACTION");
        for (const entry of queueToFlush) {
            await stmtRun([entry.ipHash, entry.userid, entry.lastSeen]);
        }
        await stmtFinalize();
        await dbRun("COMMIT");
        console.log(`Flushed ${queueToFlush.length} user_data entries to database.`);
    } catch (err) {
        console.error("User data flush error:", err.message);
        await dbRun("ROLLBACK").catch(e => console.error("Rollback failed:", e.message));
    }

    isFlushing = false;
}

/*
async function writeTelemData(userid, ipHash, timestamp) {
    await dbRun(`
        INSERT INTO user_data (ip_hash, userid, last_seen)
        VALUES (?, ?, ?)
        ON CONFLICT(ip_hash) DO UPDATE SET
            userid = excluded.userid,
            last_seen = excluded.last_seen
    `, [ipHash, userid, timestamp]);
}
*/

async function writeTelemData(userid, ipHash, timestamp) {
    userDataCache.set(ipHash, {
        userid,
        lastSeen: timestamp,
        cachedAt: Date.now()
    });

    userDataWriteQueue.push({ ipHash, userid, lastSeen: timestamp });

    if (userDataWriteQueue.length >= MAX_USER_DATA_QUEUE) {
        await flushUserDataQueue();
    }
}

// Helper: Get ipHash from userid (checks cache first)
async function getIpHashByUserId(userid) {
    // Check cache first
    for (const [ipHash, data] of userDataCache.entries()) {
        if (data.userid === userid && (Date.now() - data.cachedAt) < USER_DATA_CACHE_TTL) {
            return ipHash;
        }
    }

    // Cache miss - query database
    const row = await dbGet(`
        SELECT ip_hash FROM user_data WHERE userid = ? ORDER BY last_seen DESC LIMIT 1
    `, [userid]);

    // Update cache if found
    if (row) {
        userDataCache.set(row.ip_hash, {
            userid,
            lastSeen: Date.now(),
            cachedAt: Date.now()
        });
    }

    return row?.ip_hash || null;
}

// Helper: Get userid from ipHash (checks cache first)
async function getUserIdByIpHash(ipHash) {
    // Check cache first
    const cached = userDataCache.get(ipHash);
    if (cached && (Date.now() - cached.cachedAt) < USER_DATA_CACHE_TTL) {
        return cached.userid;
    }

    // Cache miss - query database
    const row = await dbGet(`
        SELECT userid FROM user_data WHERE ip_hash = ? LIMIT 1
    `, [ipHash]);

    // Update cache if found
    if (row) {
        userDataCache.set(ipHash, {
            userid: row.userid,
            lastSeen: Date.now(),
            cachedAt: Date.now()
        });
    }

    return row?.userid || null;
}

// Helper: Check if user exists in database (checks cache first)
async function userExists(ipHash) {
    // Check cache first
    if (userDataCache.has(ipHash)) {
        const cached = userDataCache.get(ipHash);
        if ((Date.now() - cached.cachedAt) < USER_DATA_CACHE_TTL) {
            return true;
        }
    }

    // Cache miss - query database
    const row = await dbGet(`
        SELECT 1 FROM user_data WHERE ip_hash = ? LIMIT 1
    `, [ipHash]);

    return !!row;
}

// Helper: Check if two users are friends (with caching)
async function areFriends(userHash, friendHash) {
    const cacheKey = `${userHash}:${friendHash}`;
    
    // Check cache first
    const cached = friendshipCache.get(cacheKey);
    if (cached && (Date.now() - cached.cachedAt) < USER_DATA_CACHE_TTL) {
        return cached.isFriend;
    }

    try {
        const friendship = await dbGet(`
            SELECT 1 FROM friendships 
            WHERE user_hash = ? AND friend_hash = ? AND status = 'friend'
            LIMIT 1
        `, [userHash, friendHash]);
        
        const isFriend = !!friendship;

        // Update cache
        friendshipCache.set(cacheKey, {
            isFriend,
            cachedAt: Date.now()
        });

        return isFriend;
    } catch (err) {
        console.error('Error checking friendship:', err.message);
        return false;
    }
}

function invalidateFriendshipCache(userHash, friendHash) {
    friendshipCache.delete(`${userHash}:${friendHash}`);
    friendshipCache.delete(`${friendHash}:${userHash}`);
}

setInterval(() => {
    const now = Date.now();

    for (const [key, value] of userDataCache.entries()) {
        if (now - value.cachedAt > USER_DATA_CACHE_TTL) {
            userDataCache.delete(key);
        }
    }

    for (const [key, value] of friendshipCache.entries()) {
        if (now - value.cachedAt > USER_DATA_CACHE_TTL) {
            friendshipCache.delete(key);
        }
    }
}, 60000);

async function getFriendsData(ipHash) {
    const returnData = { friends: {}, incoming: {}, outgoing: {} };

    if (!await userExists(ipHash)) {
        return returnData;
    }

    const friendships = await dbAll(`
        SELECT friend_hash, status FROM friendships WHERE user_hash = ?
    `, [ipHash]);

    if (friendships.length === 0) {
        return returnData;
    }

    const friendHashes = friendships.map(f => f.friend_hash);

    const placeholders = friendHashes.map(() => '?').join(',');
    const friendUserData = await dbAll(`
        SELECT ip_hash, userid FROM user_data WHERE ip_hash IN (${placeholders})
    `, friendHashes);

    const hashToUserId = {};
    friendUserData.forEach(row => {
        hashToUserId[row.ip_hash] = row.userid;
    });

    const userIds = Object.values(hashToUserId);
    if (userIds.length === 0) {
        return returnData;
    }

    const records = await getLatestRecordsByIds(userIds);

    friendships.forEach(friendship => {
        const friendHash = friendship.friend_hash;
        const friendUserId = hashToUserId[friendHash];
        if (!friendUserId) return;

        const record = records[friendUserId];
        const online = isUserOnline(friendHash);

        const userData = {
            currentName: record?.nickname || null,
            currentUserID: record?.id || null
        };

        if (friendship.status === 'friend') {
            returnData.friends[friendHash] = {
                online,
                currentRoom: online ? (record?.room || "") : "",
                ...userData
            };
        } else if (friendship.status === 'incoming') {
            returnData.incoming[friendHash] = userData;
        } else if (friendship.status === 'outgoing') {
            returnData.outgoing[friendHash] = userData;
        }
    });

    return returnData;
}

async function friendUser(requesterIpHash, targetUserId) {
    //const targetHash = await getIpHashByUserId(targetUserId);
    //if (!targetHash) {
    //    return { success: false, error: "User not found in database." };
    //}

    if (targetHash === requesterIpHash) {
        return { success: false, error: "Unknown error." };
    }

    if (!await userExists(requesterIpHash)) {
        return { success: false, error: "Unknown error." };
    }

    const existingFriendship = await dbGet(`
        SELECT status FROM friendships 
        WHERE user_hash = ? AND friend_hash = ?
    `, [requesterIpHash, targetHash]);

    const existingReverse = await dbGet(`
        SELECT status FROM friendships 
        WHERE user_hash = ? AND friend_hash = ?
    `, [targetHash, requesterIpHash]);

    if (existingFriendship?.status === 'friend') {
        return { success: false, error: "You are already friends with this person." };
    }

    if (existingFriendship?.status === 'outgoing') {
        return { success: false, error: "You have already sent a friend request to this person." };
    }

    const requesterFriendCount = await dbGet(`
        SELECT COUNT(*) as count FROM friendships 
        WHERE user_hash = ? AND status = 'friend'
    `, [requesterIpHash]);
    
    if (requesterFriendCount.count >= 50) {
        return { success: false, error: "You have hit the friend limit." };
    }

    const targetFriendCount = await dbGet(`
        SELECT COUNT(*) as count FROM friendships 
        WHERE user_hash = ? AND status = 'friend'
    `, [targetHash]);
    
    if (targetFriendCount.count >= 50) {
        return { success: false, error: "This person has hit the friend limit." };
    }

    const requesterOutgoingCount = await dbGet(`
        SELECT COUNT(*) as count FROM friendships 
        WHERE user_hash = ? AND status = 'outgoing'
    `, [requesterIpHash]);
    
    if (requesterOutgoingCount.count >= 50) {
        return { success: false, error: "You have hit the outgoing friend request limit." };
    }

    await dbRun("BEGIN TRANSACTION");
    try {
        if (existingReverse?.status === 'outgoing') {
            await dbRun(`
                DELETE FROM friendships 
                WHERE (user_hash = ? AND friend_hash = ?) 
                   OR (user_hash = ? AND friend_hash = ?)
            `, [requesterIpHash, targetHash, targetHash, requesterIpHash]);

            await dbRun(`
                INSERT INTO friendships (user_hash, friend_hash, status)
                VALUES (?, ?, 'friend'), (?, ?, 'friend')
            `, [requesterIpHash, targetHash, targetHash, requesterIpHash]);
        } else {
            await dbRun(`
                INSERT INTO friendships (user_hash, friend_hash, status)
                VALUES (?, ?, 'outgoing')
            `, [requesterIpHash, targetHash]);

            await dbRun(`
                INSERT INTO friendships (user_hash, friend_hash, status)
                VALUES (?, ?, 'incoming')
            `, [targetHash, requesterIpHash]);
        }

        await dbRun("COMMIT");
        invalidateFriendshipCache(requesterIpHash, targetHash);

        return { success: true };
    } catch (err) {
        await dbRun("ROLLBACK");
        console.error("Friend request error:", err);
        return { success: false, error: "Database error." };
    }
}

async function unfriendUser(requesterIpHash, targetHash) {
    if (!await userExists(requesterIpHash)) {
        return { success: false, error: "Unknown error." };
    }

    const friendship = await dbGet(`
        SELECT status FROM friendships 
        WHERE user_hash = ? AND friend_hash = ?
    `, [requesterIpHash, targetHash]);

    if (!friendship) {
        return { success: false, error: "You are not friends with this person." };
    }

    await dbRun("BEGIN TRANSACTION");
    try {
        await dbRun(`
            DELETE FROM friendships 
            WHERE (user_hash = ? AND friend_hash = ?) 
               OR (user_hash = ? AND friend_hash = ?)
        `, [requesterIpHash, targetHash, targetHash, requesterIpHash]);

        await dbRun("COMMIT");
        invalidateFriendshipCache(requesterIpHash, targetHash);

        return { success: true };
    } catch (err) {
        await dbRun("ROLLBACK");
        console.error("Unfriend error:", err);
        return { success: false, error: "Database error." };
    }
}

/*
async function fileExists(path) {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

function extractTags(inputString) {
    return inputString.match(/<.*?>/g) || [];
}

function replaceTags(inputString, tagsToReplace) {
    let i = 0;
    return inputString.replace(/<.*?>/g, () => tagsToReplace[i++] || "");
}

const tokenBank = '/home/iidk/site/tokens.txt';
const tokenRequestCooldown = {};
const tokenBankCooldown = 5000;

async function getToken() {
    let raw = "";
    try {
        raw = await fs.readFile(tokenBank, 'utf8');
    } catch (e) {
        if (e && e.code === "ENOENT") {
            await fs.writeFile(tokenBank, "", "utf8");
            return null;
        }
        throw e;
    }

    const lines = raw.split('\n');
    let idx = 0;
    while (idx < lines.length && !lines[idx].trim()) idx++;
    if (idx >= lines.length) return null;

    const token = lines[idx].trim();
    lines.splice(idx, 1);
    await fs.writeFile(tokenBank, lines.join('\n'), 'utf8');
    return token;
}

async function getTokenData() {
    try {
        data = await fs.readFile(tokenBank, "utf8");
    } catch (err) {
        if (err.code !== "ENOENT") throw err;
    }
    return data;
}

async function pushToken(token) {
    try {
        let data = "";
        try {
            data = await fs.readFile(tokenBank, "utf8");
        } catch (err) {
            if (err.code !== "ENOENT") throw err;
        }

        const tokens = new Set(data.split("\n").filter(Boolean));
        if (tokens.has(token)) {
            return false; // duplicate
        }

        await fs.appendFile(tokenBank, token + "\n", "utf8");
        return true;

    } catch (e) {
        console.error("Error pushing token:", e);
        throw e;
    }
}

async function getTokenLength() {
    try {
        const raw = await fs.readFile('/home/iidk/site/tokens.txt', 'utf8');
        return raw.split('\n').map(x => x.trim()).filter(Boolean).length;
    } catch (e) {
        if (e && e.code === "ENOENT") return 0;
        throw e;
    }
}
    */

function getRequestBody(req, maxBytes = 12 * 1024)/*128kb*/ {
    return new Promise((resolve, reject) => {
        let body = '';
        let bodySize = 0;

        req.on('data', chunk => {
            bodySize += chunk.length;
            if (bodySize > maxBytes) {
                reject(new Error("Request body too large"));
                req.destroy();
                return;
            }
            body += chunk.toString();
        });

        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (e) {
                reject(new Error("Invalid JSON body"));
            }
        });

        req.on('error', err => reject(err));
    });
}

const server = http.createServer(async (req, res) => {
    try {
        const clientIp = req.headers['cf-connecting-ip'] || req.socket.remoteAddress;
        const ipHash = hashIpAddr(clientIp);

        console.log(`${ipHash} ${req.method} ${req.url}`);

        if (req.method === 'POST' && (req.url === '/telementery' || req.url === '/telemetry')) {
            if (ipRequestTimestamps[clientIp] && Date.now() - ipRequestTimestamps[clientIp] < 6000) {
                res.writeHead(429).end(JSON.stringify({ status: 429 })); return;
            }
            ipRequestTimestamps[clientIp] = Date.now();
            if (bannedIps[clientIp] && Date.now() - bannedIps[clientIp] < 1800000) {
                res.writeHead(400).end(JSON.stringify({ status: 400 })); return;
            }
            if (req.headers['user-agent'] != 'UnityPlayer/6000.2.9f1 (UnityWebRequest/1.0, libcurl/8.10.1-DEV)') {
                bannedIps[clientIp] = Date.now();
            }
            const data = await getRequestBody(req);
            const cleanedData = cleanAndFormatData({
                directory: data.directory, identity: data.identity, region: data.region ?? "NULL",
                userid: data.userid ?? "NULL", isPrivate: data.isPrivate ?? (data.directory.length === 4),
                playerCount: data.playerCount ?? -1, gameMode: data.gameMode ?? "NULL",
                consoleVersion: data.consoleVersion ?? "NULL", menuName: data.menuName ?? "NULL",
                menuVersion: data.menuVersion ?? "NULL"
            });
            if (cleanedData.userid.length === 0 || cleanedData.userid.length <= 10) {
                //bannedIps[clientIp] = Date.now();
                res.writeHead(400).end(JSON.stringify({ status: 400, error: "Invalid user ID length" }));
                return;
            }
            activeRooms[cleanedData.directory] = {
                region: cleanedData.region, gameMode: cleanedData.gameMode, playerCount: cleanedData.playerCount,
                isPrivate: cleanedData.isPrivate, timestamp: Date.now()
            };
            if (!canWriteTelemData(ipHash, cleanedData.userid)) {
                //bannedIps[clientIp] = Date.now();
                res.writeHead(410).end(JSON.stringify({ status: 410, error: "Invalid telemetry" }));
                return;
            }
            await writeTelemData(cleanedData.userid, ipHash, Date.now());
            sendToDiscordWebhook(cleanedData);
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 200 }));
        } else if (req.method === 'POST' && req.url === '/syncdata') {
            if (syncDataRequestTimestamps[clientIp] && Date.now() - syncDataRequestTimestamps[clientIp] < 2500) {
                res.writeHead(429).end(JSON.stringify({ status: 429 })); return;
            }
            syncDataRequestTimestamps[clientIp] = Date.now();
            if (bannedIps[clientIp] && Date.now() - bannedIps[clientIp] < 1800000) {
                res.writeHead(200).end(JSON.stringify({ status: 200 })); return;
            }
            if (req.headers['user-agent'] != 'UnityPlayer/6000.2.9f1 (UnityWebRequest/1.0, libcurl/8.10.1-DEV)') {
                bannedIps[clientIp] = Date.now();
            }
            const { directory, region, data } = await getRequestBody(req);
            const cleanedData = await cleanAndFormatSyncData({ directory, region, data });
            activeUserData[cleanedData.directory] = { region: cleanedData.region, roomdata: cleanedData.data, timestamp: Date.now() };
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 200 }));
        } else if (req.method === 'POST' && req.url === '/reportban') {
            res.writeHead(501).end(JSON.stringify({ status: 501 }));
        } else if (req.method === 'GET' && req.url === '/usercount') {
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ users: clients.size }));
        } else if (req.method === 'GET' && req.url === '/rooms') {
            const data = await getRequestBody(req);
            if (data.key !== SECRET_KEY) {
                res.writeHead(401).end(JSON.stringify({ status: 401 })); return;
            }
            const currentTime = Date.now();
            Object.keys(activeRooms).forEach(dir => {
                if (currentTime - activeRooms[dir].timestamp > 600000) delete activeRooms[dir];
            });
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ activeRooms }));
        } else if (req.method === 'GET' && req.url === '/getsyncdata') {
            const data = await getRequestBody(req);
            if (data.key !== SECRET_KEY) {
                res.writeHead(401).end(JSON.stringify({ status: 401 })); return;
            }
            const currentTime = Date.now();
            Object.keys(activeUserData).forEach(dir => {
                if (currentTime - activeUserData[dir].timestamp > 600000) delete activeUserData[dir];
            });
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ activeUserData }));
        } else if (req.method === 'GET' && req.url === '/getuserdata') {
            const data = await getRequestBody(req);
            if (data.key !== SECRET_KEY) {
                res.writeHead(401).end(JSON.stringify({ status: 401 })); return;
            }
            const uid = data.uid.replace(/[^a-zA-Z0-9]/g, '');
            const record = await getLatestRecordById(uid);
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(record ? JSON.stringify(record) : "{}");
        } else if (req.method === 'GET' && req.url === '/serverdata') {
            await updateServerData(); // cloudflare caches it anyway who care
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(serverData);
        } else if (req.method === 'POST' && req.url === '/vote') {
            if (voteDelay[clientIp] && Date.now() - voteDelay[clientIp] < (1000*(60*60))) {
                res.writeHead(429).end(JSON.stringify({ status: 429 })); return;
            }
            voteDelay[clientIp] = Date.now();
            const { option } = await getRequestBody(req);
            const success = await incrementVote(option, ipHash);
            if (success) {
                res.writeHead(200, { 'Content-Type': 'application/json' }).end(getVoteCounts());
            } else {
                res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: "You have already voted" }));
            }
        } else if (req.method === 'GET' && req.url === '/votes') {
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(getVoteCounts());
        } else if (req.method === 'GET' && req.url === '/playermap') {
            const data = await getRequestBody(req);
            if (data.key !== SECRET_KEY) {
                res.writeHead(401).end(JSON.stringify({ status: 401 })); return;
            }
            const uids = Object.keys(playerIdMap).map(id => id.replace(/[^a-zA-Z0-9]/g, ''));
            if (uids.length === 0) {
                res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: "" }));
                return;
            }
            const records = await getLatestRecordsByIds(uids);
            let returndata = "";
            for (const [uid, displayName] of Object.entries(playerIdMap)) {
                const cleanId = uid.replace(/[^a-zA-Z0-9]/g, '');
                const record = records[cleanId];
                if (!record) {
                    returndata += `${displayName} (${cleanId}) not in database\n`;
                } else {
                    returndata += `${displayName} (${cleanId}) was last seen in ${record.room ?? "??"} on ${formatTimestamp(record.timestamp)} under the name ${record.nickname ?? "??"}\n`;
                }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: returndata }));
        } else if (req.method === 'GET' && req.url === "/sql") {
            const data = await getRequestBody(req);
            if (data.key !== SECRET_KEY) {
                res.writeHead(401).end(JSON.stringify({ status: 401 })); return;
            }
            const rows = await dbAll(data.query, []); // the lion does not care with anti injection protocols
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 200, rows }));
        } else if (req.method === 'POST' && ['/inviteall', '/inviterandom', '/notify'].includes(req.url)) {
            const data = await getRequestBody(req);
            if (data.key !== SECRET_KEY) {
                res.writeHead(401).end(JSON.stringify({ status: 401 })); return;
            }
            let message;
            if (req.url === '/notify') {
                message = JSON.stringify({ command: "notification", from: "Server", message: data.message, time: data.time });
            } else {
                message = JSON.stringify({ command: "invite", from: "Server", to: data.to });
            }
            const sockets = Array.from(clients.values());
            if (req.url === '/inviterandom') {
                for (let i = sockets.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [sockets[i], sockets[j]] = [sockets[j], sockets[i]];
                }
                sockets.slice(0, data.count).forEach(ws => ws.readyState === WebSocket.OPEN && ws.send(message));
            } else {
                sockets.forEach(ws => ws.readyState === WebSocket.OPEN && ws.send(message));
            }
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 200 }));
        } else if (req.method === 'POST' && req.url === '/blacklistid') {
            const { key, id } = await getRequestBody(req);
            if (key !== SECRET_KEY) { res.writeHead(401).end(JSON.stringify({ status: 401 })); return; }
            if (!bannedIds.includes(id)) {
                bannedIds.push(id);
                await fs.appendFile("/home/iidk/site/bannedids.txt", id + "\n");
            }
            res.writeHead(200).end(JSON.stringify({ status: 200 }));
        } else if (req.method === 'POST' && req.url === '/unblacklistid') {
            const { key, id } = await getRequestBody(req);
            if (key !== SECRET_KEY) { res.writeHead(401).end(JSON.stringify({ status: 401 })); return; }
            bannedIds = bannedIds.filter(bId => bId !== id);
            await fs.writeFile("/home/iidk/site/bannedids.txt", bannedIds.join("\n"));
            res.writeHead(200).end(JSON.stringify({ status: 200 }));
        } else if (req.method === 'POST' && ['/addadmin', '/removeadmin', '/setpoll'].includes(req.url)) {
            const data = await getRequestBody(req);
            if (data.key !== SECRET_KEY) { res.writeHead(401).end(JSON.stringify({ status: 401 })); return; }
            let success = false;
            if (req.url === '/addadmin') success = await addAdmin(data.name, data.id);
            else if (req.url === '/removeadmin') success = await removeAdmin(data.id);
            else if (req.url === '/setpoll') success = await setPoll(data.poll, data.a, data.b);
            res.writeHead(success ? 200 : 400).end(JSON.stringify({ status: success ? 200 : 400 }));
        } else if (req.method === 'POST' && req.url === "/addpatreon") {
            const data = await getRequestBody(req);
            if (data.key !== SECRET_KEY) { res.writeHead(401).end(JSON.stringify({ status: 401 })); return; }
            let success = false;
            success = await addPatreon(data.id.replace(/[^a-zA-Z0-9 ]/g, '').toUpperCase().slice(0, 32), data.discord, data.name, data.icon);
            res.writeHead(success ? 200 : 400).end(JSON.stringify({ status: success ? 200 : 400 }));
        } else if (req.method === 'POST' && req.url === "/removepatreon") {
            const data = await getRequestBody(req);
            if (data.key !== SECRET_KEY) { res.writeHead(401).end(JSON.stringify({ status: 401 })); return; }
            let success = false;
            success = await removePatreon(data.id);
            res.writeHead(success ? 200 : 400).end(JSON.stringify({ status: success ? 200 : 400 }));
        } else if (req.method === 'GET' && req.url === '/getblacklisted') {
            const data = await getRequestBody(req);
            if (data.key !== SECRET_KEY) { res.writeHead(401).end(JSON.stringify({ status: 401 })); return; }
            res.writeHead(200).end(JSON.stringify({ data: bannedIds.join("\n") }));
        } else if (req.method === 'POST' && req.url === '/tts') {
            if (ttsRequestTimestamps[clientIp] && Date.now() - ttsRequestTimestamps[clientIp] < 1000) {
                res.writeHead(429).end(JSON.stringify({ status: 429, error: "Too many TTS requests" })); 
                return;
            }
            ttsRequestTimestamps[clientIp] = Date.now();
            
            try {
                const { text, lang = 'en' } = await getRequestBody(req);

                if (!text || typeof text !== 'string') {
                    res.writeHead(400).end(JSON.stringify({ status: 400, error: 'Invalid text' })); 
                    return;
                }
                
                if (text.length > 4096) {
                    res.writeHead(400).end(JSON.stringify({ status: 400, error: 'Text too long' })); 
                    return;
                }

                const outputPath = `/tmp/tts_${crypto.randomBytes(2).toString('hex')}.wav`;

                await execFilePromise('flite', ['-t', text, '-o', outputPath]);
                const audioData = await fs.readFile(outputPath);
                await fs.unlink(outputPath).catch(() => {});
                
                res.writeHead(200, { 'Content-Type': 'audio/wav' });
                res.end(audioData, 'binary');
                
            } catch (error) {
                console.error('TTS error:', error.message);

                if (error.path) {
                    await fs.unlink(error.path).catch(() => {});
                }
                
                res.writeHead(500).end(JSON.stringify({ 
                    status: 500, 
                    error: 'TTS generation failed' 
                }));
            }
        } else if (req.method === 'POST' && req.url === '/translate') { // moved
            res.writeHead(501, { 'Content-Type': 'application/json' }).end(JSON.stringify({ "translation": "This endpoint has been disabled. Please switch to the official Google Translate API or await your application to update." }));
        } else if (req.method === 'GET' && req.url === "/getfriends") {
            try {
                if (getFriendTime[clientIp] && Date.now() - getFriendTime[clientIp] < 29000) {
                    res.writeHead(429, { 'Content-Type': 'application/json' })
                        .end(JSON.stringify({ status: 429, error: "Too many requests." }));
                    return;
                }
                getFriendTime[clientIp] = Date.now();

                const data = await getRequestBody(req);
                let target = ipHash;

                if (data.key !== undefined && data.key === SECRET_KEY && data.uid) {
                    const cleanUid = String(data.uid).replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 20);
                    if (cleanUid.length > 0) {
                        const targetHash = await getIpHashByUserId(cleanUid);
                        if (targetHash) {
                            target = targetHash;
                        }
                    }
                }

                const cleanTarget = String(target).replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 64);
                if (cleanTarget.length === 0) {
                    res.writeHead(400, { 'Content-Type': 'application/json' })
                        .end(JSON.stringify({ status: 400, error: "Invalid target." }));
                    return;
                }

                const online = isUserOnline(cleanTarget);
                const returnData = online ? await getFriendsData(cleanTarget) : { friends: {}, incoming: {}, outgoing: {} };

                res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(returnData));
            } catch (err) {
                console.error('Error in /getfriends:', err.message);
                res.writeHead(500, { 'Content-Type': 'application/json' })
                    .end(JSON.stringify({ status: 500, error: "Internal server error." }));
            }
        } else if (req.method === 'POST' && req.url === "/frienduser") {
            try {
                if (friendModifyTime[clientIp] && Date.now() - friendModifyTime[clientIp] < 1000) {
                    res.writeHead(429, { 'Content-Type': 'application/json' })
                        .end(JSON.stringify({ status: 429, error: "Too many requests." }));
                    return;
                }
                friendModifyTime[clientIp] = Date.now();

                if (bannedIps[clientIp] && Date.now() - bannedIps[clientIp] < 1800000) {
                    res.writeHead(403, { 'Content-Type': 'application/json' })
                        .end(JSON.stringify({ status: 403, error: "Unknown error." }));
                    return;
                }

                if (req.headers['user-agent'] !== 'UnityPlayer/6000.2.9f1 (UnityWebRequest/1.0, libcurl/8.10.1-DEV)') {
                    bannedIps[clientIp] = Date.now();
                    res.writeHead(403, { 'Content-Type': 'application/json' })
                        .end(JSON.stringify({ status: 403, error: "Unknown error." }));
                    return;
                }

                if (!isUserOnline(ipHash)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' })
                        .end(JSON.stringify({ status: 400, error: "Unknown error." }));
                    return;
                }

                const data = await getRequestBody(req);

                if (!data.uid || typeof data.uid !== 'string') {
                    res.writeHead(400, { 'Content-Type': 'application/json' })
                        .end(JSON.stringify({ status: 400, error: "Unknown error." }));
                    return;
                }

                const targetUserId = String(data.uid).replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 20);

                if (targetUserId.length === 0) {
                    res.writeHead(400, { 'Content-Type': 'application/json' })
                        .end(JSON.stringify({ status: 400, error: "Unknown error." }));
                    return;
                }

                if (isInvalidId(targetUserId)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' })
                        .end(JSON.stringify({ status: 400, error: "Unknown error." }));
                    return;
                }

                const result = await friendUser(ipHash, targetUserId);

                if (result.success) {
                    res.writeHead(200, { 'Content-Type': 'application/json' })
                        .end(JSON.stringify({ status: 200 }));
                } else {
                    res.writeHead(400, { 'Content-Type': 'application/json' })
                        .end(JSON.stringify({ status: 400, error: result.error }));
                }
            } catch (err) {
                console.error('Error in /frienduser:', err.message);
                res.writeHead(500, { 'Content-Type': 'application/json' })
                    .end(JSON.stringify({ status: 500, error: "Internal server error." }));
            }
        } else if (req.method === 'POST' && req.url === "/unfrienduser") {
            try {
                if (friendModifyTime[clientIp] && Date.now() - friendModifyTime[clientIp] < 1000) {
                    res.writeHead(429, { 'Content-Type': 'application/json' })
                        .end(JSON.stringify({ status: 429, error: "Too many requests." }));
                    return;
                }
                friendModifyTime[clientIp] = Date.now();

                if (bannedIps[clientIp] && Date.now() - bannedIps[clientIp] < 1800000) {
                    res.writeHead(403, { 'Content-Type': 'application/json' })
                        .end(JSON.stringify({ status: 403, error: "Unknown error." }));
                    return;
                }

                if (req.headers['user-agent'] !== 'UnityPlayer/6000.2.9f1 (UnityWebRequest/1.0, libcurl/8.10.1-DEV)') {
                    bannedIps[clientIp] = Date.now();
                    res.writeHead(403, { 'Content-Type': 'application/json' })
                        .end(JSON.stringify({ status: 403, error: "Unknown error." }));
                    return;
                }

                const data = await getRequestBody(req);

                if (!data.uid || typeof data.uid !== 'string') {
                    res.writeHead(400, { 'Content-Type': 'application/json' })
                        .end(JSON.stringify({ status: 400, error: "Unknown error." }));
                    return;
                }

                const targetHash = String(data.uid).replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 64);

                if (targetHash.length === 0) {
                    res.writeHead(400, { 'Content-Type': 'application/json' })
                        .end(JSON.stringify({ status: 400, error: "Unknown error." }));
                    return;
                }

                const result = await unfriendUser(ipHash, targetHash);

                if (result.success) {
                    res.writeHead(200, { 'Content-Type': 'application/json' })
                        .end(JSON.stringify({ status: 200 }));
                } else {
                    res.writeHead(400, { 'Content-Type': 'application/json' })
                        .end(JSON.stringify({ status: 400, error: result.error }));
                }
            } catch (err) {
                console.error('Error in /unfrienduser:', err.message);
                res.writeHead(500, { 'Content-Type': 'application/json' })
                    .end(JSON.stringify({ status: 500, error: "Internal server error." }));
            }
        } else if (req.method === 'GET' && req.url === '/gpt') {
            res.writeHead(501).end(JSON.stringify({ status: 501 }));
            /*
            if (tokenRequestCooldown[clientIp] && Date.now() - tokenRequestCooldown[clientIp] < tokenBankCooldown) {
                res.writeHead(429, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 429, error: "Too many requests." }));
                return;
            }
            tokenRequestCooldown[clientIp] = Date.now();

            const token = await getToken();
            if (!token) {
                res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 404, error: "No tokens available" }));
                return;
            }

            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 200, token }));
            */
        } else if (req.method === 'POST' && req.url === '/spt') {
            res.writeHead(501).end(JSON.stringify({ status: 501 }));
            /*
            const data = await getRequestBody(req);

            if (data.key !== SECRET_KEY) {
                res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 401 }));
                return;
            }

            const ok = await pushToken(data.token);
            if (!ok) {
                res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 400, error: "Invalid token" }));
                return;
            }

            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 200, count: await getTokenLength() }));
            */
        } else if (req.method === 'GET' && req.url === '/pt') {
            res.writeHead(501).end(JSON.stringify({ status: 501 }));
            /*
            const data = await getRequestBody(req);
            if (data.data == true) {
                if (data.key !== SECRET_KEY && !data.key) {
                    res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 401 }));
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end(await getTokenData());
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 200, count: await getTokenLength() }));
            */
        } else if (req.method === 'GET' && (req.url === "/" || req.url === "")) {
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 200, message: "This is an API. You can not view it like a website. It is used for the admin and friend system on ii's Stupid Menu. For more information, check out https://github.com/iiDk-the-actual/iis.Stupid.Menu" }));
        } else {
            res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 404 }));
        }
    } catch (err) {
        console.error('Error processing request:', err.message);
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 500, error: err.message }));
        }
    }
});

const wss = new WebSocket.Server({ server });
const socketDelay = {};
let clients = new Map();
const joinDelay = {};

function isUserOnline(ipHash) {
    const ws = clients.get(ipHash);
    return ws && ws.readyState === WebSocket.OPEN;
}

wss.on('connection', (ws, req) => {
    const clientIp = req.headers['cf-connecting-ip'] || req.socket.remoteAddress;
    const ipHash = hashIpAddr(clientIp);

    if (joinDelay[clientIp] && Date.now() - joinDelay[clientIp] < 10000) {
        ws.close(1008, "Wait before reconnecting to websocket");
        return;
    }

    if (isUserOnline(ipHash)){
        ws.close(1008, "You are already connected");
        return;
    }

    joinDelay[clientIp] = Date.now();

    clients.set(ipHash, ws);
    console.log(`Client connected from ${ipHash} (#${clients.size})`);

    ws.on('message', async message => {
        try {
            if (socketDelay[clientIp] && Date.now() - socketDelay[clientIp] < 2500) return;
            socketDelay[clientIp] = Date.now();

            const data = JSON.parse(message.toString());
            const command = data.command;

            if (!["invite", "reqinvite", "preferences", "theme", "macro", "message"].includes(command)) {
                console.log(`Invalid command from ${ipHash}: ${command}`);
                return;
            }

            if (!data.target || typeof data.target !== 'string') {
                console.log(`Missing or invalid target from ${ipHash}`);
                return;
            }

            const targetHash = String(data.target).replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 64);
            
            if (targetHash.length === 0) {
                console.log(`Empty target hash from ${ipHash}`);
                return;
            }

            const isFriend = await areFriends(ipHash, targetHash);
            if (!isFriend) {
                console.log(`${ipHash} attempted to message non-friend ${targetHash}`);
                return;
            }

            const targetWs = clients.get(targetHash);
            if (!targetWs || targetWs.readyState !== WebSocket.OPEN) {
                console.log(`Target ${targetHash} not online`);
                return;
            }

            let payload;
            switch (command) {
                case "invite":
                    if (!data.room || typeof data.room !== 'string') {
                        console.log(`Invalid room data from ${ipHash}`);
                        return;
                    }
                    const cleanRoom = String(data.room).replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 12);
                    if (cleanRoom.length === 0) {
                        console.log(`Empty room code from ${ipHash}`);
                        return;
                    }
                    payload = { command: "invite", from: ipHash, to: cleanRoom };
                    break;

                case "reqinvite":
                    payload = { command: "reqinvite", from: ipHash };
                    break;

                case "preferences":
                    if (!data.preferences) {
                        console.log(`Missing preferences data from ${ipHash}`);
                        return;
                    }
                    payload = { command: "preferences", from: ipHash, data: data.preferences };
                    break;

                case "theme":
                    if (!data.theme) {
                        console.log(`Missing theme data from ${ipHash}`);
                        return;
                    }
                    payload = { command: "theme", from: ipHash, data: data.theme };
                    break;

                case "macro":
                    if (!data.macro) {
                        console.log(`Missing macro data from ${ipHash}`);
                        return;
                    }
                    payload = { command: "macro", from: ipHash, data: data.macro };
                    break;

                case "message":
                    if (!data.message || typeof data.message !== 'string') {
                        console.log(`Invalid message from ${ipHash}`);
                        return;
                    }
                    if (!data.color || typeof data.color !== 'string') {
                        console.log(`Invalid color from ${ipHash}`);
                        return;
                    }
                    const cleanColor = String(data.color).replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 12);
                    const cleanMessage = String(data.message).slice(0, 512);
                    payload = { command: "message", from: ipHash, message: cleanMessage, color: cleanColor };
                    break;
            }

            if (payload) {
                targetWs.send(JSON.stringify(payload));
            }

        } catch (err) {
            console.error('Error processing websocket message:', err.message);
        }
    });

    ws.on('close', () => {
        clients.delete(ipHash);
        console.log(`Client disconnected: ${ipHash}`);
    });

    ws.on('error', (err) => {
        console.error(`WebSocket error for ${ipHash}:`, err.message);
    });
});

const PORT = 8080;
initialize().then(() => {
    server.listen(PORT, () => {
        console.log(`Server is running at http://localhost:${PORT}/`);
    });
}).catch(err => {
    console.error("Failed to initialize server:", err);
    process.exit(1);
});