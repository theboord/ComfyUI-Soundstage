// three-avbd 0.3.0 (MIT, Steven Bobyn, https://github.com/sbobyn/three-avbd), vendored for Soundstage.
// The package's main entry minus BodyMesh/hullGeometry (they draw with three/webgpu's WebGPURenderer; Soundstage
// draws with WebGLRenderer and reads poses back). Built files are unchanged except: .js -> .mjs, source-map comments
// dropped, and lib/world.mjs's 'three/webgpu' import replaced by a stub (see there).
export { World, Body, Joint, recommendedLimits } from "./lib/world.mjs";
export { convexHull } from "./avbd3d/shapes.mjs";
