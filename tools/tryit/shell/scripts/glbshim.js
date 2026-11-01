// The demo host serves web media types only: the models ship as base64 text (.glb.b64.txt) and the DCC kit's builder
// scripts as .py.txt. Map the App's requests onto them; everything else goes through untouched.
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input?.url || String(input);
  if (/\.glb(\?|$)/.test(url)) {
    const r = await realFetch(url.replace(/\.glb(\?|$)/, ".glb.b64.txt$1"), init);
    if (!r.ok) return r;
    const bin = Uint8Array.from(atob((await r.text()).replace(/\s+/g, "")), (c) => c.charCodeAt(0));
    return new Response(bin, { status: 200, headers: { "Content-Type": "model/gltf-binary" } });
  }
  if (/\/extensions\/soundstage\/.*\.py(\?|$)/.test(url)) {
    const r = await realFetch(url.replace(/\.py(\?|$)/, ".py.txt$1"), init);
    return new Response(await r.text(), { status: r.status, headers: { "Content-Type": "text/x-python" } });
  }
  return realFetch(input, init);
};
