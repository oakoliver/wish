const shim = new URL('./bun-test-shim.mjs', import.meta.url).href;
const srcDir = new URL('../../src/', import.meta.url).href;
const distDir = new URL('../../dist/', import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === 'bun:test') return { url: shim, shortCircuit: true };
  const resolved = await next(specifier, context);
  if (resolved.url.startsWith(srcDir) && resolved.url.endsWith('.ts')) {
    return { ...resolved, url: distDir + resolved.url.slice(srcDir.length, -3) + '.js', format: 'module' };
  }
  return resolved;
}
