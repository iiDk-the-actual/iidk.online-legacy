// "thank you acutebunny!" we all say in unison
const http = require('http');
const https = require('https');
const fs = require('fs').promises;
const WebSocket = require('ws');
const crypto = require('crypto');
const { exec } = require('child_process');
const util = require('util');
const sqlite3 = require("sqlite3").verbose();

const execPromise = util.promisify(exec);

const db = new sqlite3.Database("/mnt/external/site-data/records.db");
const dbGet = util.promisify(db.get.bind(db));
const dbAll = util.promisify(db.all.bind(db));
const dbRun = util.promisify(db.run.bind(db));

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
}

async function incrementVote(option, userId) {
    if (option !== 'a-votes' && option !== 'b-votes') {
        throw new Error('Must be "a-votes" or "b-votes"');
    }

    if (votesObj['a-votes'].includes(userId) || votesObj['b-votes'].includes(userId)) {
        console.log(`User ${userId} has already voted.`);
        return false;
    }

    votesObj[option].push(userId);

    await fs.writeFile(filePath, JSON.stringify(votesObj, null, 2), 'utf8');
    console.log(`User ${userId} voted for ${option}`);
    return true;
}

async function resetVotes() {
    votesObj = { "a-votes": [], "b-votes": [] };
    await fs.writeFile(filePath, JSON.stringify(votesObj, null, 2), 'utf8');
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
const reportBanRequestTimestamps = {};
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
        if (count >= 10) break;
        const user = data.data[userId];
        const newUserId = userId.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 20);
        user.nickname = user.nickname.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 12);
        user.cosmetics = user.cosmetics.toUpperCase().slice(0, 16384);
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
    if (Date.now() - syncDataDelay < 1000) {
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
    if (Date.now() - syncDataDelay2 < 1000) {
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
    if (Date.now() - syncDataDelay2 < 1000) {
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

const recordCache = [];
const MAX_CACHE_SIZE = 5000;

function writeRecordAutoRaw(id, nickname, room, cosmetics, color = null, platform = null, timestamp = null) {
    if (!timestamp) timestamp = Date.now();
    const record = { id, nickname, room, cosmetics, color, platform, timestamp };
    record.raw_json = JSON.stringify(record);
    recordCache.push(record);
    if (recordCache.length >= MAX_CACHE_SIZE) {
        const cacheToFlush = [...recordCache];
        recordCache.length = 0;
        flushCacheToDB(cacheToFlush);
    }
}

let isFlushing = false;
async function flushCacheToDB(records) {
    if (!records || records.length === 0 || isFlushing) return;

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
                await stmtRun([r.id, r.nickname, r.room, r.cosmetics, r.color, r.platform, r.timestamp, r.raw_json]);
            }
            await stmtFinalize();
            await dbRun("COMMIT");
            console.log(`Flushed ${records.length} records to the database.`);
        } catch (err) {
            console.error("SQLite transaction error:", err.message);
            await dbRun("ROLLBACK").catch(e => console.error("Rollback failed:", e.message));
        }
    } catch { }

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
const telemTimeout = 60 * 60 * 1000; // 1 hour

function canWriteTelemData(ip, userId) {
    const now = Date.now();
    const lock = ipTelemetryLock[ip];
    if (lock && (now - lock.timestamp < telemTimeout) && lock.userId !== userId) {
        return false;
    }
    ipTelemetryLock[ip] = { userId, timestamp: now };
    return true;
}

async function writeTelemData(userid, ip, timestamp) {
    const telemData = { ip, timestamp };
    await fs.writeFile(`/mnt/external/site-data/Telemdata/${userid}.json`, JSON.stringify(telemData, null, 4), 'utf8');
    const ipData = { userid, timestamp };
    await fs.writeFile(`/mnt/external/site-data/Ipdata/${ip}.json`, JSON.stringify(ipData, null, 4), 'utf8');
}

async function countFilesInDirectory(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries.filter(entry => entry.isFile()).length;
}

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

function getRequestBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
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
        const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
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
                res.writeHead(400).end(JSON.stringify({ status: 400, error: "No" }));
                return;
            }
            activeRooms[cleanedData.directory] = {
                region: cleanedData.region, gameMode: cleanedData.gameMode, playerCount: cleanedData.playerCount,
                isPrivate: cleanedData.isPrivate, timestamp: Date.now()
            };
            if (!canWriteTelemData(clientIp, cleanedData.userid)) {
                res.writeHead(410).end(JSON.stringify({ status: 410 }));
                return;
            }
            await writeTelemData(cleanedData.userid, clientIp, Date.now());
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
            /*
            if (reportBanRequestTimestamps[clientIp] && Date.now() - reportBanRequestTimestamps[clientIp] < 1800000) {
                res.writeHead(429).end(JSON.stringify({ status: 429 })); return;
            }
            reportBanRequestTimestamps[clientIp] = Date.now();
            if (bannedIps[clientIp] && Date.now() - bannedIps[clientIp] < 1800000) {
                res.writeHead(200).end(JSON.stringify({ status: 200 })); return;
            }
            if (req.headers['user-agent'] != 'UnityPlayer/6000.2.9f1 (UnityWebRequest/1.0, libcurl/8.10.1-DEV)') {
                bannedIps[clientIp] = Date.now();
            }
            const { error, version, data } = await getRequestBody(req);
            await processBanData({ error, version, data }, ipHash);
            */
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
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(serverData);
        } else if (req.method === 'GET' && req.url === '/gettelemdata') {
            const data = await getRequestBody(req);
            if (data.key !== SECRET_KEY) {
                res.writeHead(401).end(JSON.stringify({ status: 401 })); return;
            }
            const uid = data.uid.replace(/[^a-zA-Z0-9]/g, '');
            try {
                const telemData = await fs.readFile(`/mnt/external/site-data/Telemdata/${uid}.json`, 'utf8');
                res.writeHead(200, { 'Content-Type': 'application/json' }).end(telemData.trim());
            } catch {
                res.writeHead(200, { 'Content-Type': 'application/json' }).end("{}");
            }
        } else if (req.method === 'POST' && req.url === '/vote') {
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
            const { text, lang = 'en' } = await getRequestBody(req);
            if (!text) { res.writeHead(400).end(JSON.stringify({ status: 400 })); return; }
            const cleanText = text.substring(0, 4096).replace(/(["'$`\\])/g, '\\$1');
            const cleanLang = lang.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6);
            const outputPath = 'output.wav';
            await execPromise(`flite -t "${cleanText}" -o ${outputPath}`);
            const audioData = await fs.readFile(outputPath);
            res.writeHead(200, { 'Content-Type': 'audio/wav' }).end(audioData, 'binary');
        } else if (req.method === 'POST' && req.url === '/translate') { // TODO: Convert this to the google API on the client so thigns stop depending on this stuff 
            const { text, lang = 'es' } = await getRequestBody(req);
            if (!text) { res.writeHead(400).end(JSON.stringify({ status: 400, error: 'Missing text' })); return; }
            const cleanText = text.replace(/(["'$`\\])/g, '\\$1').substring(0, 4096);
            const cleanLang = lang.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6);
            const hash = hashIpAddr(cleanText);
            const cacheDir = `/mnt/external/site-data/Translatedata/${cleanLang}`;
            const cachePath = `${cacheDir}/${hash}.txt`;
            try {
                const cached = await fs.readFile(cachePath, 'utf8');
                res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ translation: cached })); return;
            } catch {}
            const extractedTags = extractTags(cleanText);
            const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${cleanLang}&dt=t&q=${encodeURIComponent(cleanText)}`;
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const result = await response.json();
            let translation = result[0].map(x => x[0]).join('');
            translation = replaceTags(translation, extractedTags);
            await fs.mkdir(cacheDir, { recursive: true });
            await fs.writeFile(cachePath, translation, 'utf8');
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ translation }));
        } else if (req.method === 'GET' && req.url === "/getfriends") {
            if (getFriendTime[clientIp] && Date.now() - getFriendTime[clientIp] < 29000) {
                res.writeHead(429).end(JSON.stringify({ status: 429 })); return;
            }
            getFriendTime[clientIp] = Date.now();
            const data = await getRequestBody(req);
            let target = ipHash;
            if (data.key !== undefined && data.key === SECRET_KEY) {
                target = data.uid.replace(/[^a-zA-Z0-9]/g, '');
            }
            const friendDataFile = `/mnt/external/site-data/Frienddata/${target}.json`
            let returnData = { friends: {}, incoming: {}, outgoing: {} };

            if (await fileExists(friendDataFile)){
                const selfFriendData = JSON.parse(await fs.readFile(friendDataFile, 'utf8'));

                const allIdsMap = {};
                const processFriendArray = async (array, type) => {
                    for (const friend of array) {
                        try {
                            const friendData = JSON.parse(await fs.readFile(`/mnt/external/site-data/Frienddata/${friend}.json`, 'utf8'));
                            const ipData = JSON.parse(await fs.readFile(`/mnt/external/site-data/Ipdata/${friendData["private-ip"]}.json`, 'utf8'));
                            allIdsMap[ipData["userid"]] = { source: type, friend };
                        } catch (err) {}
                    }
                };
                await processFriendArray(selfFriendData.friends, "friends");
                await processFriendArray(selfFriendData.incoming, "incoming");
                await processFriendArray(selfFriendData.outgoing, "outgoing");
                const allIds = Object.keys(allIdsMap);
                if (allIds.length === 0) {
                    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(returnData)); return;
                }
                const results = await getLatestRecordsByIds(allIds);
                Object.entries(results).forEach(([id, record]) => {
                    const { source, friend } = allIdsMap[id];
                    const online = isUserOnline(friend);
                    if (source === "friends") returnData.friends[friend] = { "online": online, "currentRoom": online ? record?.room ?? "" : "", "currentName": record?.nickname ?? null, "currentUserID": record?.id ?? null };
                    else if (source === "incoming") returnData.incoming[friend] = { "currentName": record?.nickname ?? null, "currentUserID": record?.id ?? null };
                    else if (source === "outgoing") returnData.outgoing[friend] = { "currentName": record?.nickname ?? null, "currentUserID": record?.id ?? null };
                });
            }
            
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(returnData));
        } else if (req.method === 'POST' && req.url === "/frienduser") {
            if (friendModifyTime[clientIp] && Date.now() - friendModifyTime[clientIp] < 1000) {
                res.writeHead(429).end(JSON.stringify({ status: 429, error: "Too many requests." })); return;
            }
            friendModifyTime[clientIp] = Date.now();
            if (bannedIps[clientIp] && Date.now() - bannedIps[clientIp] < 1800000) { res.writeHead(200).end(JSON.stringify({ status: 200 })); return; }
            if (req.headers['user-agent'] != 'UnityPlayer/6000.2.9f1 (UnityWebRequest/1.0, libcurl/8.10.1-DEV)') bannedIps[clientIp] = Date.now();
            const data = await getRequestBody(req);
            const target = data.uid.replace(/[^a-zA-Z0-9]/g, '');
            const targetTelemData = JSON.parse(await fs.readFile(`/mnt/external/site-data/Telemdata/${target}.json`, 'utf8'));
            const ipData = JSON.parse(await fs.readFile(`/mnt/external/site-data/Ipdata/${clientIp}.json`, 'utf8'));
            const telemData = JSON.parse(await fs.readFile(`/mnt/external/site-data/Telemdata/${ipData["userid"]}.json`, 'utf8'));
            const targetHash = hashIpAddr(targetTelemData["ip"]);
            if (!await fileExists(`/mnt/external/site-data/Frienddata/${targetHash}.json`)){
                const jsonData = { "private-ip": targetTelemData["ip"], "friends": [], "outgoing": [], "incoming": [] };
                await fs.writeFile(`/mnt/external/site-data/Frienddata/${targetHash}.json`, JSON.stringify(jsonData, null, 4), 'utf8');
            }
            if (!await fileExists(`/mnt/external/site-data/Frienddata/${ipHash}.json`)){
                const jsonData = { "private-ip": clientIp, "friends": [], "outgoing": [], "incoming": [] };
                await fs.writeFile(`/mnt/external/site-data/Frienddata/${ipHash}.json`, JSON.stringify(jsonData, null, 4), 'utf8');
            }
            const targetData = JSON.parse(await fs.readFile(`/mnt/external/site-data/Frienddata/${targetHash}.json`, 'utf8'));
            const selfData = JSON.parse(await fs.readFile(`/mnt/external/site-data/Frienddata/${ipHash}.json`, 'utf8'));
            const bypassChecks = selfData.incoming.includes(targetHash) || targetData.outgoing.includes(ipHash);
            if (targetTelemData["ip"] === clientIp) { res.writeHead(400).end(JSON.stringify({ "status": 400, "error": "You are trying to friend yourself." })); return; }
            if (telemData["ip"] != clientIp && !bypassChecks) { res.writeHead(400).end(JSON.stringify({ "status": 400, "error": "You are trying to friend yourself." })); return; }
            if (!isUserOnline(clientIp)) { res.writeHead(400).end(JSON.stringify({ "status": 400, "error": "You are not connected to the websocket." })); return; }
            if (selfData.friends.length >= 50) { res.writeHead(400).end(JSON.stringify({ "status": 400, "error": "You have hit the friend limit." })); return; }
            if (targetData.friends.length >= 50) { res.writeHead(400).end(JSON.stringify({ "status": 400, "error": "This person has hit the friend limit." })); return; }
            if (selfData.outgoing.length >= 50) { res.writeHead(400).end(JSON.stringify({ "status": 400, "error": "You have hit the outgoing friend request limit." })); return; }
            if (targetData.friends.includes(ipHash) || selfData.friends.includes(targetHash)) { res.writeHead(400).end(JSON.stringify({ "status": 400, "error": "You are already friends with this person." })); return; }
            if (targetData.incoming.includes(ipHash)) { res.writeHead(400).end(JSON.stringify({ "status": 400, "error": "You have already sent a friend request to this person." })); return; }
            if (selfData.incoming.includes(targetHash) || targetData.outgoing.includes(ipHash)) {
                selfData.incoming = selfData.incoming.filter(entry => entry !== targetHash);
                targetData.outgoing = targetData.outgoing.filter(entry => entry !== ipHash);
                if (!selfData.friends.includes(targetHash)) selfData.friends.push(targetHash);
                if (!targetData.friends.includes(ipHash)) targetData.friends.push(ipHash);
            } else {
                if (!selfData.outgoing.includes(targetHash)) selfData.outgoing.push(targetHash);
                if (!targetData.incoming.includes(ipHash)) targetData.incoming.push(ipHash);
            }
            await fs.writeFile(`/mnt/external/site-data/Frienddata/${targetHash}.json`, JSON.stringify(targetData, null, 2), 'utf8');
            await fs.writeFile(`/mnt/external/site-data/Frienddata/${ipHash}.json`, JSON.stringify(selfData, null, 2), 'utf8');
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ "status": 200 }));
        } else if (req.method === 'POST' && req.url === "/unfrienduser") {
            if (friendModifyTime[clientIp] && Date.now() - friendModifyTime[clientIp] < 1000) {
                res.writeHead(429).end(JSON.stringify({ status: 429, error: "Too many requests." })); return;
            }
            friendModifyTime[clientIp] = Date.now();
            if (bannedIps[clientIp] && Date.now() - bannedIps[clientIp] < 1800000) { res.writeHead(200).end(JSON.stringify({ status: 200 })); return; }
            if (req.headers['user-agent'] != 'UnityPlayer/6000.2.9f1 (UnityWebRequest/1.0, libcurl/8.10.1-DEV)') bannedIps[clientIp] = Date.now();
            if (!await fileExists(`/mnt/external/site-data/Frienddata/${ipHash}.json`)){
                res.writeHead(400).end(JSON.stringify({ "status": 400, "error": "You do not have a valid friend file." })); return;
            }
            const data = await getRequestBody(req);
            const targetHash = data.uid.replace(/[^a-zA-Z0-9]/g, '');
            const targetData = JSON.parse(await fs.readFile(`/mnt/external/site-data/Frienddata/${targetHash}.json`, 'utf8'));
            const selfData = JSON.parse(await fs.readFile(`/mnt/external/site-data/Frienddata/${ipHash}.json`, 'utf8'));
            if (targetData.friends.includes(ipHash) && selfData.friends.includes(targetHash)) {
                targetData.friends = targetData.friends.filter(entry => entry !== ipHash);
                selfData.friends = selfData.friends.filter(entry => entry !== targetHash);
            } else if (selfData.outgoing.includes(targetHash) || targetData.incoming.includes(ipHash)) {
                selfData.outgoing = selfData.outgoing.filter(entry => entry !== targetHash);
                targetData.incoming = targetData.incoming.filter(entry => entry !== ipHash);
            } else if (selfData.incoming.includes(targetHash) || targetData.outgoing.includes(ipHash)) {
                selfData.incoming = selfData.incoming.filter(entry => entry !== targetHash);
                targetData.outgoing = targetData.outgoing.filter(entry => entry !== ipHash);
            } else {
                res.writeHead(400).end(JSON.stringify({ "status": 400, "error": "You are not friends with this person." })); return;
            }
            await fs.writeFile(`/mnt/external/site-data/Frienddata/${targetHash}.json`, JSON.stringify(targetData, null, 2), 'utf8');
            await fs.writeFile(`/mnt/external/site-data/Frienddata/${ipHash}.json`, JSON.stringify(selfData, null, 2), 'utf8');
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ "status": 200 }));
        } else if (req.method === 'GET' && req.url === '/gpt') {

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

        } else if (req.method === 'POST' && req.url === '/spt') {
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
        } else if (req.method === 'GET' && req.url === '/pt') {
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
        } else if (req.method === 'GET' && (req.url === "/" || req.url === "")) {
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 200, message: "This is an API. You can not view it like a website. Check out https://github.com/iiDk-the-actual/iidk.online for more info." }));
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
    joinDelay[clientIp] = Date.now();

    clients.set(ipHash, ws);
    console.log(`Client connected from ${ipHash} (#${clients.size})`);

    ws.on('message', async message => {
        try {
            if (socketDelay[clientIp] && Date.now() - socketDelay[clientIp] < 2500) return;
            socketDelay[clientIp] = Date.now();

            const data = JSON.parse(message.toString());
            const command = data.command;
            
            if (!["invite", "reqinvite", "preferences", "theme", "macro", "message"].includes(command)) return;

            const targetHash = data.target.replace(/[^a-zA-Z0-9]/g, '');

            if (!await fileExists(`/mnt/external/site-data/Frienddata/${ipHash}.json`)){
                console.error('User has no friend data'); return;
            }

            const targetData = JSON.parse(await fs.readFile(`/mnt/external/site-data/Frienddata/${targetHash}.json`, 'utf8'));
            const selfData = JSON.parse(await fs.readFile(`/mnt/external/site-data/Frienddata/${ipHash}.json`, 'utf8'));

            if (!targetData.friends.includes(ipHash) && !selfData.friends.includes(targetHash)) return;

            const targetWs = clients.get(targetHash);
            if (!targetWs || targetWs.readyState !== WebSocket.OPEN) return;

            let payload;
            switch (command) {
                case "invite":
                    payload = { command: "invite", from: ipHash, to: data.room.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 12) };
                    break;
                case "reqinvite":
                    payload = { command: "reqinvite", from: ipHash };
                    break;
                case "preferences":
                    payload = { command: "preferences", from: ipHash, data: data.preferences };
                    break;
                case "theme":
                    payload = { command: "theme", from: ipHash, data: data.theme };
                    break;
                case "macro":
                    payload = { command: "macro", from: ipHash, data: data.macro };
                    break;
                case "message":
                    payload = { command: "message", from: ipHash, message: data.message, color: data.color.replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 12) };
                    break;
            }
            if (payload) targetWs.send(JSON.stringify(payload));

        } catch (err) {
            console.error('Error processing websocket message:', err.message);
        }
    });

    ws.on('close', () => {
        clients.delete(ipHash);
        console.log(`Client disconnected: ${ipHash}`);
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
