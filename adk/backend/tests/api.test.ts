import request from 'supertest';
import { app } from '../src/app';

describe('POST /api/review', () => {
  it('should return 400 if url is missing', async () => {
    const response = await request(app)
      .post('/api/review')
      .send({ pat: 'mock-pat' });
    
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('GitHub PR URL and PAT are required.');
  });

  it('should return 400 if pat is missing', async () => {
    const response = await request(app)
      .post('/api/review')
      .send({ url: 'https://github.com/owner/repo/pull/1' });
    
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('GitHub PR URL and PAT are required.');
  });
});
