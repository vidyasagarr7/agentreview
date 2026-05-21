import { Router } from 'express';
import { db } from '../config/database';

const router = Router();

// SQL injection via string concatenation
router.get('/users', async (req, res) => {
  const search = req.query.search;
  const query = `SELECT * FROM users WHERE name LIKE '%${search}%'`;  // SQL injection!
  const results = await db.query(query);
  res.json(results);
});

// Path traversal
router.get('/files/:filename', (req, res) => {
  const filepath = `./uploads/${req.params.filename}`;  // Path traversal!
  res.sendFile(filepath);
});

// Command injection
router.post('/ping', (req, res) => {
  const host = req.body.host;
  require('child_process').exec(`ping -c 1 ${host}`, (err: any, stdout: string) => {
    res.json({ output: stdout });
  });
});

export default router;
