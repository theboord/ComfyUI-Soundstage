// three-avbd/advanced: below the World, for custom compute passes over the bodies (World.solver,
// its buffers and parameters) and the layout of the body and joint records. No stability
// promise while the package is 0.x.
export { GpuSolver3D, gpuParams3D, REF_UP } from "../avbd3d/gpu/solver.mjs";
// What a GpuSolver3D is built from: a reference solver holding the starting bodies (z-up, as the
// paper's demo: set params.up after for y), and its bodies (boxes; spheres through `sphere`)
export { Solver } from "../avbd3d/ref/solver.mjs";
export { Rigid } from "../avbd3d/ref/body.mjs";
export { sphere, hull } from "../avbd3d/shapes.mjs";
// Hull shapes for `hull` bodies (convexHull is also on the main entry)
export { convexHull, hullFromTriangles, MAX_HULL_VERTICES } from "../avbd3d/hull.mjs";
// A joint record read back (GpuSolver3D.readJoints) decoded: the forces it carries, whether it
// broke, the rest it holds and how far it has bent
export { decodeJoint } from "../avbd3d/gpu/joints.mjs";
export { BODY_FLOATS, B_POS, B_ROT, B_SIZE, B_VEL, B_ANGVEL, B_MOMENT, 
// Joint records: JOINT_FLOATS (40 since 0.3, 32 before) strides the buffer, and these are field
// offsets in it, each field documented in layout.ts
JOINT_FLOATS, J_PEN_LIN, J_PEN_ANG, J_LAM_LIN, J_LAM_ANG, J_RA, J_RB, J_REST, J_REST_START, J_YIELD, J_BREAK_BEND, } from "../avbd3d/gpu/layout.mjs";
// The contact and manifold records and the solver counters a GpuSolver3D reads back
// (readContactList and readCounters decode them; these are for reading the raw buffers in your
// own readback or compute pass): record strides and field offsets, in 32-bit words
export { CONTACT_WORDS, K_RA, K_RB, K_PEN, K_LAM, STICK_BIT, MANIFOLD_WORDS, M_IDS, M_GEO, C_MANIFOLDS, C_PREV_MANIFOLDS } from "../avbd3d/gpu/layout.mjs";
export { C_PAIRS, C_CONTACTS, C_PREV_CONTACTS, C_OVERFLOW, C_CLASHES, C_NUM_COLORS, COUNTER_WORDS, NO_COLOR } from "../avbd2d/gpu/layout.mjs";
