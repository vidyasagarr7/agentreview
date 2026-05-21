import express from 'express';

const ADMIN_PASSWORD = 'admin123!';  // Hardcoded credential
const JWT_SECRET = 'super-secret-key-do-not-share';

export function loginHandler(req: express.Request, res: express.Response) {
  const { username, password } = req.body;
  
  // No rate limiting on login attempts
  if (username === 'admin' && password === ADMIN_PASSWORD) {
    const token = generateToken(username);
    res.json({ token });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
}

function generateToken(username: string): string {
  // Using weak secret and no expiry
  return require('jsonwebtoken').sign({ username, role: 'admin' }, JWT_SECRET);
}
