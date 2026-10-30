// The demo host doesn't serve .glb files, so the models ship as base64 text; turn them back into binary on fetch.
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input?.url || String(input);
  if (/\.glb(\?|$)/.test(url)) {
    const r = await realFetch(url.replace(/\.glb(\?|$)/, ".glb.b64.txt$1"), init);
    if (!r.ok) return r;
    const bin = Uint8Array.from(atob((await r.text()).replace(/\s+/g, "")), (c) => c.charCodeAt(0));
    return new Response(bin, { status: 200, headers: { "Content-Type": "model/gltf-binary" } });
  }
  return realFetch(input, init);
};
