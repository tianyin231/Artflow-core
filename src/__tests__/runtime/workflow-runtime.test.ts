import * as config from '../../config';
import * as python from '../../runtime/resolvePython';
import { WorkflowManager } from '../../workflow/WorkflowManager';
import { FileService } from '../../download/FileService';

describe('workflow runtime configuration', () => {
  afterEach(() => jest.restoreAllMocks());

  it('passes the configured interpreter to image inspection', async () => {
    jest.spyOn(config, 'loadConfig').mockReturnValue({ runtime: { python: '/custom/python' } } as config.StandaloneConfig);
    const resolve = jest.spyOn(python, 'resolvePython').mockImplementation(() => { throw new Error('stop before spawn'); });
    const manager = new WorkflowManager() as unknown as { identifyImage(path: string): Promise<unknown> };
    await expect(manager.identifyImage('image.png')).rejects.toThrow('stop before spawn');
    expect(resolve).toHaveBeenCalledWith({ configured: '/custom/python' });
  });

  it('organizes dates in the configured timezone', () => {
    const service = new FileService({}, 'America/Los_Angeles');
    expect(service.getOrganizedDirectory('/images', 'byDay', { date: new Date('2026-10-02T00:00:00Z') }))
      .toContain('2026-10-01');
  });
});
