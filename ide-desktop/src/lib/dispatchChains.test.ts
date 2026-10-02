import { describe, expect, it } from 'vitest';
import { normalizeChains, toggleChain, selectedModels, toggleSelectedModel } from './dispatchChains';

const A = 'vendor-1/model-a';
const B = 'vendor-2/model-b';

describe('toggleChain', () => {
  it('adds a model to the chain, appending so click order is kept', () => {
    const one = toggleChain({}, 'expensive', A);
    expect(one.expensive).toEqual([A]);
    const two = toggleChain(one, 'expensive', B);
    expect(two.expensive).toEqual([A, B]);
  });

  it('removes the model when it is already in that tier', () => {
    // Regression: the badge used to send '' to mean "remove", which the
    // helper treated as a no-op, so clicking an active badge did nothing.
    const chains = { expensive: [A, B] };
    expect(toggleChain(chains, 'expensive', A).expensive).toEqual([B]);
  });

  it('keeps a model in other tiers when toggled in one', () => {
    const both = toggleChain(toggleChain({}, 'expensive', A), 'standard', A);
    expect(both.expensive).toEqual([A]);
    expect(both.standard).toEqual([A]);
    expect(toggleChain(both, 'expensive', A).standard).toEqual([A]);
  });
});

describe('normalizeChains', () => {
  it('accepts the older single-string form', () => {
    expect(normalizeChains({ expensive: 'vendor/model' })).toEqual({
      expensive: ['vendor/model'],
    });
  });

  it('drops empty entries and duplicates', () => {
    expect(normalizeChains({ cheap: [A, '', A, B] })).toEqual({ cheap: [A, B] });
  });

  it('ignores unknown tier ids and empty input', () => {
    expect(normalizeChains(undefined)).toEqual({});
    expect(normalizeChains({ nonsense: [A] } as never)).toEqual({});
  });
});

describe('selectedModels / toggleSelectedModel', () => {
  it('reports every model in the dispatch set, once', () => {
    expect(selectedModels({ expensive: [A], standard: [A, B], cheap: [B] }).sort())
      .toEqual([A, B].sort());
  });

  it('checks a model on first toggle and off on the second', () => {
    const on = toggleSelectedModel({}, A);
    expect(selectedModels(on)).toEqual([A]);

    const off = toggleSelectedModel(on, A);
    expect(selectedModels(off)).toEqual([]);
  });

  it('unticking removes the model from every tier at once', () => {
    // A model can sit in several tiers; unticking must not leave it behind in
    // one of them, which would make the checkbox lie about its own state.
    const chains = { expensive: [A], standard: [A], cheap: [A, B] };
    const after = toggleSelectedModel(chains, A);
    expect(selectedModels(after)).toEqual([B]);
    expect(after.expensive).toBeUndefined();
    expect(after.standard).toBeUndefined();
    expect(after.cheap).toEqual([B]);
  });

  it('keeps several models checked at the same time', () => {
    let chains = toggleSelectedModel({}, A);
    chains = toggleSelectedModel(chains, B);
    expect(selectedModels(chains).sort()).toEqual([A, B].sort());
  });
});

