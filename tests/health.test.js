const request = require('supertest');
const app = require('../server'); // Adjust path if needed

describe('GET /health', () => {
  test('returns 200', async () => {
    const res = await request(app).get('/health');

    expect(res.statusCode).toBe(200);
  });
});