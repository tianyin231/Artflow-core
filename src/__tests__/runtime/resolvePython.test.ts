/**
 * Unit tests for resolvePython fallback chain.
 */
import { resolvePython } from '../../runtime/resolvePython';

describe('resolvePython', () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it('prefers ARTFLOW_PYTHON when it probes successfully', () => {
    process.env.ARTFLOW_PYTHON = '/fake/venv/bin/python';
    const probed: string[] = [];
    const bin = resolvePython({
      probe: (b) => {
        probed.push(b);
        return b === '/fake/venv/bin/python';
      },
    });
    expect(bin).toBe('/fake/venv/bin/python');
    expect(probed[0]).toBe('/fake/venv/bin/python');
  });

  it('falls back to configured runtime.python when env is unset', () => {
    delete process.env.ARTFLOW_PYTHON;
    const bin = resolvePython({
      configured: '/opt/python3',
      probe: (b) => b === '/opt/python3',
    });
    expect(bin).toBe('/opt/python3');
  });

  it('falls back to python3 when earlier candidates fail', () => {
    delete process.env.ARTFLOW_PYTHON;
    const bin = resolvePython({
      probe: (b) => b === 'python3',
    });
    expect(bin).toBe('python3');
  });

  it('falls back to python last', () => {
    delete process.env.ARTFLOW_PYTHON;
    const bin = resolvePython({
      probe: (b) => b === 'python',
    });
    expect(bin).toBe('python');
  });

  it('throws when nothing probes successfully', () => {
    delete process.env.ARTFLOW_PYTHON;
    expect(() => resolvePython({ probe: () => false })).toThrow(/Unable to resolve/);
  });
});
