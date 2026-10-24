let facade;

export function initialize(data) {
  facade = data.facade;
}

export function resolve(specifier, context, nextResolve) {
  if (['electron', 'electron/main', 'electron/common', 'electron/renderer'].includes(specifier)) {
    return { url: facade, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
