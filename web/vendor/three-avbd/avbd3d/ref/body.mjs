// Rigid body and force base, ported from avbd-demo3d (solver.h, rigid.cpp, force.cpp).
// As in the 2D port, the C++ intrusive linked lists (head insertion, newest first) become
// arrays in creation order that the solver walks in reverse where order affects the result.
import { length, mat3, quat, vec3 } from "./math.mjs";
export const PENALTY_MIN = 1.0; // Minimum penalty parameter
export const PENALTY_MAX = 10000000000.0; // Maximum penalty parameter
export const COLLISION_MARGIN = 0.01; // Margin to avoid flickering contacts
export const STICK_THRESH = 0.00001; // Position threshold for sticking contacts (static friction)
export class Rigid {
    solver;
    forces = [];
    positionLin;
    positionAng = quat();
    initialLin = vec3();
    initialAng = quat();
    inertialLin = vec3();
    inertialAng = quat();
    velocityLin;
    velocityAng = vec3();
    prevVelocityLin;
    /** Full widths along each local axis. */
    size;
    mass;
    moment;
    friction;
    radius;
    constructor(solver, size, density, friction, position, velocity = [0, 0, 0]) {
        this.solver = solver;
        this.size = vec3(size[0], size[1], size[2]);
        this.friction = friction;
        this.positionLin = vec3(position[0], position[1], position[2]);
        this.velocityLin = vec3(velocity[0], velocity[1], velocity[2]);
        this.prevVelocityLin = vec3(velocity[0], velocity[1], velocity[2]);
        // Mass properties and bounding radius
        const [sx, sy, sz] = this.size;
        this.mass = sx * sy * sz * density;
        this.moment = vec3(((sy * sy + sz * sz) / 12) * this.mass, ((sx * sx + sz * sz) / 12) * this.mass, ((sx * sx + sy * sy) / 12) * this.mass);
        this.radius = length([sx * 0.5, sy * 0.5, sz * 0.5]);
        solver.bodies.push(this);
    }
    constrainedTo(other) {
        for (const f of this.forces) {
            if ((f.bodyA === this && f.bodyB === other) || (f.bodyA === other && f.bodyB === this))
                return true;
        }
        return false;
    }
}
export const bodySystem = () => ({ lhsLin: mat3(), lhsAng: mat3(), lhsCross: mat3(), rhsLin: vec3(), rhsAng: vec3() });
/** Common interface for all forces. When bodyA is null the force attaches bodyB to the world. */
export class Force {
    solver;
    bodyA;
    bodyB;
    constructor(solver, bodyA, bodyB) {
        this.solver = solver;
        this.bodyA = bodyA;
        this.bodyB = bodyB;
        solver.forces.push(this);
        bodyA?.forces.push(this);
        bodyB.forces.push(this);
    }
    /** Unlink from the solver and both bodies (the C++ destructor). */
    destroy() {
        const list = this.solver.forces;
        const i = list.indexOf(this);
        if (i >= 0)
            list.splice(i, 1);
        this.unlinkFromBodies();
    }
    /** Unlink from the bodies only; used when the solver rebuilds its own list in bulk. */
    unlinkFromBodies() {
        for (const body of [this.bodyA, this.bodyB]) {
            if (!body)
                continue;
            const i = body.forces.indexOf(this);
            if (i >= 0)
                body.forces.splice(i, 1);
        }
    }
}
