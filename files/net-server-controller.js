"use strict";

Object.defineProperty(exports, "__esModule", {
    value: true
});

exports.NetServer = void 0;

exports.synchronizeNetClientInput = synchronizeNetClientInput;

const stream_1 = require("@box/mudb/stream");

const id_1 = require("@box/utils/id");

const physics_schema_1 = require("@box/schema/physics/physics-schema");

const net_events_1 = require("@box/schema/events/net-events");

const net_schema_1 = require("@box/schema/net/net-schema");

const player_schema_1 = require("@box/schema/player/player-schema");

const clock_schema_1 = require("@box/schema/clock/clock-schema");

const net_schema_2 = require("@box/schema/net/net-schema");

const game_server_schema_1 = require("../game-server-schema");

const net_server_tick_1 = require("./net-server-tick");

const net_tick_1 = require("@box/schema/net/net-tick");

const net_server_state_1 = require("./net-server-state");

const game_replica_1 = require("@box/schema/replica/game-replica");

const zone_server_1 = require("../zone/zone-server");

const zone_index_1 = require("@box/schema/physics/zone-index");

const game_1 = require("@box/schema/types/game");

const game_private_replica_1 = require("@box/schema/replica/game-private-replica");

const client_keyboard_event_schema_1 = require("@box/schema/events/client-keyboard-event-schema");

const pending_player_joins_1 = require("../player/pending-player-joins");

const fs = require("fs");

const MIN_RESYNC_TICK_INTERVAL = 16;
const LOKI_LOG = "/app/apps/local-engine/data/loki-cheaters.jsonl";
const LOKI_BAN = "/app/apps/local-engine/data/loki-ban-ips.txt";
const LOKI_STRIKES = "/app/apps/local-engine/data/loki-strikes.json";
const LOKI_FAR2 = 9;
const LOKI_BAN_AFTER = 3;
let lokiBansLoaded = false;
let lokiStrikes = null;

function loadLokiBans(state) {
    if (lokiBansLoaded) {
        return;
    }
    lokiBansLoaded = true;
    try {
        const lines = fs.readFileSync(LOKI_BAN, "utf8").split("\n");
        for (let i = 0; i < lines.length; ++i) {
            const ip = lines[i].trim();
            if (ip) {
                state.bannedIP[ip] = true;
            }
        }
    } catch (_err) {
        // file may not exist yet
    }
    if (!lokiStrikes) {
        try {
            lokiStrikes = JSON.parse(fs.readFileSync(LOKI_STRIKES, "utf8"));
        } catch (_err) {
            lokiStrikes = {};
        }
    }
}

function strikeKeys(ip, userId) {
    const keys = [];
    if (ip) {
        keys.push("ip:" + ip);
    }
    if (userId) {
        keys.push("uid:" + userId);
    }
    return keys;
}

function addLokiStrike(ip, userId) {
    if (!lokiStrikes) {
        lokiStrikes = {};
    }
    const keys = strikeKeys(ip, userId);
    let n = 0;
    for (let i = 0; i < keys.length; ++i) {
        const cur = lokiStrikes[keys[i]] || 0;
        if (cur > n) {
            n = cur;
        }
    }
    n += 1;
    for (let i = 0; i < keys.length; ++i) {
        lokiStrikes[keys[i]] = n;
    }
    try {
        fs.writeFileSync(LOKI_STRIKES, JSON.stringify(lokiStrikes));
    } catch (_err) {
        // ignore
    }
    return n;
}

function inspectLokiInput(state, ownerId, clientInput) {
    const bodies = clientInput && clientInput.bodies;
    const out = { foreign: 0, farPlayers: 0, sample: [] };
    if (!bodies) {
        return out;
    }
    for (let i = 0; i < bodies.length; ++i) {
        const b = bodies[i];
        if (b.id === ownerId) {
            continue;
        }
        out.foreign += 1;
        const player = (0, id_1.getById)(state.players, b.id);
        const serverBody = (0, id_1.getById)(state.bodies, b.id);
        if (player && serverBody) {
            const dx = b.px - serverBody.px;
            const dy = b.py - serverBody.py;
            const dz = b.pz - serverBody.pz;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 > LOKI_FAR2) {
                out.farPlayers += 1;
                if (out.sample.length < 8) {
                    out.sample.push({ id: b.id, d: Math.round(Math.sqrt(d2) * 100) / 100 });
                }
            }
        }
    }
    return out;
}

