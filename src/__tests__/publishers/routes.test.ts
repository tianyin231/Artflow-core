import express from 'express';
import request from 'supertest';
import publishersRoutes from '../../webui/routes/publishers';

jest.mock('../../config', () => ({
  getConfigPath: () => 'fixture-config.json',
  loadConfig: () => ({}),
}));

describe('publisher dry-run routes', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/publishers', publishersRoutes);

  it('preserves platform-specific options needed to validate a Bilibili package', async () => {
    const response = await request(app).post('/api/publishers/bilibili/dry-run').send({
      title: 'Fixture video', tags: ['Anime'], extras: { tid: 17 },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('dry_run');
  });

  it('still reports missing required platform-specific options', async () => {
    const response = await request(app).post('/api/publishers/bilibili/dry-run').send({
      title: 'Fixture video', tags: ['Anime'],
    });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('failed');
    expect(response.body.data.message).toContain('extras.tid');
  });

  it.each([null, [], 'invalid'])('rejects malformed extras: %p', async (extras) => {
    const response = await request(app).post('/api/publishers/bilibili/dry-run').send({ extras });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('extras must be an object');
  });

  it('keeps optional extras optional for local export', async () => {
    const response = await request(app).post('/api/publishers/local-export/dry-run').send({});

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('dry_run');
  });
});
