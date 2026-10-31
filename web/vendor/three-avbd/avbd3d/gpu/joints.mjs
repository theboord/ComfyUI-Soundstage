// Reading a joint back: what GpuSolver3D.readJoints returns is the raw joint buffer, JOINT_FLOATS
// per slot (layout.ts says what each field holds). This decodes one slot's record into what
// users ask of it: how hard the joint is working, whether it has broken, how it has bent.
import { qangle } from "../ref/math.mjs";
import { J_LAM_ANG, J_LAM_LIN, J_PEN_ANG, J_PEN_LIN, J_REST, J_REST_START, JOINT_FLOATS } from "./layout.mjs";
/** How far the joint in slot `slot` of a `readJoints()` result has bent (rad): see JointState.bend. */
export function jointBend(joints, slot) {
    const o = slot * JOINT_FLOATS;
    return qangle(joints, joints, o + J_REST_START, o + J_REST);
}
/**
 * Slot `slot` of a `readJoints()` result as a JointState (written into `into`, if given: decoding
 * a whole readback allocates nothing that way).
 */
export function decodeJoint(joints, slot, into) {
    const o = slot * JOINT_FLOATS;
    const state = into ?? { linear: 0, angular: 0, broken: false, rest: [0, 0, 0, 1], bend: 0 };
    state.linear = Math.hypot(joints[o + J_LAM_LIN], joints[o + J_LAM_LIN + 1], joints[o + J_LAM_LIN + 2]);
    state.angular = Math.hypot(joints[o + J_LAM_ANG], joints[o + J_LAM_ANG + 1], joints[o + J_LAM_ANG + 2]);
    state.broken = joints[o + J_PEN_LIN + 3] === 0 && joints[o + J_PEN_ANG + 3] === 0;
    for (let i = 0; i < 4; i++)
        state.rest[i] = joints[o + J_REST + i];
    state.bend = jointBend(joints, slot);
    return state;
}