function reportLoki(state, logger, sessionId, connection, inspect, extra) {
    const ip = (connection.sessionData && connection.sessionData.ipAddress) || "";
    const user = (connection.sessionData && connection.sessionData.user) || {};
    const rec = {
        t: Date.now(),
        kind: inspect.farPlayers ? "loki-killaura" : "loki-foreign-bodies",
        sessionId,
        userId: user.id,
        userKey: user.userKey,
        name: connection.sessionData && connection.sessionData.name,
        ip,
        foreign: inspect.foreign,
        farPlayers: inspect.farPlayers,
        sample: inspect.sample,
        strike: extra.strike,
        warning: extra.strike < LOKI_BAN_AFTER,
        kicked: true,
        banned: !!extra.banned,
    };
    logger.warn("[loki] " + JSON.stringify(rec));
    try {
        fs.appendFileSync(LOKI_LOG, JSON.stringify(rec) + "\n");
    } catch (err) {
        logger.warn("[loki] log write failed " + err);
    }
    if (extra.banned && ip) {
        state.bannedIP[ip] = true;
        try {
            fs.appendFileSync(LOKI_BAN, ip + "\n");
        } catch (_err) {
            // ignore
        }
    }
}

function computeNetPublic(state, netState) {
    const result = net_schema_2.NetPublicSchema.alloc();
    result.tick = state.clock.tick - 1;
    result.frameSkip = state.clock.frameSkip;
    net_schema_1.NetStateSchema.assign(result.state, netState);
    game_replica_1.GameReplicaSchema.assign(result.replica, state.replica);
    return result;
}

function computeNetSecret(state, sessionId) {
    const result = net_schema_2.NetSecretSchema.clone(net_schema_2.NetSecretSchema.identity);
    const connection = state.connections[sessionId];
    if (connection) {
        result.id = connection.id;
        result.userId = connection.sessionData.user.id;
        result.userAvatar = connection.sessionData.user.avatar_hash;
        result.userName = connection.sessionData.name;
        result.avatarSkin = player_schema_1.PlayerSkinHashSchema.assign(result.avatarSkin, connection.sessionData.avatarSkin);
        const secret = (0, id_1.getById)(state.secrets, result.id);
        if (secret) {
            result.replica = game_private_replica_1.GamePrivateReplicaSchema.assign(result.replica, secret);
        }
        result.loginState = connection.loginState;
        result.netPaused = connection.net.statePaused;
        (0, zone_server_1.getPlayerEnvironmentZones)(state, result.environmentZones, result.id);
    }
    return result;
}

function playerCanMove(state, id) {
    const player = (0, id_1.getById)(state.players, id);
    if (player) {
        return !!(player.flags & player_schema_1.PlayerFlags.ALLOW_MOVE);
    }
    return true;
}

function synchronizeNetClientInput(state, sessionId, input, logger) {
    const {connections, net} = state;
    const connection = connections[sessionId];
    if (!connection || !connection.id || connection.state !== game_server_schema_1.GameConnectionState.CONNECTED) {
        logger.warn(`input from bad connection, ${sessionId}, discarding`);
        return true;
    }
    if (input.pauseCounter !== connection.net.inputPauseCounter || input.tick < connection.net.lastInput) {
        return true;
    }
    input.tick = Math.max(input.tick, state.net.oldestTick);
    const inputState = (0, net_server_tick_1.getServerNetInput)(state, input.tick);
    if (!inputState) {
        logger.warn(`bad tick from client ${sessionId}, tick = ${input.tick}.  current server tick range: ${net.oldestTick} to ${net.oldestTick + net.states.length}`);
        return false;
    }
    const usePositionCorrection = playerCanMove(state, connection.id);
    (0, net_tick_1.mergeNetInput)(inputState, connection.id, input.input, usePositionCorrection);
    net.lastInputTick = Math.min(net.lastInputTick, input.tick);
    connection.net.lastInput = input.tick;
    return true;
}

function overrideClientPositionCorrections(state, sessionId) {
    const connection = state.connections[sessionId];
    if (!connection) {
        return;
    }
    connection.net.inputPauseCounter++;
    const inputs = state.net.inputs;
    for (let i = 0; i < inputs.length; ++i) {
        const netInput = state.net.inputs[i];
        const clientInput = (0, id_1.getById)(netInput.clients, connection.id);
        if (!clientInput) {
            continue;
        }
        const bodyCorrections = clientInput.input.bodies;
        for (let j = 0; j < bodyCorrections.length; ++j) {
            net_schema_1.NetPositionCorrectionSchema.free(bodyCorrections[j]);
        }
        bodyCorrections.length = 0;
    }
    state.net.lastInputTick = state.net.oldestTick;
}

