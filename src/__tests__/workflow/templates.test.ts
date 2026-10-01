import {
  validateTemplate,
  applyVars,
  compile,
  roundTrip,
  BUILTIN_TEMPLATES,
} from '../../workflow/templates';

describe('workflow templates', () => {
  it('validates built-in templates', () => {
    expect(BUILTIN_TEMPLATES.length).toBeGreaterThanOrEqual(8);
    for (const t of BUILTIN_TEMPLATES) {
      expect(validateTemplate(t).errors).toEqual([]);
    }
  });

  it('detects cycles', () => {
    const bad = {
      version: 'workflow-template.v1' as const,
      id: 'x',
      name: 'x',
      nodes: [
        { id: 'a', kind: 'source' as const },
        { id: 'b', kind: 'render' as const },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
      ],
    };
    expect(validateTemplate(bad).ok).toBe(false);
  });

  it('substitutes variables', () => {
    const t = BUILTIN_TEMPLATES.find((x) => x.id === 'xhs-portrait')!;
    const f = applyVars(t, { tag: '鳴潮' });
    expect(JSON.stringify(f)).toContain('鳴潮');
  });

  it('compiles to topological order', () => {
    const t = BUILTIN_TEMPLATES[0];
    const { order, errors } = compile(t);
    expect(errors).toEqual([]);
    expect(order[0]).toBe('src');
    expect(order[order.length - 1]).toBe('pub');
  });

  it('round-trips JSON', () => {
    const t = BUILTIN_TEMPLATES[2];
    expect(roundTrip(t)).toEqual(t);
  });

  it('all built-ins dry-compile', () => {
    for (const t of BUILTIN_TEMPLATES) {
      const { errors } = compile(t, { tag: 'x', min: '10' });
      expect(errors).toEqual([]);
    }
  });
});
