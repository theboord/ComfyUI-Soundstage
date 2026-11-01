// Live depth of field for the phone viewfinder: render the stage into a target with a depth texture, then one gather pass
// (a golden-angle spiral, after Dennis Gustafsson's single-pass bokeh) blurs each pixel by its thin-lens circle of
// confusion. Light enough for a phone: ~60 taps at most, at the viewfinder's own resolution. three.js is passed in so
// this module shares the stage's instance.
//
//   const dof = createDof(THREE, renderer);
//   dof.begin(w, h);                    // the next renders land in the depth-of-field target
//   ...stage renders...
//   dof.end({ camera, K, focus, maxPx }); // composite to the screen. K = vfcore.cocScale(...) in screen pixels

export function createDof(THREE, renderer) {
  let rt = null;
  const make = (w, h) => {
    rt?.dispose();
    const depth = new THREE.DepthTexture(w, h);
    depth.type = THREE.UnsignedIntType;
    rt = new THREE.WebGLRenderTarget(w, h, { depthTexture: depth, depthBuffer: true, stencilBuffer: true });
    rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
    rt.depthTexture.format = THREE.DepthStencilFormat;
    rt.depthTexture.type = THREE.UnsignedInt248Type;
  };
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      tColor: { value: null }, tDepth: { value: null }, texel: { value: new THREE.Vector2() },
      near: { value: 0.1 }, far: { value: 200 }, focus: { value: 3 }, K: { value: 0 }, maxR: { value: 16 }, radScale: { value: 1 },
    },
    vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
    fragmentShader: `
      uniform sampler2D tColor; uniform sampler2D tDepth; uniform vec2 texel;
      uniform float near; uniform float far; uniform float focus; uniform float K; uniform float maxR; uniform float radScale;
      varying vec2 vUv;
      const float GOLDEN = 2.39996323;
      float dist(vec2 uv) { float z = texture2D(tDepth, uv).x * 2.0 - 1.0; return 2.0 * near * far / (far + near - z * (far - near)); }
      float coc(float d) { return min(maxR, K * abs(d - focus) / max(d, 1e-3)); }
      void main() {
        float d0 = dist(vUv); float c0 = coc(d0);
        vec3 col = texture2D(tColor, vUv).rgb; float tot = 1.0;
        if (maxR > 0.5 && K > 0.0) {
          float r = radScale; float ang = 0.0;
          for (int i = 0; i < 64; i++) {
            if (r >= maxR) break;
            vec2 tc = vUv + vec2(cos(ang), sin(ang)) * texel * r;
            vec3 sc = texture2D(tColor, tc).rgb; float sd = dist(tc); float cs = coc(sd);
            if (sd > d0) cs = clamp(cs, 0.0, c0 * 2.0);          // a sharp subject doesn't smear onto the blurred background
            float m = smoothstep(r - 0.5, r + 0.5, cs);
            col += mix(col / tot, sc, m); tot += 1.0;
            ang += GOLDEN; r += radScale / r;
          }
        }
        gl_FragColor = vec4(col / tot, 1.0);
        #include <colorspace_fragment>
      }`,
    depthTest: false, depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  return {
    get target() { return rt; },
    begin(w, h) {
      if (!rt || rt.width !== w || rt.height !== h) make(w, h);
      renderer.setRenderTarget(rt);
    },
    end({ camera, K, focus, maxPx = 16 }) {
      renderer.setRenderTarget(null);
      const u = mat.uniforms;
      u.tColor.value = rt.texture; u.tDepth.value = rt.depthTexture;
      u.texel.value.set(1 / rt.width, 1 / rt.height);
      u.near.value = camera.near; u.far.value = camera.far; u.focus.value = focus; u.K.value = K;
      u.maxR.value = maxPx;
      // ~56 taps reach the largest blur: r_n^2 ~ 2 n s
      u.radScale.value = Math.max(0.6, (maxPx * maxPx) / (2 * 56));
      const ac = renderer.autoClear;
      renderer.autoClear = false;
      renderer.render(scene, cam);
      renderer.autoClear = ac;
    },
    dispose() { rt?.dispose(); mat.dispose(); quad.geometry.dispose(); },
  };
}