class NetServer {
    updateBufferedAmount() {
        const clients = this._socketServer.clients;
        for (let i = 0; i < clients.length; ++i) {
            const socket = clients[i];
            const connection = this._state.connections[socket.sessionId];
            if (!connection) {
                continue;
            }
            connection.net.bufferedAmount = socket.reliableBufferedAmount();
            connection.net.unreliableBufferedAmount = socket.unreliableBufferedAmount();
        }
    }
    constructor(spec) {
        this._clientLastResyncTick = {};
        this._pendingPlayerJoins = new pending_player_joins_1.PendingPlayerJoins;
        this._socketServer = spec.server._socketServer;
        this._state = spec.state;
        loadLokiBans(this._state);
        this._hotProject = spec.hotProject;
        this._state.net.zoneIndex = new zone_index_1.PhysicsZoneIndex;
        const logger = this._logger = this._state.logger.create("net");
        this.protocol = spec.server.protocol(net_schema_1.NetProtocolSchema);
        this.protocol.configure({
            message: {
                synchronize: client => {
                    logger.info(`client ${client.sessionId} resetting state`);
                    this._resetClient(client.sessionId);
                },
                acknowledge: (client, tick) => {
                    if (tick % net_schema_1.PUBLIC_BUFFER_DIVISOR !== 0) {
                        this._logger.log("invalid tick, is not divisible by buffer divisor");
                        return;
                    }
                    const sessionId = client.sessionId;
                    const connection = this._state.connections[sessionId];
                    if (!connection) {
                        logger.warn(`ack packet from bad session id: ${client.sessionId}`);
                        return;
                    }
                    if (connection.net.statePaused) {
                        logger.info(`ack packet from paused session id: ${client.sessionId}`);
                        return;
                    }
                    if (tick === 0) {
                        connection.net.lastPublicAck = 0;
                        return;
                    }
                    if (tick < connection.net.maxAck) {
                        return;
                    }
                    const sentNetPublic = this._state.net.sentNetPublic;
                    for (let i = 0; i < sentNetPublic.length; ++i) {
                        if (sentNetPublic[i].tick === tick) {
                            connection.net.maxAck = tick;
                            connection.net.lastPublicAck = tick;
                            return;
                        }
                    }
                },
                unpause: (client, tick) => {
                    const sessionId = client.sessionId;
                    const connection = this._state.connections[sessionId];
                    if (!connection) {
                        logger.warn("ack packet from bad session id");
                        return;
                    }
                    connection.net.statePaused = false;
                    connection.net.lastPublicAck = 0;
                    const sentNetPublic = this._state.net.sentNetPublic;
                    for (let i = 0; i < sentNetPublic.length; ++i) {
                        if (sentNetPublic[i].tick === tick) {
                            connection.net.lastPublicAck = tick;
                        }
                    }
                },
                pause: client => {
                    const sessionId = client.sessionId;
                    const connection = this._state.connections[sessionId];
                    if (!connection) {
                        logger.warn("ack packet from bad session id");
                        return;
                    }
                    connection.net.statePaused = true;
                    connection.net.lastPublicAck = 0;
                },
                input: (client, nextInput) => {
                    const sessionId = client.sessionId;
                    const connection = this._state.connections[sessionId];
                    if (!connection) {
                        logger.error(`input from invalid client ${sessionId}`);
                        return;
                    }
                    const netConnection = connection.net;
                    if (!netConnection.statePaused) {
                        if (connection.id && nextInput && nextInput.input) {
                            loadLokiBans(this._state);
                            const inspect = inspectLokiInput(this._state, connection.id, nextInput.input);
                            if (inspect.farPlayers >= 1) {
                                if (connection._lokiStruck) {
                                    this.kickSession(sessionId);
                                    return;
                                }
                                connection._lokiStruck = true;
                                const ip = (connection.sessionData && connection.sessionData.ipAddress) || "";
                                const userId = connection.sessionData && connection.sessionData.user && connection.sessionData.user.id;
                                const strike = addLokiStrike(ip, userId);
                                const banned = strike >= LOKI_BAN_AFTER;
                                reportLoki(this._state, this._logger, sessionId, connection, inspect, { strike, banned });
                                this.kickSession(sessionId);
                                return;
                            }
                        }
                        if (!synchronizeNetClientInput(this._state, sessionId, nextInput, this._logger)) {
                            netConnection.inputPauseCounter += 1;
                        }
                        const eventTickLo = this._state.clock.tick - net_server_state_1.SERVER_REWIND_TICKS;
                        const eventTickHi = this._state.clock.tick + net_server_state_1.SERVER_BUFFER_TICKS;
                        for (let i = 0; i < nextInput.events.length; ++i) {
                            const e = nextInput.events[i];
                            if (eventTickLo < e.tick && e.tick <= eventTickHi) {
                                const x = net_events_1.ScriptNetInputSchema.alloc();
                                x.id = connection.id;
                                net_schema_1.NetInputEventSchema.assign(x, e);
                                this._state.events.net.push(x);
                            }
                        }
                    }
                },
                join: client => {
                    const sessionId = client.sessionId;
                    const connection = this._state.connections[sessionId];
                    this._logger.log("join request from " + sessionId);
                    if ((connection === null || connection === void 0 ? void 0 : connection.id) || this._state.events.join.indexOf(sessionId) >= 0) {
                        return;
                    }
                    if (this._pendingPlayerJoins.request(sessionId, Boolean(connection))) {
                        this._state.events.join.push(sessionId);
                    } else {
                        this._logger.log("waiting for session data before joining " + sessionId);
                    }
                },
                sendKeyBoardEvent: (client, event) => {
                    const conn = this._state.connections[client.sessionId];
                    if (!conn) {
                        return;
                    }
                    const x = client_keyboard_event_schema_1.ClientKeyboardEventSchema.alloc();
                    client_keyboard_event_schema_1.ClientKeyboardEventSchema.assign(x, event);
                    x.id = conn.id;
                    this._state.events.keyboard.push(x);
                }
            },
            connect: client => {
                const playerCount = Object.keys(this.protocol.clients).length;
                if (playerCount > this._state.settings.playerLimit) {
                    this._logger.warn("server is full, rejecting connection from " + client.sessionId);
                    client.message.exceedUserLimit(this._state.settings.playerLimit);
                    client.close();
                    return;
                } else {
                    client.message.exceedUserLimit(0);
                }
                spec.connect(client.sessionId).then(ok => {
                    var _a;
                    if (!ok) {
                        logger.info(`rejecting client ${client.sessionId}`);
                        client.close();
                    } else {
                        if (this._pendingPlayerJoins.connectionReady(client.sessionId) && !((_a = this._state.connections[client.sessionId]) === null || _a === void 0 ? void 0 : _a.id) && this._state.events.join.indexOf(client.sessionId) < 0) {
                            this._logger.log("session data ready, resuming join " + client.sessionId);
                            this._state.events.join.push(client.sessionId);
                        }
                        client.message.syncClientScriptModules(this.getClientScriptModules());
                        this._resetClient(client.sessionId);
                    }
                }).catch(e => {
                    logger.error(`error in client connection handler for ${client.sessionId}: ${e}`);
                    client.close();
                });
            },
            disconnect: client => {
                this._pendingPlayerJoins.disconnect(client.sessionId);
                logger.info(`client disconnected ${client.sessionId}`);
                spec.disconnect(client.sessionId);
            }
        });
    }
    _sendPacketToClients(stream, base, target, clients) {
        stream.offset = 0;
        stream.writeVarint(base.tick << net_schema_1.NetMessageType.SHIFT | net_schema_1.NetMessageType.PUBLIC);
        net_schema_2.NetPublicSchema.diff(base, target, stream);
        const head = stream.offset;
        for (let i = 0; i < clients.length; ++i) {
            const connection = this._state.connections[clients[i]];
            if (connection) {
                stream.offset = head;
                stream.writeVarint(connection.net.inputPauseCounter);
                this.protocol.clients[clients[i]].sendRaw(stream.bytes(), net_server_state_1.SERVER_UNRELIABLE);
            }
        }
    }
    synchronizePublic(netState) {
        const clients = this.protocol.clients;
        const clientIds = Object.keys(clients);
        const clientBaseTicks = {};
        for (let i = 0; i < clientIds.length; ++i) {
            const sessionId = clientIds[i];
            const connection = this._state.connections[sessionId];
            if (!connection) {
                continue;
            }
            const body = (0, id_1.getById)(netState.bodies, connection.id);
            if (body && body.flags & physics_schema_1.RigidBodyFlags.LOCKED) {
                overrideClientPositionCorrections(this._state, connection.sessionId);
            }
            if (connection.net.statePaused || connection.net.unreliableBufferedAmount > net_server_state_1.MAX_BUFFERED_BYTES) {
                continue;
            }
            const tick = connection.net.lastPublicAck;
            if (tick in clientBaseTicks) {
                clientBaseTicks[tick].push(sessionId);
            } else {
                clientBaseTicks[tick] = [ sessionId ];
            }
            if (tick > 0) {
                const ping = (this._state.clock.tick - tick) * clock_schema_1.MS_PER_TICK;
                this._state.perf.minPing = Math.min(this._state.perf.minPing, ping);
                this._state.perf.maxPing = Math.max(this._state.perf.maxPing, ping);
                this._state.perf.avgPing += ping;
                this._state.perf.pingCount += 1;
            }
        }
        const nextPublic = computeNetPublic(this._state, netState);
        const stream = new stream_1.MuWriteStream(net_server_state_1.SERVER_REPLICA_PACKET_SIZE);
        let ptr = 0;
        const sentPublic = this._state.net.sentNetPublic;
        for (let i = 0; i < sentPublic.length; ++i) {
            const prevPublic = sentPublic[i];
            if (prevPublic.tick in clientBaseTicks) {
                this._sendPacketToClients(stream, prevPublic, nextPublic, clientBaseTicks[prevPublic.tick]);
                delete clientBaseTicks[prevPublic.tick];
            }
            if (sentPublic.length - i >= net_server_state_1.MAX_PUBLIC_BUFFER_SIZE) {
                net_schema_2.NetPublicSchema.free(prevPublic);
                continue;
            } else {
                sentPublic[ptr++] = prevPublic;
            }
        }
        sentPublic.length = ptr;
        if (nextPublic.tick % net_schema_1.PUBLIC_BUFFER_DIVISOR === 0) {
            const laggedClients = [];
            const dropKeys = Object.keys(clientBaseTicks);
            for (let j = 0; j < dropKeys.length; ++j) {
                const list = clientBaseTicks[dropKeys[j]];
                for (let k = 0; k < list.length; ++k) {
                    laggedClients.push(list[k]);
                }
            }
            if (laggedClients.length > 0) {
                this._sendPacketToClients(stream, net_schema_2.NetPublicSchema.identity, nextPublic, laggedClients.filter(client => {
                    if (nextPublic.tick - (this._clientLastResyncTick[client] || 0) < MIN_RESYNC_TICK_INTERVAL) {
                        return false;
                    }
                    this._clientLastResyncTick[client] = nextPublic.tick;
                    return true;
                }));
            }
        }
        if (nextPublic.tick % net_schema_1.PUBLIC_BUFFER_DIVISOR === 0) {
            this._state.net.sentNetPublic.push(nextPublic);
        } else {
            net_schema_2.NetPublicSchema.free(nextPublic);
        }
        stream.destroy();
    }
    _resetClient(sessionId) {
        const connection = this._state.connections[sessionId];
        if (!connection) {
            this._logger.info(`failed to reset client ${sessionId}. connection not initialized`);
            return;
        }
        this._logger.log(`resetting client ${sessionId}`);
        const netConnection = connection.net;
        netConnection.lastPublicAck = 0;
        netConnection.statePaused = true;
    }
    synchronizeSecrets() {
        const clients = this.protocol.clients;
        const clientIds = Object.keys(clients);
        const stream = new stream_1.MuWriteStream(net_server_state_1.SERVER_SECRET_PACKET_SIZE);
        for (let i = 0; i < clientIds.length; ++i) {
            const sessionId = clientIds[i];
            const connection = this._state.connections[sessionId];
            if (!connection) {
                continue;
            }
            const currentSecret = computeNetSecret(this._state, sessionId);
            const prevSecret = connection.net.lastSentSecret;
            if (!net_schema_2.NetSecretSchema.equal(currentSecret, prevSecret)) {
                stream.offset = 0;
                stream.writeVarint(net_schema_1.NetMessageType.SECRET);
                net_schema_2.NetSecretSchema.diff(prevSecret, currentSecret, stream);
                clients[sessionId].sendRaw(stream.bytes());
                net_schema_2.NetSecretSchema.assign(connection.net.lastSentSecret, currentSecret);
            }
            net_schema_2.NetSecretSchema.free(currentSecret);
        }
        stream.destroy();
    }
    kickSession(sessionId, reason = game_1.CloseType.Server) {
        const client = this.protocol.clients[sessionId];
        if (client) {
            this._logger.log("kick " + sessionId);
            client.message.kickSessionReason(reason);
            client.close();
        } else {
            this._logger.error("failed to kick invalid id " + sessionId);
        }
    }
    sendScriptEvents(events) {
        this.protocol.broadcast.scriptEvents(events, true);
    }
    sendClientScriptModules(modules) {
        this.protocol.broadcast.syncClientScriptModules(modules);
    }
    getClientScriptModules() {
        const {scriptSrc} = this._state;
        const modules = net_schema_1.ClientScriptSrcSchema.alloc();
        net_schema_1.ClientScriptSrcSchema.assign(modules, scriptSrc.clientSrc);
        return modules;
    }
}

exports.NetServer = NetServer;
