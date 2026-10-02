import {
  PUBLISH_ERROR_MESSAGES,
  humanizePublishError,
} from '../../publishers/error-messages';

describe('publish error messages', () => {
  it('maps known codes', () => {
    expect(humanizePublishError('QUOTA_EXCEEDED')).toContain('配额');
    expect(humanizePublishError('2190005')).toContain('128MB');
    expect(humanizePublishError('2114006')).toContain('15 分钟');
    expect(humanizePublishError('DOUYIN_PERSONAL_UNSUPPORTED')).toContain('企业');
    expect(humanizePublishError('XHS_MANUAL_ONLY')).toContain('人工上传');
  });

  it('falls back to raw message', () => {
    expect(humanizePublishError('something odd')).toBe('something odd');
  });

  it('table has no secrets', () => {
    const blob = JSON.stringify(PUBLISH_ERROR_MESSAGES);
    // no literal credential-looking values
    expect(blob).not.toMatch(/Bearer\s+\S+/i);
    expect(blob).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    expect(blob).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
  });
});
