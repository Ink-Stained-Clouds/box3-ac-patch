"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.netTick = netTick;
exports.mergeNetInput = mergeNetInput;
const id_1 = require("@box/utils/id");
const schema_1 = require("@box/mudb/schema");
const net_schema_1 = require("./net-schema");
const physics_schema_1 = require("../physics/physics-schema");
const player_schema_1 = require("../player/player-schema");
const zone_schema_1 = require("../zone/zone-schema");
const delta_1 = require("./delta");
const physics_solve_1 = require("../physics/physics-solve");
const collision_filter_1 = require("../physics/collision-filter");
const player_move_1 = require("../player/player-move");
const sorted_array_remove_1 = require("../utils/sorted-array-remove");
const NetCorrectionTargetSchema = new schema_1.MuStruct({
    id: new schema_1.MuUint32(),
    authority: new schema_1.MuBoolean(false),
    weight: new schema_1.MuFloat64(0),
    px: new schema_1.MuFloat64(),
    py: new schema_1.MuFloat64(),
    pz: new schema_1.MuFloat64(),
    vx: new schema_1.MuFloat64(),
    vy: new schema_1.MuFloat64(),
    vz: new schema_1.MuFloat64(),
});
const NET_TARGETS = [];
// Clear out net target array, free all pending net targets
function clearNetTargets() {
    for (let i = 0; i < NET_TARGETS.length; ++i) {
        NetCorrectionTargetSchema.free(NET_TARGETS[i]);
    }
    NET_TARGETS.length = 0;
}
function scaleTarget(t, w) {
    t.px *= w;
    t.py *= w;
    t.pz *= w;
    t.vx *= w;
    t.vz *= w;
    t.vz *= w;
}
function accumTarget(dst, nt) {
    const w = nt.weight;
    dst.px += w * nt.px;
    dst.py += w * nt.py;
    dst.pz += w * nt.pz;
    dst.vx += w * nt.vx;
    dst.vy += w * nt.vy;
    dst.vz += w * nt.vz;
    dst.weight += w;
}
// combine all net targets with the same id
function coallesceTargets() {
    NET_TARGETS.sort(id_1.compareId);
    let count = 0;
    let ptr = 0;
    while (ptr < NET_TARGETS.length) {
        const head = NET_TARGETS[ptr++];
        // 把速度和位置 * 一个 weight，不是自己就打0.25折
        scaleTarget(head, head.weight);
        // 合并相同ID数据。每一个客户端都会算一遍所有的target，一定会有重复ID
        while (ptr < NET_TARGETS.length) {
            const x = NET_TARGETS[ptr];
            if (x.id !== head.id) {
                break;
            }
            if (x.authority) {
                head.authority = true;
            }
            accumTarget(head, x);
            NetCorrectionTargetSchema.free(x);
            ptr++;
        }
        // 加完后按比例又✖️回来了
        scaleTarget(head, 1 / head.weight);
        NET_TARGETS[count++] = head;
    }
    NET_TARGETS.length = count;
}
function updateInputSet(playerInputs, removeIds, upserts) {
    (0, sorted_array_remove_1.sortedArrayDelete)(player_schema_1.PlayerInputSchema, playerInputs, removeIds);
    // append elements to list while not sorted
    let iptr = 0;
    let uptr = 0;
    const IN = playerInputs.length;
    const UN = upserts.length;
    while (iptr < IN && uptr < UN) {
        const a = playerInputs[iptr].id;
        const b = upserts[uptr].id;
        if (a < b) {
            iptr++;
        }
        else if (b < a) {
            const x = player_schema_1.PlayerInputSchema.clone(player_schema_1.PlayerInputSchema.identity);
            x.id = b;
            playerInputs.push(x);
            uptr++;
        }
        else {
            uptr++;
            iptr++;
        }
    }
    while (uptr < UN) {
        const x = player_schema_1.PlayerInputSchema.clone(player_schema_1.PlayerInputSchema.identity);
        x.id = upserts[uptr++].id;
        playerInputs.push(x);
    }
    if (playerInputs.length !== IN) {
        playerInputs.sort(id_1.compareId);
    }
}
//
// input stores transitions from tick t to t + 1
//
function handlePlayerInput(clientInput, input) {
    const { inputState, inputAngle, inputPitch, inputCameraAngle, bodies } = clientInput.input;
    input.state = inputState;
    input.angle = inputAngle;
    input.pitch = inputPitch;
    input.cameraAngle = inputCameraAngle;
    // 自己的刚体 weight=1 有权威；别人的 0.25 叠进去做延迟/对向碰撞容错。
    // 把人拽飞的包在 dropFarPeerTargets 里丢掉，不参与叠。
    for (let i = 0; i < bodies.length; ++i) {
        const inputBody = bodies[i];
        const target = NetCorrectionTargetSchema.alloc();
        net_schema_1.NetPositionCorrectionSchema.assign(target, inputBody);
        if (inputBody.id === clientInput.id) {
            target.weight = 1;
            target.authority = true;
        }
        else {
            target.weight = 0.25;
            target.authority = false;
        }
        NET_TARGETS.push(target);
    }
}
const MAX_PEER_DELTA2 = 9;
function dropFarPeerTargets(bodies) {
    let w = 0;
    for (let i = 0; i < NET_TARGETS.length; ++i) {
        const target = NET_TARGETS[i];
        if (!target.authority) {
            const body = (0, id_1.getById)(bodies, target.id);
            if (body) {
                const dx = target.px - body.px;
                const dy = target.py - body.py;
                const dz = target.pz - body.pz;
                if (dx * dx + dy * dy + dz * dz > MAX_PEER_DELTA2) {
                    NetCorrectionTargetSchema.free(target);
                    continue;
                }
            }
        }
        NET_TARGETS[w++] = target;
    }
    NET_TARGETS.length = w;
}
function applyPositionCorrection(targets, bodies, predictedBodies) {
    let bodyLo = 0;
    const bodyHi = bodies.length - 1;
    // discard corrections for locked bodies
    let targetPtr = 0;
    for (let i = 0; i < targets.length; ++i) {
        const target = targets[i];
        target.weight = 0;
        // search next body pointer
        const bodyPtr = (0, id_1.indexEqRange)(bodies, target.id, bodyLo, bodyHi);
        if (bodyPtr < 0) {
            NetCorrectionTargetSchema.free(target);
            continue;
        }
        bodyLo = bodyPtr;
        // find next body
        const body = bodies[bodyPtr];
        if (body.flags &
            (physics_schema_1.RigidBodyFlags.LOCKED | physics_schema_1.RigidBodyFlags.FIXED | physics_schema_1.RigidBodyFlags.ANIMATED)) {
            NetCorrectionTargetSchema.free(target);
            continue;
        }
        // read predicted body
        const predicted = predictedBodies[bodyPtr];
        // apply velocity impulse correction factor
        body.vx += target.px - predicted.px;
        body.vy += target.py - predicted.py;
        body.vz += target.pz - predicted.pz;
        target.weight = 1;
        //append to list
        targets[targetPtr++] = target;
    }
    targets.length = targetPtr;
}
function applyVelocityCorrection(targets, bodies) {
    let bodyLo = 0;
    const bodyHi = bodies.length - 1;
    for (let i = 0; i < targets.length; ++i) {
        const target = targets[i];
        if (target.weight > 0) {
            // walk body pointer
            const bodyPtr = (0, id_1.indexEqRange)(bodies, target.id, bodyLo, bodyHi);
            if (bodyPtr < 0) {
                continue;
            }
            bodyLo = bodyPtr;
            // find next body
            const body = bodies[bodyPtr];
            body.vx = target.vx;
            body.vy = target.vy;
            body.vz = target.vz;
            if (target.authority) {
                body.px = target.px;
                body.py = target.py;
                body.pz = target.pz;
            }
        }
    }
}
function netTick(netState, netInput, blockIndex, collision, contact, zoneIndex, updateLocks, fullContact) {
    // copy input data from server corrections to netState
    (0, delta_1.patchList)(player_schema_1.PlayerSchema, netState.players, netInput.playerDelta);
    (0, delta_1.patchList)(physics_schema_1.RigidBodySchema, netState.bodies, netInput.bodyDelta);
    (0, delta_1.patchItem)(physics_schema_1.PhysicsParamsSchema, netState.physics, netInput.physicsDelta);
    // update filter
    if (netInput.filterChanged) {
        collision_filter_1.CollisionFilterSchema.assign(netState.collisionFilter, netInput.filter);
    }
    // update zones
    if (netInput.zoneChanged) {
        zone_schema_1.ZoneSelectorGroupSetSchema.assign(netState.zoneSelectors, netInput.zoneSelectors);
        zone_schema_1.PhysicsZoneSetSchema.assign(netState.zones, netInput.zones);
    }
    // rebuild zone index
    zoneIndex.rebuild(netState.zones, netState.zoneSelectors);
    // update netstate input set (dumb hack)
    updateInputSet(netState.playerInputs, netInput.playerDelta.remove, netInput.playerDelta.upserts);
    // lock any bodies which were updated by server
    if (updateLocks) {
        (0, physics_solve_1.clearBodyLocks)(netState.bodies);
        const upserts = netInput.bodyDelta.upserts;
        for (let i = 0; i < upserts.length; ++i) {
            const body = (0, id_1.getById)(netState.bodies, upserts[i].id);
            if (body && !(body.flags & physics_schema_1.RigidBodyFlags.ANIMATED)) {
                body.flags |= physics_schema_1.RigidBodyFlags.LOCKED;
            }
        }
    }
    // copy input data from clients into player structure
    clearNetTargets();
    if (netInput.clients.length === 1) {
        const playerInput = (0, id_1.getById)(netState.playerInputs, netInput.clients[0].id);
        if (playerInput) {
            handlePlayerInput(netInput.clients[0], playerInput);
        }
    }
    else if (netInput.clients.length > 1) {
        // 每一个有输入的客户端都算一遍
        (0, id_1.zipId)(handlePlayerInput, netInput.clients, netState.playerInputs);
    }
    dropFarPeerTargets(netState.bodies);
    // 相同ID按比例合并数据（自己的权威校正不会被同伴包抢走）
    coallesceTargets();
    // apply player input forces
    (0, player_move_1.applyPlayerInputForces)(netState.bodies, netState.players, netState.playerInputs, 1, netState.physics.velocityDamping, netState.physics.gravity);
    const iterCount = netState.physics.useOBB ? 4 : 1;
    if (NET_TARGETS.length > 0) {
        // first compute predicted positions
        const predictedBodies = physics_schema_1.RigidBodySetSchema.clone(netState.bodies);
        // solve(netState.physics, predictedBodies, 1, collision, false);
        for (let i = 0; i < iterCount; i++) {
            (0, physics_solve_1.solvePhysics)(netState.physics, predictedBodies, 1 / iterCount, blockIndex, collision, netState.collisionFilter, zoneIndex);
        }
        // using predicted positions we then compute a minimal virtual force to move objects to target states
        applyPositionCorrection(NET_TARGETS, netState.bodies, predictedBodies);
        // do an actual solve now to get the body states using virtual forces
        // solve(netState.physics, netState.bodies, 1, collision, true, contact);
        for (let i = 0; i < iterCount; i++) {
            (0, physics_solve_1.solvePhysics)(netState.physics, netState.bodies, 1 / iterCount, blockIndex, collision, netState.collisionFilter, zoneIndex);
        }
        // apply velocity correction factor
        applyVelocityCorrection(NET_TARGETS, netState.bodies);
        // release predicted body states
        physics_schema_1.RigidBodySetSchema.free(predictedBodies);
    }
    else {
        for (let i = 0; i < iterCount; i++) {
            (0, physics_solve_1.solvePhysics)(netState.physics, netState.bodies, 1 / iterCount, blockIndex, collision, netState.collisionFilter, zoneIndex);
        }
    }
    // update lock set
    if (updateLocks) {
        (0, physics_solve_1.propagateLocks)(netState.physics, true);
    }
    if (fullContact) {
        (0, physics_solve_1.extractContactIndex)(netState.physics, netState.bodies, contact);
    }
    else {
        (0, physics_solve_1.extractContactIndex)(netState.physics, netState.players, contact);
    }
    // update player flags
    const bodyBush = (0, physics_solve_1.rebuildBodyTree)(netState.bodies);
    (0, player_move_1.updatePlayerPhysics)(blockIndex, netState.players, netState.playerInputs, contact, netState.bodies, collision, bodyBush);
    // snap net state to serialized form
    return netState;
}
// merge input from a client
function mergeNetInput(input, id, clientInput, allowBodyUpdates) {
    const clients = input.clients;
    const idx = (0, id_1.indexPred)(clients, id);
    // check search
    let entry;
    if (0 <= idx && idx < clients.length && clients[idx].id === id) {
        entry = clients[idx];
    }
    else {
        entry = net_schema_1.TaggedNetClientInputSchema.alloc();
        entry.id = id;
        clients.splice(idx + 1, 0, entry);
    }
    if (allowBodyUpdates) {
        net_schema_1.NetClientInputSchema.assign(entry.input, clientInput);
    }
    else {
        entry.input.inputAngle = clientInput.inputAngle;
        entry.input.inputState = clientInput.inputState;
        entry.input.inputPitch = clientInput.inputPitch;
        entry.input.inputCameraAngle = clientInput.inputCameraAngle;
        entry.input.bodies.length = 0;
    }
}
//# sourceMappingURL=net-tick.js.map